import { PublicShell } from "@/components/PublicChrome";

export default function PrivacyPage() {
  return (
    <PublicShell>
      <div className="legal-main">
        <p className="eyebrow">Effective August 8, 2026</p>
        <h1>Privacy notice</h1>
        <p>
          This notice explains the data VidRelay needs to authenticate you,
          connect social accounts, upload media, deliver publishing requests,
          and show their status.
        </p>
        <h2>Data we process</h2>
        <ul>
          <li>Account, workspace, session, and security records.</li>
          <li>
            OAuth credentials and identifiers for accounts you explicitly
            connect.
          </li>
          <li>
            Uploaded videos, captions, destination settings, provider IDs, and
            status records.
          </li>
          <li>
            Operational logs needed to secure and troubleshoot the service.
          </li>
        </ul>
        <h2>How we use and share data</h2>
        <p>
          We use this data to operate VidRelay. When you publish, the selected
          media and settings are sent to the selected provider. Those providers
          process the submission under their own terms and privacy policies.
          VidRelay does not sell personal data.
        </p>
        <h2>Credentials and security</h2>
        <p>
          Provider credentials are stored encrypted and are not displayed in the
          app. Sessions use secure cookies. No system can guarantee absolute
          security, so disconnect a connection if you no longer want VidRelay to
          access it. If a provider cannot confirm revocation, local-only removal
          deletes VidRelay&apos;s stored credential; you must also remove
          VidRelay from that provider&apos;s connected-app settings.
        </p>
        <h2>Retention and deletion</h2>
        <p>
          Records are retained while needed to provide and protect the service.
          A verified account-deletion request starts an asynchronous local
          deletion process and attempts to revoke connected credentials. It does
          not delete posts already published on Facebook, Instagram, or YouTube;
          remove those through the provider itself.
        </p>
        <h2>Your choices</h2>
        <p>
          You can disconnect provider accounts, revoke active sessions, update
          account details, and request deletion from Settings. See the Data
          deletion page for status lookup.
        </p>
      </div>
    </PublicShell>
  );
}
