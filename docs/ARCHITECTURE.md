# Architecture and lifecycle

## System boundary

```text
Browser
  |-- static UI ------------------------------> Cloudflare Pages
  |-- authenticated API ---------------------> Hono Worker
  |-- presigned multipart PUTs (production) -> private R2 bucket
                                                   ^
Hono Worker -> D1 + R2 binding + Workflow binding -|-> provider APIs
      ^              ^
      |              `-- five-minute scheduled maintenance/backstop
      `-- exact-origin CORS, CSRF header, HttpOnly session cookie
```

The frontend is a Next.js static export. It has no server actions or runtime
secrets; `NEXT_PUBLIC_API_URL` is compiled into the build. The API is a separate
Hono Worker and is the sole authority for sessions, provider credentials,
capabilities, media validation, publishing state, and deletion requests.

Cloudflare resources:

- **D1 (`DB`)** stores users, workspaces, sessions, encrypted provider
  credentials, uploads, posts, destination attempts, outbox events, audit events,
  and deletion requests.
- **R2 (`MEDIA`)** stores private source videos. The bucket is not a public asset
  origin.
- **Workflows (`PUBLISH_WORKFLOW`)** isolates a durable publish lifecycle for each
  destination attempt.
- A **scheduled trigger every five minutes** retries undispatched outbox work,
  processes account deletion requests, and cleans expired security records.

## Request and security model

The browser authenticates with an HttpOnly session cookie. The raw session token
is never stored in D1; only its hash is stored. Production cookies are `Secure`
and cross-site, because Pages and the API normally have different origins.

The API accepts browser origins only from the exact comma-separated
`APP_ORIGINS` allowlist. Authenticated browser mutations also require
`X-VidRelay-CSRF: 1`. Requests use credentials, so wildcard CORS is not valid.
Provider OAuth state is single-use and short-lived; YouTube also uses PKCE.
Provider tokens and resumable provider-upload state are encrypted at rest with
`TOKEN_ENCRYPTION_KEY`.

`GET /health` is an unauthenticated liveness endpoint. `GET /api/config` is an
unauthenticated, non-secret description of effective provider capabilities, the
accepted media profile, and whether signups are open.

## Upload lifecycle

1. An authenticated user creates an upload record with filename, MP4 MIME type,
   and declared size.
2. In local `worker_proxy` mode the browser sends multipart data through the API.
   In production `direct` mode, the API creates an R2 multipart upload and signs
   short-lived S3-compatible URLs for requested part numbers.
3. The browser uploads parts and returns their part numbers and ETags. A browser
   can request at most 25 part URLs at once; current parts are 16 MiB.
4. Completion is idempotent. The API completes the R2 multipart upload, verifies
   the stored object size, and reads bounded MP4 metadata ranges from private R2.
5. Invalid media is rejected. Valid media becomes `ready` and can be previewed
   through a short-lived signed media lease.

VidRelay does not currently transcode, crop, normalize loudness, or repair an MP4.
Validation against the common profile reduces cross-platform failures but cannot
override a provider's own content, copyright, account, quota, or policy checks.

## Publish lifecycle

1. The user selects one connected destination per platform, supplies each
   platform's metadata, confirms media rights, and submits a UUID idempotency key.
2. The API verifies that the upload is `ready`, each connection is connected, and
   the deployment capability allows the requested visibility.
3. One D1 batch creates the post, destinations, attempt 1, and deterministic
   outbox events. A repeated workspace/idempotency-key request returns the existing
   post instead of duplicating it.
4. A best-effort request `waitUntil` dispatches immediately. The scheduled trigger
   is the durable backstop for an outbox event not yet dispatched.
5. Each outbox event creates a Workflow instance named from destination ID and
   attempt number. A destination therefore fails or succeeds independently.
6. Safe preparation, transfer, and polling steps may retry with bounded backoff.
   The provider call that can create a public post is treated as unsafe and is not
   blindly replayed.
7. The Worker stores provider session/post identifiers and polls processing state.
   A confirmed provider post becomes `published` with its provider URL when one is
   available.

If a timeout makes the provider outcome unknowable, the destination becomes
`reconciliation_required`. Operators and users must reconcile by stored provider
identifiers or inspect the provider account before requesting a new publish. A
blind retry can create duplicate public content and is intentionally prohibited.

Aggregate post status is derived from destination status: all published is
`published`; a mix of success and terminal failure is `partial_success`; active
destinations remain `publishing`; terminal failures become `failed`.

## Provider-specific inputs

- Facebook: optional title and description.
- Instagram: caption and whether to share the Reel to the feed.
- YouTube: title, description, category, privacy, made-for-kids declaration, and
  synthetic-media declaration.
- TikTok fields and future-facing publishing plumbing exist, but are not a v1
  release commitment.

## Account deletion lifecycle

Deletion requires the current password and the exact confirmation text
`DELETE MY ACCOUNT`. The current self-service flow supports only the sole owner of
a single-member, single-workspace account.

The request immediately invalidates sessions and cancels non-terminal local
publishing work. Scheduled processing then attempts provider token revocation,
deletes workspace R2 objects, and deletes the user/workspace records. Revocation is
best effort so an unavailable provider cannot indefinitely block local deletion.
A one-time opaque reference allows status lookup without a session.

Deletion does **not** delete content already published to Facebook, Instagram, or
YouTube. The customer must delete that content at the provider. Minimal deletion
proof and de-identified audit records may remain; the operator must adopt and
document an explicit retention period before launch.

## Deliberate limits

- v1 supports Facebook Pages, Instagram Professional accounts, and YouTube
  channels—not personal Facebook or Instagram accounts.
- TikTok is not part of the v1 launch even though shared contracts/configuration
  reserve the platform.
- There is no transcoding service, scheduling UI, team-management UI, billing,
  content moderation system, or guarantee of provider acceptance.
- The API uses at-least-once infrastructure with application idempotency; it does
  not claim distributed exactly-once publication.
- Provider review modes are operational controls, not evidence that a provider has
  approved the application.
