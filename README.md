# VidRelay

VidRelay is a Cloudflare-based SaaS control plane for uploading one verified vertical
video and publishing it independently to supported social destinations. The first
release targets **Facebook Pages**, **Instagram Professional accounts**, and
**YouTube channels**. TikTok is deliberately outside the v1 launch scope.

This repository is pre-release software. Provider credentials, provider approval,
successful verification, and an operator-approved release are all separate gates.
VidRelay does not bypass platform policy, make personal profiles publishable, or
guarantee that every provider will accept or immediately publish a video.

## Product truth

| Destination | Eligible account                                                | Safe v1 promise                                                                                                                           |
| ----------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Facebook    | A Page for which the connecting user has the required Page task | Development/test access until Meta grants the required production access; direct Page Reel publishing only when the capability is enabled |
| Instagram   | A Professional account supported by Instagram Login             | Development/test access until Meta review is complete; no personal-account publishing                                                     |
| YouTube     | A channel authorized with `youtube.upload`                      | Private uploads while the API project is restricted; broader visibility only after the required YouTube audit/approval                    |
| TikTok      | Not in v1                                                       | Leave credentials unset and the production capability disabled                                                                            |

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

Requirements are Node.js 24 (see `.node-version`) and pnpm 11.20.0.

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

## Root commands

| Command                | Purpose                                                                   |
| ---------------------- | ------------------------------------------------------------------------- |
| `pnpm dev`             | Run frontend and backend development servers                              |
| `pnpm types:generate`  | Regenerate Wrangler binding types after configuration changes             |
| `pnpm generate`        | Generate a Drizzle migration from schema changes                          |
| `pnpm migrate:local`   | Apply D1 migrations to local Wrangler state                               |
| `pnpm migrate:remote`  | Apply D1 migrations to the production D1 database; this is a remote write |
| `pnpm check`           | Format check, lint, typecheck, tests, Fallow, and builds                  |
| `pnpm deploy:backend`  | Deploy the production API Worker and Workflow                             |
| `pnpm deploy:frontend` | Build and upload the static frontend to the `vidrelay` Pages project      |

Do not run either deployment or the remote migration from an unreviewed branch.
Follow [the release runbook](docs/OPERATIONS.md#production-release) first.

## Media contract

VidRelay currently validates rather than transcodes. A file must be an MP4 with
H.264 video and AAC audio, vertical 9:16, at least 540x960, 4-60 seconds,
23-60 FPS when detectable, and no larger than 1 GiB. The recommended input is
1080x1920. Provider-side checks still apply after VidRelay validation.
