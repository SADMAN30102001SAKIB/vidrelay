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

`apps/backend/wrangler.jsonc` is intentionally local-only. Create the ignored
production configuration before any production check, migration, or deployment:

```powershell
Copy-Item apps/backend/wrangler.production.example.jsonc apps/backend/wrangler.production.jsonc
```

Replace every `REPLACE_WITH_...` sentinel in the copied file. The browser and API
origins must be the customer's exact HTTPS origins, including scheme and host but
no path or trailing slash. Enter the D1 UUID returned for the intended production
database in `database_id`. Keep `ALLOW_SIGNUPS` false until registration abuse
controls and the customer's launch policy have been approved. Never commit the
filled production file.

### Secret Worker variables

| Secret                                                      | When required                                              |
| ----------------------------------------------------------- | ---------------------------------------------------------- |
| `TOKEN_ENCRYPTION_KEY`                                      | Always; encrypts provider credentials and resumable state  |
| `MEDIA_LEASE_SECRET`                                        | Always; signs short-lived private-media leases             |
| `AUDIT_HASH_SECRET`                                         | Always; keyed hashing for security/audit identifiers       |
| `BOOTSTRAP_SIGNUP_TOKEN`                                    | One-time first-owner creation while public signups are off |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | Production `direct` upload signing                         |
| `META_APP_ID`, `META_APP_SECRET`                            | Facebook Pages when enabled                                |
| `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`                  | Instagram when enabled                                     |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`                  | YouTube when enabled                                       |
| `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`                 | TikTok when enabled                                        |
| `META_WEBHOOK_VERIFY_TOKEN`                                 | Meta webhook verification when registered                  |

Keep every provider or webhook secret unset until that integration is explicitly
enabled and its callback or webhook has been registered and tested.
Changing `TOKEN_ENCRYPTION_KEY` without a credential re-encryption plan makes
stored provider connections unreadable. Treat key rotation as a dedicated change.

### First operator-owner bootstrap

Keep public signup disabled in production. For a fresh, empty D1 database, add a
one-time `BOOTSTRAP_SIGNUP_TOKEN` of at least 32 random characters to the initial
version's secret file. After that version is serving, create exactly one trusted
operator-owner through the normal registration contract. This first account is
the global operator used for audited deletion recovery; ordinary registration
still creates customer users. Enter the exact token from the initial secret file
and the new operator's password at masked prompts so neither value enters shell
history:

```powershell
$bootstrapToken = Read-Host "Bootstrap token from .env.production" -MaskInput
$bootstrapPassword = Read-Host "Initial owner password" -MaskInput
$headers = @{
  Origin = "REPLACE_WITH_EXACT_FRONTEND_ORIGIN"
  "X-VidRelay-CSRF" = "1"
  "X-VidRelay-Bootstrap" = $bootstrapToken
}
$body = @{
  email = "owner@customer.example"
  name = "Service operator"
  password = $bootstrapPassword
  timezone = "Asia/Dhaka"
  workspaceName = "Customer workspace"
} | ConvertTo-Json
try {
  Invoke-RestMethod -Method Post -Uri "REPLACE_WITH_EXACT_API_ORIGIN/api/auth/register" -Headers $headers -ContentType "application/json" -Body $body
} finally {
  Remove-Variable bootstrapToken, bootstrapPassword, body -ErrorAction SilentlyContinue
}
```

The endpoint accepts this secret only while the database contains no users; the
conditional D1 batch prevents two concurrent requests from creating two initial
operators. Verify the account can log in and reports role `operator`, then remove
`BOOTSTRAP_SIGNUP_TOKEN` from
the serving Worker without an immediate traffic change:

```powershell
Set-Location apps/backend
pnpm exec wrangler versions secret delete BOOTSTRAP_SIGNUP_TOKEN --config wrangler.production.jsonc
```

Record and inspect the version ID returned by that command, then deploy that
exact version with `wrangler versions deploy` as described in the release steps.
Merely omitting the token from a later `--secrets-file` does not delete it.
Never enable `ALLOW_SIGNUPS` merely to bootstrap a customer, leave the bootstrap
token in the serving configuration, or store either bootstrap value in shell
history.

With public signup disabled, provision each customer from the authenticated
operator session by sending `POST /api/auth/provision-customer` with the normal
registration fields plus `"acknowledgement":"provision_customer"`. Use the
exact production frontend Origin and `X-VidRelay-CSRF: 1`; the endpoint creates a
separate customer owner/workspace and never changes the operator session. Verify
the returned email, role `customer`, and workspace before sharing credentials.
This is an externally visible account-creation action: obtain the customer's
authorization, transmit the initial password through an approved secure channel,
and require it to be changed at first handoff. The service operator account cannot
request its own deletion until operator responsibility has been handed off.

Example from an authenticated browser session or an operator-controlled API
client:

```json
{
  "acknowledgement": "provision_customer",
  "email": "owner@customer.example",
  "name": "Customer owner",
  "password": "replace-with-a-unique-temporary-password",
  "timezone": "Asia/Dhaka",
  "workspaceName": "Customer workspace"
}
```

### Bindings and resources

| Binding                     | Development name   | Production name               |
| --------------------------- | ------------------ | ----------------------------- |
| D1 `DB`                     | `vidrelay`         | `vidrelay-production`         |
| R2 `MEDIA`                  | `vidrelay-media`   | `vidrelay-media-production`   |
| Workflow `PUBLISH_WORKFLOW` | `vidrelay-publish` | `vidrelay-publish-production` |

The local config names only local resources and deliberately has no production
environment. `apps/backend/wrangler.production.example.jsonc` documents the
production bindings, while the ignored `wrangler.production.jsonc` selects the
real account resources. Production migration and deployment scripts always pass
that file explicitly. Do not reuse a test database or bucket for production.

Whenever Wrangler bindings change, run `pnpm types:generate`, inspect the generated
binding type, and include it in the normal verification pass.

## One-time Cloudflare setup

Confirm that the target account has a Workers Paid subscription before creating
the production release. VidRelay's 60-120 provider polling steps and resumable
YouTube chunks can exceed the Free plan's 50 external subrequests per Workflow
instance. Record the plan check in the release evidence and test a maximum-size
upload plus worst-case polling before launch.

Use an authenticated Wrangler session for the intended Cloudflare account. From
`apps/backend`, an authorized operator may create the named resources if they do
not already exist:

```powershell
pnpm exec wrangler d1 create vidrelay-production
pnpm exec wrangler r2 bucket create vidrelay-media-production
```

Capture the D1 database ID in the ignored `wrangler.production.jsonc`. Keep R2
private. Create an R2 API token limited to object read/write for the production
media bucket; do not expose its access-key credentials to the browser.

Do not use `wrangler secret put` as a harmless setup command: current Wrangler
creates and immediately deploys a Worker version for that command. Prepare the
initial secret set in an operator-controlled secret store or an ignored
`.env.production` file, but upload it only from the reviewed revision during the
release below. The production template declares the always-required
encryption/audit and direct-R2 secret names so a version upload fails clearly when
they are missing. Add only provider secrets approved for the deployment, and
follow [the provider runbook](PROVIDERS.md) before enabling a capability. Never
pass a secret value as a command-line argument or commit the secret file.

Ensure the Cloudflare Pages project expected by the frontend deploy script is
named `vidrelay`, or deliberately update the deployment configuration before
release. The script explicitly deploys branch `main`; verify in the Pages project
settings that `main` is the production branch, or deliberately update both the
project and script together. Otherwise Wrangler creates a preview deployment.
The static frontend build must receive the production API origin as
`NEXT_PUBLIC_API_URL`; a localhost value will otherwise be compiled into `out`.

## R2 browser CORS

Direct presigned uploads go from the browser to R2, so Worker CORS alone is not
enough. Copy `apps/backend/r2-cors.example.json`, replace its
`REPLACE_WITH_...` sentinel with the exact production app origin, review it, and
apply it to the production bucket:

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
3. Before a production migration, record the target database/account, run
   `pnpm migrations:list:remote`, verify the database name and ID selected by the
   ignored production config, create the appropriate D1 backup/export, and obtain
   release approval.
4. Apply exactly once with `pnpm migrate:remote`.
5. Verify the applied migration list and the health/config endpoints before
   deploying code that requires the new schema.

Generated SQL is review input, not proof that an existing populated database can
apply it safely. Migration `0001` is immutable history and adds the required
idempotency key without a default; it assumes the `posts` table is still empty.
Migration `0002` deliberately invalidates only in-flight OAuth state rows,
because those short-lived rows cannot be retroactively bound to the initiating
session; users can restart the connection flow after upgrade. It then adds the
session binding, credential-refresh lease, publish-transition, and
storage-deletion fields used by the current application. Migration `0003` adds
the bounded account-deletion retry state, safe failure phases, and scheduler
index; verify both a fresh migration and an upgrade containing an existing
deletion request before production rollout.
Migration `0004` adds the application default through a forward table rebuild and
backs up and restores destinations, attempts, and media leases across the cascade.

Do not edit migration SQL casually, delete migration history, or assume that
rolling back Worker code rolls back D1. Prefer a reviewed forward migration when
production data has advanced.

Reference: [Cloudflare D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/).

## Verification

Run the repository gate from the root:

```powershell
$env:NEXT_PUBLIC_API_URL = "http://localhost:4000"
pnpm check
```

It must pass formatting, ESLint, TypeScript/Workers binding checks, Vitest, Fallow,
and both builds. A dry-run Worker build is not a production deployment.
For a release candidate, copy/fill the ignored production config and additionally
run this non-deploying check after verifying every sentinel is gone:

```powershell
pnpm --filter @vidrelay/backend build:production-config
```

Before enabling a provider or releasing:

- inspect `GET /api/config` and confirm every configured/mode pair matches the
  actual provider console;
- register/login/logout and verify cross-origin session and CSRF behavior;
- connect and disconnect an approved test account for each enabled platform;
- upload a known-good common-profile MP4 through the production direct-upload path;
- submit one destination at a time, then one post targeting every enabled
  destination;
- confirm provider-specific visibility/metadata, status polling, history, and
  partial failure behavior;
- repeat a submission with the same idempotency key and confirm no duplicate;
- test a safe retry and the reconciliation-required operator path without blindly
  republishing; and
- exercise account deletion only with a disposable non-production account, then
  verify D1/R2 cleanup and the opaque deletion status reference.

## Production release

1. Freeze the reviewed revision and record the release owner.
2. Confirm provider approvals and keep every unapproved capability in a
   non-publishing mode.
3. Confirm Workers Paid is active for the target account and record that gate.
4. Create and review the ignored production config; confirm no
   `REPLACE_WITH_...` sentinel remains and verify D1 ID, exact origins,
   R2/Workflow bindings, scheduled trigger, observability, Pages project, and
   production secrets.
5. Apply and verify R2 CORS.
6. Set `NEXT_PUBLIC_API_URL` to the exact production API origin, run `pnpm check`
   from a clean dependency install, and run
   `pnpm --filter @vidrelay/backend build:production-config` against the reviewed
   ignored production config.
7. Back up D1, then apply approved remote migrations with `pnpm migrate:remote`.
8. A brand-new Worker has no prior version, so perform its first deployment from
   `apps/backend` with
   `pnpm exec wrangler deploy --config wrangler.production.jsonc --secrets-file .env.production --minify`.
   This immediately serves the reviewed version and applies its configured Cron
   Trigger. For a later secret change, stage a non-serving version with
   `pnpm exec wrangler versions upload --config wrangler.production.jsonc --secrets-file .env.production`,
   inspect its returned version ID, deploy that exact version with
   `pnpm exec wrangler versions deploy <version-id> --config wrangler.production.jsonc`,
   then apply the reviewed route and Cron Trigger configuration with
   `pnpm exec wrangler triggers deploy --config wrangler.production.jsonc`.
   Version uploads do not apply triggers automatically. For a later release with
   unchanged secrets, `pnpm deploy:backend` deploys the reviewed source and
   configured triggers directly. Every command in this step changes remote state
   except `versions upload`, which does not shift traffic.
9. Verify the `*/5 * * * *` Cron Trigger, API health/config endpoints, and Worker
   logs.
10. Build the static frontend with the production `NEXT_PUBLIC_API_URL`, then run
    `pnpm deploy:frontend`.
11. Execute the production smoke path with designated low-risk provider accounts.
12. Record revision, migration list, Worker/Pages deployment identifiers, config
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
  do not mark it complete manually while D1/R2 data remains. After correcting
  the recorded failure, an authenticated global operator can send
  `POST /api/account/deletions/<deletion-id>/retry` with
  `{"acknowledgement":"retry_deletion"}`. The request is audited; do not use it
  before verifying the target ID and cleanup cause.

To roll back application code, deploy a previously verified Worker/Pages revision
using the normal Cloudflare rollback or deployment workflow and preserve evidence.
Do not attempt to reverse D1 by deleting tables or migration records. Ensure an
older Worker remains compatible with the current schema before rolling it back.
