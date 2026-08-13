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
| D1              | Audit events, signed-webhook event hashes/status, and account-deletion requests                             | Security, replay control, support, deletion proof, and operations |
| Private R2      | Customer-uploaded source video                                                                              | Preview and provider transfer                                     |
| Cloudflare logs | Request ID, route/status, and deliberately sanitized operational errors                                     | Availability, debugging, and incident response                    |
| Providers       | OAuth identity, source media, requested metadata, and provider-side post/processing data                    | User-requested external publishing                                |

Cloudflare hosts the frontend, Worker, D1, R2, and Workflow execution. Meta,
Google, and TikTok become independent processors/controllers under their own
terms when a customer connects an account or publishes content. A provider kept
disabled and unconfigured for a customer release does not receive customer data.

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
- A user can remove an unused upload or a post's source media after every
  destination is published or explicitly cancelled. The D1 post, destination,
  attempt, and audit history remains, and provider-side posts are unaffected.
- A customer can explicitly abandon future retries for a known terminal failure
  before removing its source. An uncertain provider outcome must first be
  reconciled; VidRelay never treats uncertainty as safe to delete or retry.
- Self-service account deletion currently supports only a sole owner in one
  single-member workspace. Team/workspace transfer and multi-member deletion need
  an operator process or product work before those account models are offered.
- Account deletion invalidates sessions, cancels clearly unsent work, records
  active or provider-committed work as outcome-unknown, attempts provider
  revocation, removes workspace videos from R2, and deletes account/workspace
  rows from D1.
- A transient provider-revocation or R2 cleanup failure receives bounded
  exponential retries. After five failed attempts, the request enters
  `manual_review`; an operator can audit and explicitly resume it after fixing
  the cause. Do not claim completion while a grant or media cleanup is unresolved.
- Content already published to any provider remains under that provider account.
  A publish accepted immediately before deletion may also finish afterward. The
  user must inspect and delete such content there; VidRelay cannot promise its
  removal.
- Minimal pseudonymous audit and deletion-request records may remain after account
  deletion because their user/workspace foreign keys are cleared. Free-form audit
  entity identifiers and metadata are not proven anonymous. Publish the actual
  retention period once the business adopts one.

The deletion-status reference is a reusable bearer secret returned only when the
request is created. Display it once, advise the user to store it safely, and never
log or send it to analytics.

## Launch privacy checklist

- Inventory production D1/R2/log/backup locations, subprocessors, regions, and
  configured retention.
- Confirm the public policy matches exactly the providers enabled for that
  customer release.
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
