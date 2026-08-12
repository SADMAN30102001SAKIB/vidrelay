import Link from "next/link";

import type { ReactNode } from "react";

import { Brand } from "./Brand";

export function AuthFrame({
  children,
  heading,
  subheading
}: {
  children: ReactNode;
  heading: string;
  subheading: string;
}) {
  return (
    <div className="auth-shell">
      <aside className="auth-aside">
        <div className="auth-aside-copy">
          <Brand />
          <h1>One upload. Every connected destination.</h1>
          <p>
            Keep each channel’s publishing controls visible, then follow every
            destination from transfer to provider confirmation.
          </p>
        </div>
      </aside>
      <main className="auth-main" id="main-content">
        <div className="auth-card">
          <Brand />
          <div>
            <h1>{heading}</h1>
            <p className="page-subtitle">{subheading}</p>
          </div>
          {children}
          <p className="form-help">
            <Link className="text-link" href="/">
              Return to VidRelay
            </Link>
          </p>
        </div>
      </main>
    </div>
  );
}
