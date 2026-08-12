import Link from "next/link";

import { DataDeletionLookup } from "@/components/DataDeletionLookup";
import { PublicShell } from "@/components/PublicChrome";
import { buttonClass } from "@/components/ui";

export default function DataDeletionPage() {
  return (
    <PublicShell>
      <div className="legal-main">
        <p className="eyebrow">Account and workspace data</p>
        <h1>Data deletion</h1>
        <p>
          Signed-in sole workspace owners can start a verified deletion request
          from Settings. The request requires the current password and the exact
          phrase
          <strong className="code-text"> DELETE MY ACCOUNT</strong>.
        </p>
        <div className="button-row">
          <Link className={buttonClass("danger")} href="/app/settings?tab=data">
            Open deletion settings
          </Link>
          <Link
            className={buttonClass("secondary")}
            href="/auth/login?returnTo=%2Fapp%2Fsettings%3Ftab%3Ddata">
            Log in first
          </Link>
        </div>
        <h2>What the request does</h2>
        <ol>
          <li>
            Closes active VidRelay sessions and stops pending local publishing
            work.
          </li>
          <li>Attempts to revoke connected provider credentials.</li>
          <li>
            Asynchronously removes the workspace’s stored media and account
            records.
          </li>
          <li>
            Provides a private reference so you can check the request after
            logout.
          </li>
        </ol>
        <h2>What it does not do</h2>
        <p>
          Deleting VidRelay data does not delete videos already published to an
          external provider. Delete those posts in Facebook, Instagram, YouTube,
          or TikTok directly. Provider revocation can also fail when a provider
          is unavailable; you can independently revoke VidRelay from the
          provider’s security settings.
        </p>
        <DataDeletionLookup />
      </div>
    </PublicShell>
  );
}
