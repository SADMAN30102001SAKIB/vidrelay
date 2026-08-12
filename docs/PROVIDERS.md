# Provider setup and review gates

Provider setup is both technical and administrative. A valid client ID is not
production approval. Keep a platform unavailable until its credentials, account
eligibility, requested permissions, review state, and end-to-end test are all
verified for the actual production application.

The callback base is `PUBLIC_API_ORIGIN`, with no trailing path:

| Platform       | Redirect URI path               | Requested scopes                                                 |
| -------------- | ------------------------------- | ---------------------------------------------------------------- |
| Facebook       | `/api/oauth/facebook/callback`  | `pages_show_list`, `pages_read_engagement`, `pages_manage_posts` |
| Instagram      | `/api/oauth/instagram/callback` | `instagram_business_basic`, `instagram_business_content_publish` |
| YouTube        | `/api/oauth/youtube/callback`   | `https://www.googleapis.com/auth/youtube.upload`                 |
| TikTok (later) | `/api/oauth/tiktok/callback`    | `user.info.basic`, `video.publish`                               |

For local provider testing, prepend `http://localhost:4000`. For production,
prepend the exact deployed API origin configured in `PUBLIC_API_ORIGIN`. Register
the resulting values verbatim with each provider and ensure the frontend origin is
allowed separately in `APP_ORIGINS`.

## Capability modes

The production variables in `apps/backend/wrangler.jsonc` are enforcement, not
display-only labels:

- `disabled`: connection and publishing are unavailable.
- `development_only`: provider roles/test accounts may be used outside production;
  production submission is rejected.
- `review_pending`: production submission is rejected while review is unresolved.
- `private_only`: YouTube must use `private` visibility. The TikTok equivalent is
  reserved for later work.
- `direct_publish`: the provider may receive a publish request under its approved
  visibility and account rules.
- `inbox_only`: reserved for a future TikTok creator-inbox flow; v1 does not use it.

Move to `direct_publish` only after approval is visible in the provider console and
the exact production app/account has passed a controlled test. If approval is
withdrawn or an incident occurs, disable the capability before investigating.

## Facebook Pages

1. Create or select the production Meta app and configure Facebook Login for the
   exact production callback.
2. Add the privacy policy and account-deletion instructions required by the Meta
   app configuration.
3. Request the Page permissions used by the code. Provide review instructions and
   a screencast that demonstrates connection, Page selection, upload, provider
   metadata, publishing, result status, disconnect, and account deletion.
4. Complete business verification or other access prerequisites when the Meta
   console requires them.
5. Test first with app-role/test users and a non-critical Page.

The connection discovery keeps only Pages for which Meta returns a content-management
task (`CREATE_CONTENT` or `MANAGE`). It does not connect a personal Facebook
profile. Confirm the review result for all requested permissions before changing
`FACEBOOK_CAPABILITY`.

References: [Meta Reels publishing](https://developers.facebook.com/docs/video-api/guides/reels-publishing/),
[Meta access levels](https://developers.facebook.com/docs/app-review/access-levels/),
[Meta's official Facebook API collection](https://www.postman.com/meta/facebook/documentation/r56bjfd/facebook-api?entity=request-23987686-0b79260c-96bd-49de-875b-6076213785fc).

## Instagram Professional accounts

VidRelay uses Instagram Login and the Instagram API, not a personal-account
upload workaround. The customer must authorize an eligible Professional account.

1. Configure the Instagram product and exact callback in the Meta app.
2. Request `instagram_business_basic` and
   `instagram_business_content_publish` for the production use case.
3. Prepare the same public policy/deletion surfaces and review demonstration used
   for the Facebook flow, but show the Instagram Professional account and Reel
   result explicitly.
4. Test caption, share-to-feed choice, container processing, publication, and
   returned permalink with an app-role/test account.

Do not advertise personal Instagram support. Confirm the production access level
before changing `INSTAGRAM_CAPABILITY`.

References: [Instagram content publishing](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/content-publishing/),
[Meta's official Instagram API collection](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api).

## YouTube

1. Create or select the production Google Cloud project and enable YouTube Data
   API v3.
2. Configure the OAuth consent screen, verified domains/policy links, test users,
   and a Web application OAuth client with the exact callback.
3. Add the generated client ID/secret as Worker secrets. VidRelay requests offline
   access and uses PKCE so it can resume uploads without exposing credentials to
   the browser.
4. Complete Google's OAuth verification when the consent configuration requires
   it, and complete the YouTube API compliance audit required to remove upload
   restrictions.
5. Until that audit is approved, keep `YOUTUBE_CAPABILITY=private_only` and test
   only private uploads. Monitor the real project's quota in Google Cloud rather
   than assuming a fixed capacity.

An unverified YouTube API project can have uploads forced to private. OAuth
verification and the YouTube compliance audit are related but distinct gates; do
not treat a working consent screen as permission for public publishing.

References: [`videos.insert`](https://developers.google.com/youtube/v3/docs/videos/insert),
[video upload implementation guide](https://developers.google.com/youtube/v3/guides/implementation/videos).

## TikTok is not a v1 provider

The repository contains future-facing TikTok contracts, secret names, and
publishing plumbing. That does not make TikTok a launched or approved provider.
For the first release:

- leave `TIKTOK_CLIENT_KEY` and `TIKTOK_CLIENT_SECRET` unset;
- set the production `TIKTOK_CAPABILITY` to `disabled` before release;
- do not include TikTok in marketing, review evidence, or acceptance tests; and
- do not register webhook or redirect URLs for a feature not being launched.

A later release would require the Content Posting API product, approved
`video.publish` scope, Direct Post audit, creator-info checks, user-facing consent
and disclosure controls, and TikTok's current posting caps. Unaudited Direct Post
clients are private-only and constrained; those limitations are not a viable
substitute for approval.

References: [TikTok Content Posting API setup](https://developers.tiktok.com/doc/content-posting-api-get-started/),
[TikTok content-sharing guidelines](https://developers.tiktok.com/doc/content-sharing-guidelines/).

## Review submission checklist

- Production domains, support contact, privacy policy, terms, and deletion
  instructions are public and internally consistent.
- Redirect URIs exactly match `PUBLIC_API_ORIGIN`; no localhost or placeholder
  origin appears in production configuration.
- Reviewers receive a least-privilege test account and reproducible steps.
- The recording shows each permission in context and never claims an unsupported
  account type or visibility.
- Provider branding, disclosures, terms, retention, and deletion obligations are
  reflected in the customer-facing product.
- The capability remains gated until approval and a production smoke test are
  recorded with date, app/project ID, reviewer, and result.

The `.dev.vars.example` file reserves webhook secrets, but the current API has no
provider webhook route. Do not register a webhook callback or claim webhook-driven
status until that lifecycle is implemented, authenticated, tested, and documented.
