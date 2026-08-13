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
  processes account deletion requests, cleans expired security/media records, and
  moves stale active publishing attempts into a safe recovery state.

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

1. An authenticated user atomically reserves workspace quota in D1 with filename,
   MP4 MIME type, and declared size before R2 multipart creation.
2. In local `worker_proxy` mode the browser sends multipart data through the API.
   In production `direct` mode, the API creates an R2 multipart upload and signs
   short-lived S3-compatible URLs for requested part numbers.
3. The browser uploads parts and returns their part numbers and ETags. A browser
   can request at most 25 part URLs at once; current parts are 16 MiB.
4. Completion is idempotent. The API completes the R2 multipart upload, verifies
   the stored object size, and reads bounded MP4 metadata ranges from private R2.
5. Invalid media is rejected. Valid media becomes `ready` and can be previewed
   through a short-lived signed media lease.
6. A source can be removed after all referencing destinations are published or
   explicitly cancelled. R2 quota is released only after deletion is confirmed;
   post and attempt evidence remains in D1.

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
6. Safe preparation and polling steps may retry with bounded backoff. Provider
   effects that create sessions, transfer media, or publish are zero-retry steps;
   their returned identifiers are checkpointed separately. Bearer upload URLs are
   encrypted before they can enter durable step output.
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
- TikTok: target creator, title, privacy from current creator options, interaction
  controls, commercial-content and AI disclosures, preview, and rights consent.

## Account deletion lifecycle

Deletion requires the current password and the exact confirmation text
`DELETE MY ACCOUNT`. The current self-service flow supports only the sole owner of
a single-member, single-workspace account.

The request immediately invalidates sessions, cancels only clearly unsent work,
and marks provider-committed active work outcome-unknown. Scheduled processing
then attempts provider token revocation, deletes workspace R2 objects, and deletes
the user/workspace records. Provider/storage failures receive bounded exponential
retry; after five attempts the request requires audited operator intervention
instead of retrying forever. An opaque bearer reference, returned once and
reusable by its holder, allows status lookup without a session.

Deletion does **not** delete content already published to a provider. A provider
effect accepted just before deletion may also complete after the local workflow is
cancelled. The customer must inspect and delete that content at the provider.
Minimal deletion proof and pseudonymous audit records may remain; the operator
must adopt and document an explicit retention period before launch.

## Deliberate limits

- Supported targets are Facebook Pages, Instagram Professional accounts, YouTube
  channels, and capability-eligible TikTok creators—not personal Facebook or
  Instagram accounts. A customer release can keep any provider disabled.
- There is no transcoding service, scheduling UI, team-management UI, billing,
  content moderation system, or guarantee of provider acceptance.
- The API uses at-least-once infrastructure with application idempotency; it does
  not claim distributed exactly-once publication.
- Provider review modes are operational controls, not evidence that a provider has
  approved the application.
