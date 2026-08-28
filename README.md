# VidRelay

VidRelay is a Cloudflare-based SaaS control plane for uploading one preflighted vertical
video and publishing it independently to supported social destinations. The
implementation covers **Facebook Pages**, **Instagram Professional accounts**,
and **YouTube channels** in the first release. Each provider remains unavailable
or restricted until its credentials, review state, and capability mode permit it.
TikTok support is intentionally excluded from the first-release product surface.

This repository is pre-release software. Provider credentials, provider approval,
successful release checks, and an operator-approved release are all separate gates.
VidRelay does not bypass platform policy, make personal profiles publishable, or
guarantee that every provider will accept or immediately publish a video.

## Product truth

| Destination | Eligible account                                                         | Safe v1 promise                                                                                                                           |
| ----------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Facebook    | A Page for which the connecting user has the required Page task          | Development/test access until Meta grants the required production access; direct Page Reel publishing only when the capability is enabled |
| Instagram   | A Professional account supported by Instagram Login                      | Development/test access until Meta review is complete; no personal-account publishing                                                     |
| YouTube     | A channel authorizing `openid`, `youtube.upload`, and `youtube.readonly` | Private uploads while the API project is restricted; broader visibility only after the required YouTube audit/approval                    |

The API exposes the effective deployment truth at `GET /api/config`. The frontend
must render those capability modes rather than hard-code availability.

## Repository layout

```text
apps/frontend   Next.js static export, deployed to Cloudflare Pages
apps/backend    Hono API Worker, D1 schema/migrations, R2 media, Workflows
packages/shared Runtime Zod contracts and platform/media definitions
docs             Architecture, provider, operations, and privacy handoff
```

See:

- [Architecture and lifecycle](docs/ARCHITECTURE.md)
- [Provider setup and review gates](docs/PROVIDERS.md)
- [Operations and release runbook](docs/OPERATIONS.md)
- [Privacy and data limitations](docs/PRIVACY.md)

## Local quick start

Requirements are Node.js 24 (see `.node-version`) and pnpm 11.22.0.

```powershell
pnpm install --frozen-lockfile
Copy-Item apps/backend/.dev.vars.example apps/backend/.dev.vars
Copy-Item apps/frontend/.env.example apps/frontend/.env.local
```

Generate a different 32-byte base64url value for each of
`TOKEN_ENCRYPTION_KEY`, `MEDIA_LEASE_SECRET`, and `AUDIT_HASH_SECRET`, then put
them in `apps/backend/.dev.vars`. Provider credentials may remain blank when
testing non-provider flows.

```powershell
pnpm types:generate
pnpm migrate:local
pnpm dev
```

- Frontend: `http://localhost:3000`
- API: `http://localhost:4000`
- Health: `http://localhost:4000/health`
- Public capabilities: `http://localhost:4000/api/config`

Local development uses Worker-proxied R2 uploads. Production uses direct,
presigned multipart R2 uploads and therefore requires the additional R2
credentials and bucket CORS described in the runbook.

Production publishing requires a Workers Paid plan. The bounded polling and
large resumable-upload workflows can exceed the Free plan's per-instance external
subrequest allowance; this is a mandatory release gate, not an optimization.

## Root commands

| Command                       | Purpose                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------ |
| `pnpm dev`                    | Run frontend and backend development servers                                         |
| `pnpm types:generate`         | Regenerate Wrangler binding types after configuration changes                        |
| `pnpm generate`               | Generate a Drizzle migration from schema changes                                     |
| `pnpm migrate:local`          | Apply D1 migrations to local Wrangler state                                          |
| `pnpm migrations:rehearse`    | Rehearse fresh and populated upgrades in isolated local Wrangler state               |
| `pnpm migrations:list:remote` | List pending migrations for the production config without applying them              |
| `pnpm migrate:remote`         | Apply D1 migrations to the production D1 database; this is a remote write            |
| `pnpm check`                  | Format, lint, types, migration rehearsal, tests, Fallow, and builds; set the API URL |
| `pnpm deploy:backend`         | Deploy the production API Worker and Workflow                                        |
| `pnpm deploy:frontend`        | Build and upload the static frontend to the `vidrelay` Pages project                 |

`apps/backend/wrangler.jsonc` is local-only. Both production commands require an
ignored `apps/backend/wrangler.production.jsonc` copied from the checked-in
example and filled with the customer's exact origins and D1 database ID. Do not
run either deployment or the remote migration from an unreviewed branch. Follow
[the release runbook](docs/OPERATIONS.md#production-release) first.

`pnpm fallow` rejects any dead-code finding, duplication above 5%, and any new
complexity finding not present in the committed identity baseline. Run
`pnpm exec fallow health` to inspect the inherited hotspot backlog. Regenerate
`fallow-baselines/health.json` only after an intentional reviewed cleanup or a
deliberate Fallow upgrade; never regenerate it automatically in CI.

## Media contract

VidRelay currently validates rather than transcodes. A file must be an MP4 with
H.264 video and AAC audio at 48 kHz, vertical 9:16, at least 540x960 with no more
than 1920 horizontal pixels, 4-60 seconds, 23-60 FPS, video bitrate no higher
than 25 Mbps, audio bitrate no higher than 128 kbps, and no larger than 1 GiB.
The recommended input is 1080x1920. This is bounded MP4 preflight, not a complete
decoder, and provider-side checks still apply after VidRelay validation.
