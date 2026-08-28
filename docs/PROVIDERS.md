# Provider setup and review gates

Provider setup is both technical and administrative. A valid client ID is not
production approval. Keep a platform unavailable until its credentials, account
eligibility, requested permissions, review state, and end-to-end test are all
verified for the actual production application.

The callback base is `PUBLIC_API_ORIGIN`, with no trailing path:

| Platform  | Redirect URI path               | Requested scopes                                                                                               |
| --------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Facebook  | `/api/oauth/facebook/callback`  | `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`                                               |
| Instagram | `/api/oauth/instagram/callback` | `instagram_business_basic`, `instagram_business_content_publish`                                               |
| YouTube   | `/api/oauth/youtube/callback`   | `openid`, `https://www.googleapis.com/auth/youtube.upload`, `https://www.googleapis.com/auth/youtube.readonly` |
| TikTok    | `/api/oauth/tiktok/callback`    | `user.info.basic`, `video.publish`                                                                             |

For local provider testing, prepend `http://localhost:4000`. For production,
prepend the exact deployed API origin configured in `PUBLIC_API_ORIGIN`. Register
the resulting values verbatim with each provider and ensure the frontend origin is
allowed separately in `APP_ORIGINS`.

## Capability modes

The production variables in the operator's ignored
`apps/backend/wrangler.production.jsonc` are enforcement, not display-only labels:

- `disabled`: connection and publishing are unavailable.
- `development_only`: provider roles/test accounts may be used outside production;
  production submission is rejected.
- `review_pending`: production submission is rejected while review is unresolved.
- `private_only`: YouTube must use `private` visibility; TikTok must use
  `SELF_ONLY` and still pass the live creator-info restrictions.
- `direct_publish`: the provider may receive a publish request under its approved
  visibility and account rules.
- `inbox_only`: connection may be shown, but Direct Post submission is rejected.

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

The connection discovery records Pages and marks them publishable only when Meta
reports every required scope and returns a content-management task, including the
New Pages Experience `PROFILE_PLUS_*` task family. Recheck reads the live granted
permission set again. It does not connect a personal Facebook profile. Confirm
the review result for all requested permissions before changing
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
before changing `INSTAGRAM_CAPABILITY`. OAuth and recheck fail closed unless Meta
reports both required Instagram permissions as granted.

References: [Instagram content publishing](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/content-publishing/),
[Meta's official Instagram API collection](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api).

## YouTube

1. Create or select the production Google Cloud project and enable YouTube Data
   API v3.
2. Configure the OAuth consent screen, verified domains/policy links, test users,
   and a Web application OAuth client with the exact callback.
3. Add the generated client ID/secret as Worker secrets. VidRelay requests offline
   access and uses PKCE so it can resume uploads without exposing credentials to
   the browser. It requires `youtube.upload` for uploads and `youtube.readonly` for
   channel discovery and processing checks, and rejects incomplete granular grants.
   The `openid` scope is used only to store Google's stable subject identifier so
   disconnect and account deletion do not revoke a grant still used by another
   active workspace; VidRelay does not request email or profile data through it.
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

## TikTok

TikTok Direct Post is implemented but must remain capability-gated. Before it is
enabled, add the Content Posting API product, obtain the `video.publish` scope,
configure the exact redirect and signed webhook, verify the media URL domain, and
complete the applicable Direct Post audit.

The compose UI and backend query current creator information rather than assuming
capabilities. The user must select a returned privacy option, see the target
creator, confirm the preview/music rights, and make the required commercial and
AI-content disclosures. Comments, duet, and stitch remain opt-in and are disabled
when the provider says they are unavailable. `private_only` additionally enforces
`SELF_ONLY`; it is a test/review restriction, not evidence of production approval.

If TikTok is excluded from a particular customer release, leave both credentials
unset and set `TIKTOK_CAPABILITY=disabled`. Do not market it or register its
callbacks for that release.

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

The API exposes provider-specific Meta callbacks at
`/api/webhooks/meta/facebook` and `/api/webhooks/meta/instagram`, plus the TikTok
callback at `/api/webhooks/tiktok`. Register only the callback for an enabled
provider. Both Meta callbacks use `META_WEBHOOK_VERIFY_TOKEN` for the GET
challenge; Facebook POST signatures use `META_APP_SECRET`, while Instagram POST
signatures use `INSTAGRAM_APP_SECRET`. The fixed callback path selects the secret
before any untrusted payload is parsed. Meta POST callbacks verify, deduplicate,
and record deliveries as ignored; they do **not** drive destination status, so
Workflow polling remains authoritative for Facebook and Instagram. TikTok status
events do update matching destinations. Run provider-console delivery tests and
the end-to-end status path before relying on any integration.
