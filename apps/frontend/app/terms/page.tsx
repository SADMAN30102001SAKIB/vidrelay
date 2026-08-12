import { PublicShell } from "@/components/PublicChrome";

export default function TermsPage() {
  return (
    <PublicShell>
      <div className="legal-main">
        <p className="eyebrow">Effective August 8, 2026</p>
        <h1>Terms of service</h1>
        <p>
          These terms govern use of VidRelay. Use the service only for accounts
          and media you are authorized to manage and only where publishing
          complies with applicable law and each provider’s rules.
        </p>
        <h2>Your responsibilities</h2>
        <ul>
          <li>
            Keep your VidRelay account secure and provide accurate account
            information.
          </li>
          <li>
            Own or hold all permissions needed for uploaded media, audio,
            captions, and brands.
          </li>
          <li>
            Review audience, privacy, disclosure, and interaction controls
            before submitting.
          </li>
          <li>
            Do not abuse provider APIs, evade platform safeguards, or upload
            unlawful content.
          </li>
        </ul>
        <h2>Provider services</h2>
        <p>
          VidRelay coordinates requests to independent platforms. Availability,
          processing, review, reach, moderation, and final display are
          controlled by those platforms. A VidRelay status is based on the
          latest confirmed provider response and is not a promise of
          uninterrupted publication.
        </p>
        <h2>Service changes</h2>
        <p>
          Provider access can be disabled, test-only, review-pending,
          private-only, or otherwise restricted. VidRelay may limit a flow when
          credentials, review approval, or provider functionality are
          unavailable. Current modes are shown in the product before use.
        </p>
        <h2>Availability and liability</h2>
        <p>
          The service is provided without a guarantee of uninterrupted
          operation. To the extent permitted by law, VidRelay is not responsible
          for provider outages, provider decisions, or content changes made
          outside this service.
        </p>
        <h2>Termination</h2>
        <p>
          You may disconnect accounts or request deletion. VidRelay may suspend
          access required to protect the service or comply with law. Account
          deletion does not remove posts that have already been delivered to an
          external platform.
        </p>
      </div>
    </PublicShell>
  );
}
