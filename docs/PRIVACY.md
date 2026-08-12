# Privacy and data limitations

This document is an engineering handoff, not a customer privacy policy or legal
advice. Before launch, the operator must obtain appropriate legal review and
publish jurisdiction-appropriate privacy, terms, support, and deletion pages that
match the deployed behavior and every provider's terms.

## Data inventory

| Store/processor | Data                                                                                                        | Purpose                                                           |
| --------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| D1              | Email, display name, password hash, workspace name/timezone, membership and account status                  | Account authentication and tenancy                                |
| D1              | Hashed session tokens, hashed OAuth state, encrypted PKCE verifier, rate-limit/security records             | Session and OAuth security                                        |
| D1              | Provider account ID/name/avatar/metadata, granted scopes, encrypted access/refresh credentials              | Connect and publish to an authorized destination                  |
| D1              | Upload metadata, validation results, post captions/settings, destination attempts, provider IDs/URLs/errors | Media validation, publishing, history, safe retry/reconciliation  |
| D1              | Audit events and account-deletion requests                                                                  | Security, support, deletion proof, and operational accountability |
| Private R2      | Customer-uploaded source video                                                                              | Preview and provider transfer                                     |
| Cloudflare logs | Request ID, route/status, and deliberately sanitized operational errors                                     | Availability, debugging, and incident response                    |
| Meta/Google     | OAuth identity, source media, requested metadata, and provider-side post/processing data                    | User-requested external publishing                                |

Cloudflare hosts the frontend, Worker, D1, R2, and Workflow execution. Meta and
Google become independent processors/controllers under their own terms when a
customer connects an account or publishes content. TikTok is not a v1 processor
because its integration must remain disabled and unconfigured.

## Security properties

- Passwords are stored as slow password hashes, not plaintext.
- Session tokens and OAuth state are stored as hashes; provider credentials and
  resumable-provider state are encrypted at rest.
- Local secrets live only in ignored `.dev.vars`; production secrets belong in
  Cloudflare Worker Secrets. They must never be `vars`, frontend environment
  values, logs, tickets, or repository files.
- Source videos remain in a private R2 bucket. Browser direct upload uses
  short-lived, scoped presigned part URLs; preview/provider reads use signed media
  leases.
- Credentialed browser requests use an exact Origin allowlist and a required CSRF
  header for mutations.
- The application stores the minimum provider scopes implemented for each v1
  workflow; scope additions require a new privacy and review assessment.

These controls reduce risk but do not replace account-level MFA, Cloudflare access
control, least-privilege operator roles, secret rotation, backups, alerting,
dependency review, or incident-response procedures.

## Retention truth

The current implementation has automatic cleanup for expired sessions, expired or
consumed OAuth state, expired/revoked media leases, and old authentication-attempt
records. The scheduled trigger runs every five minutes; this is eventual cleanup,
not an exact deletion time guarantee.

There is no general time-based purge yet for valid source videos, post history,
audit events, completed deletion proofs, or provider metadata. They remain until a
user action, account deletion, or later retention feature removes them. The
operator must choose, document, implement, and test specific retention periods
before claiming automatic retention behavior in a public policy.

Backups, Cloudflare logs, provider-side copies, support exports, and legally
required records can have separate retention. The public policy must describe
those systems and deletion windows based on the actual production configuration.

## User controls and limitations

- Disconnecting a provider attempts token revocation and makes the stored local
  credential unusable. It does not delete provider-side posts.
- A user can delete an unused upload through the product/API. Media referenced by
  a post is retained to preserve the publishing/history lifecycle.
- Self-service account deletion currently supports only a sole owner in one
  single-member workspace. Team/workspace transfer and multi-member deletion need
  an operator process or product work before those account models are offered.
- Account deletion invalidates sessions, cancels non-terminal local work, attempts
  provider revocation, removes workspace videos from R2, and deletes account/workspace
  rows from D1.
- Provider revocation is best effort. Local deletion continues when a provider is
  unavailable, and the failure is logged for operations.
- Content already published to Facebook, Instagram, or YouTube remains under the
  provider account. The user must delete it there; VidRelay cannot promise its
  removal.
- Minimal de-identified audit and deletion-request records may remain after account
  deletion because their user/workspace references are cleared. Publish the actual
  retention period once the business adopts one.

The one-time deletion-status reference is a bearer secret. Display it once, advise
the user to store it safely, and never log or send it to analytics.

## Launch privacy checklist

- Inventory production D1/R2/log/backup locations, subprocessors, regions, and
  configured retention.
- Confirm the public policy matches the three launched providers and does not list
  TikTok as active.
- Publish working privacy, terms, support, and deletion URLs before provider review;
  use the same URLs in provider consoles and the product.
- Define data-subject access/correction/export/deletion and law-enforcement/support
  procedures, including identity verification and response ownership.
- Define retention for uploads, post history, audit records, deletion proof, logs,
  backups, and failed provider revocations; implement any promised automation.
- Document the lawful basis/consent for account data, provider connection, source
  media, and cross-platform publishing, including rights confirmation.
- Confirm analytics, cookies, email, billing, monitoring, and support tools are
  either absent or added to the inventory and consent/policy surfaces.
- Run a disposable-account deletion test and retain non-sensitive evidence of D1,
  R2, session, and provider-revocation outcomes.
- Establish breach response, secret rotation, least-privilege access review, D1
  backup/restore testing, and customer notification ownership.
