# Operations and release runbook

This runbook separates local work from remote Cloudflare changes. Commands that
create resources, set secrets, apply remote migrations, or deploy are production
writes and require an authorized operator.

## Local setup

1. Install Node.js 24 and pnpm 11.20.0.
2. Install the locked dependency graph:

   ```powershell
   pnpm install --frozen-lockfile
   ```

3. Create ignored local environment files:

   ```powershell
   Copy-Item apps/backend/.dev.vars.example apps/backend/.dev.vars
   Copy-Item apps/frontend/.env.example apps/frontend/.env.local
   ```

4. Generate three independent 32-byte base64url values and place them in
   `TOKEN_ENCRYPTION_KEY`, `MEDIA_LEASE_SECRET`, and `AUDIT_HASH_SECRET`. One way
   to generate one value locally is:

   ```powershell
   node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
   ```

   Run it separately for each secret. Never commit `.dev.vars`, reuse values
   between purposes, or paste secrets into tickets/logs.

5. Leave provider credentials blank unless testing that provider with an approved
   development account. Local upload mode is `worker_proxy`, so local R2 S3
   credentials are not required.
6. Prepare local state and run:

   ```powershell
   pnpm types:generate
   pnpm migrate:local
   pnpm dev
   ```

7. Confirm `GET http://localhost:4000/health` and
   `GET http://localhost:4000/api/config`, then use the UI at
   `http://localhost:3000`.

## Configuration inventory

### Non-secret Worker variables

| Variable             | Operational meaning                                                            |
| -------------------- | ------------------------------------------------------------------------------ |
| `APP_ENV`            | Development or production behavior                                             |
| `APP_ORIGINS`        | Exact comma-separated browser origins allowed to use credentialed API requests |
| `PUBLIC_APP_ORIGIN`  | Browser redirect target after OAuth                                            |
| `PUBLIC_API_ORIGIN`  | Canonical API origin used to construct OAuth callbacks                         |
| `ALLOW_SIGNUPS`      | Public registration gate                                                       |
| `UPLOAD_MODE`        | `worker_proxy` locally, `direct` in production                                 |
| `R2_BUCKET_NAME`     | Bucket name used when signing direct R2 requests                               |
| `META_GRAPH_VERSION` | Graph API version used by Meta calls                                           |
| `*_CAPABILITY`       | Server-enforced provider availability/review mode                              |

The production `app.example.com` and `api.example.com` values in
`apps/backend/wrangler.jsonc`, and the matching origin in
`apps/backend/r2-cors.example.json`, are placeholders. Replace them with the
customer's exact origins before any production deployment. Origins must include
scheme and host, with no path or trailing slash.

### Secret Worker variables

| Secret                                                      | When required                                             |
| ----------------------------------------------------------- | --------------------------------------------------------- |
| `TOKEN_ENCRYPTION_KEY`                                      | Always; encrypts provider credentials and resumable state |
| `MEDIA_LEASE_SECRET`                                        | Always; signs short-lived private-media leases            |
| `AUDIT_HASH_SECRET`                                         | Always; keyed hashing for security/audit identifiers      |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | Production `direct` upload signing                        |
| `META_APP_ID`, `META_APP_SECRET`                            | Facebook Pages when enabled                               |
| `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`                  | Instagram when enabled                                    |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`                  | YouTube when enabled                                      |

TikTok and webhook secrets are reserved but not v1 requirements. Keep them unset.
Changing `TOKEN_ENCRYPTION_KEY` without a credential re-encryption plan makes
stored provider connections unreadable. Treat key rotation as a dedicated change.

### Bindings and resources

| Binding                     | Development name   | Production name               |
| --------------------------- | ------------------ | ----------------------------- |
| D1 `DB`                     | `vidrelay`         | `vidrelay-production`         |
| R2 `MEDIA`                  | `vidrelay-media`   | `vidrelay-media-production`   |
| Workflow `PUBLISH_WORKFLOW` | `vidrelay-publish` | `vidrelay-publish-production` |

`apps/backend/wrangler.jsonc` currently names the D1 databases but does not contain
their account-specific `database_id` values. Provision/select the databases and
record the returned IDs in the appropriate Wrangler entries before deployment.
Do not reuse a test database or bucket for production.

Whenever Wrangler bindings change, run `pnpm types:generate`, inspect the generated
binding type, and include it in the normal verification pass.

## One-time Cloudflare setup

Use an authenticated Wrangler session for the intended Cloudflare account. From
`apps/backend`, an authorized operator may create the named resources if they do
not already exist:

```powershell
pnpm exec wrangler d1 create vidrelay-production
pnpm exec wrangler r2 bucket create vidrelay-media-production
```

Capture the D1 database ID in `wrangler.jsonc`. Keep R2 private. Create an
R2 API token limited to object read/write for the production media bucket and put
its access-key credentials into Worker secrets; do not expose them to the browser.

Set each secret through Wrangler's interactive prompt, never a shell argument or
committed file:

```powershell
pnpm exec wrangler secret put TOKEN_ENCRYPTION_KEY --env production
pnpm exec wrangler secret put MEDIA_LEASE_SECRET --env production
pnpm exec wrangler secret put AUDIT_HASH_SECRET --env production
pnpm exec wrangler secret put R2_ACCOUNT_ID --env production
pnpm exec wrangler secret put R2_ACCESS_KEY_ID --env production
pnpm exec wrangler secret put R2_SECRET_ACCESS_KEY --env production
```

Add only the three provider secret pairs approved for the v1 deployment. Follow
[the provider runbook](PROVIDERS.md) before enabling a capability.

Ensure the Cloudflare Pages project expected by the frontend deploy script is
named `vidrelay`, or deliberately update the deployment configuration before
release. The static frontend build must receive the production API origin as
`NEXT_PUBLIC_API_URL`; a localhost value will otherwise be compiled into `out`.

## R2 browser CORS

Direct presigned uploads go from the browser to R2, so Worker CORS alone is not
enough. Copy `apps/backend/r2-cors.example.json`, replace the placeholder with the
exact production app origin, review it, and apply it to the production bucket:

```powershell
Set-Location apps/backend
Copy-Item r2-cors.example.json r2-cors.production.json
# Edit and review r2-cors.production.json before the remote command.
pnpm exec wrangler r2 bucket cors set vidrelay-media-production --file r2-cors.production.json
pnpm exec wrangler r2 bucket cors list vidrelay-media-production
Set-Location ../..
```

The rule should allow only the app origin, `PUT`, and `Content-Type`, expose
`ETag`, and retain the bucket's private access. Add the generated production CORS
file to the operator's secure deployment material; do not commit customer domains
if this repository is used as a template.

Reference: [Cloudflare R2 CORS](https://developers.cloudflare.com/r2/buckets/cors/).

## Database migrations

Migration SQL lives in `apps/backend/migrations` and is generated from
`apps/backend/src/db/schema.ts` through Drizzle.

1. For a schema change, run `pnpm generate` and inspect every generated statement.
2. Apply it locally with `pnpm migrate:local` and run the full verification suite.
3. Before a production migration, record the target database/account, inspect the
   pending migration list, create the appropriate D1 backup/export, and obtain
   release approval.
4. Apply exactly once with `pnpm migrate:remote`.
5. Verify the applied migration list and the health/config endpoints before
   deploying code that requires the new schema.

Do not edit generated migration SQL casually, delete migration history, or assume
that rolling back Worker code rolls back D1. Prefer a reviewed forward migration
when production data has advanced.

Reference: [Cloudflare D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/).

## Verification

Run the repository gate from the root:

```powershell
pnpm check
```

It must pass formatting, ESLint, TypeScript/Workers binding checks, Vitest, Fallow,
and both builds. A dry-run Worker build is not a production deployment.

Before enabling a provider or releasing:

- inspect `GET /api/config` and confirm every configured/mode pair matches the
  actual provider console;
- register/login/logout and verify cross-origin session and CSRF behavior;
- connect and disconnect an approved test account for each enabled platform;
- upload a known-good common-profile MP4 through the production direct-upload path;
- submit one destination at a time, then a three-destination post;
- confirm provider-specific visibility/metadata, status polling, history, and
  partial failure behavior;
- repeat a submission with the same idempotency key and confirm no duplicate;
- test a safe retry and the reconciliation-required operator path without blindly
  republishing; and
- exercise account deletion only with a disposable non-production account, then
  verify D1/R2 cleanup and the opaque deletion status reference.

## Production release

1. Freeze the reviewed revision and record the release owner.
2. Confirm provider approvals and set capability modes conservatively. TikTok must
   be disabled for v1.
3. Replace all placeholder origins; confirm D1 IDs, R2/Workflow bindings, scheduled
   trigger, observability, Pages project, and production secrets.
4. Apply and verify R2 CORS.
5. Run `pnpm check` from a clean dependency install.
6. Back up D1, then apply approved remote migrations with `pnpm migrate:remote`.
7. Deploy the backend with `pnpm deploy:backend`.
8. Verify the API health/config endpoints and inspect Worker logs.
9. Build the static frontend with the production `NEXT_PUBLIC_API_URL`, then run
   `pnpm deploy:frontend`.
10. Execute the production smoke path with designated low-risk provider accounts.
11. Record revision, migration list, Worker/Pages deployment identifiers, config
    modes, test results, operator, and time.

The frontend is a static Pages export. See Cloudflare's
[static Next.js Pages guide](https://developers.cloudflare.com/pages/framework-guides/nextjs/deploy-a-static-nextjs-site/).

## Monitoring and incident response

- Use request IDs and structured Worker logs; never add raw tokens, cookies,
  presigned URLs, passwords, or full provider payloads to logs.
- The scheduled trigger is an outbox/deletion/cleanup backstop. Alert on repeated
  dispatch failure, growing queued/retry states, deletion failures, or provider
  authentication errors.
- For `reauth_required`, ask the customer to reconnect; do not repeatedly call the
  provider with a known-invalid token.
- For `reconciliation_required`, inspect the stored provider identifier and the
  destination account before any retry. Unknown outcome means duplicate risk.
- For direct-upload failures, compare the exact browser origin, R2 CORS rule,
  bucket name, API-token scope, part ETags, and system clock.
- For broad provider incidents or revoked approval, set the capability to a
  non-publishing mode and deploy that operational change before debugging.
- For an account deletion failure, inspect the deletion reference/status and logs;
  do not mark it complete manually while D1/R2 data remains.

To roll back application code, deploy a previously verified Worker/Pages revision
using the normal Cloudflare rollback or deployment workflow and preserve evidence.
Do not attempt to reverse D1 by deleting tables or migration records. Ensure an
older Worker remains compatible with the current schema before rolling it back.
