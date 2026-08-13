"use client";

import Link from "next/link";

import type { ReactNode } from "react";

import { useSession } from "@/providers/SessionProvider";

import { Brand } from "./Brand";
import { buttonClass } from "./ui";

function PublicHeader() {
  const { config, status } = useSession();
  return (
    <header className="public-header">
      <Brand />
      <nav aria-label="Primary" className="public-nav">
        <Link className="public-nav-link" href="/#how-it-works">
          How it works
        </Link>
        {status === "authenticated" ? (
          <Link className={buttonClass("primary", { small: true })} href="/app">
            Open app
          </Link>
        ) : (
          <>
            <Link className="public-nav-link" href="/auth/login">
              Log in
            </Link>
            {config?.signupsEnabled === true ? (
              <Link
                className={buttonClass("primary", { small: true })}
                href="/auth/signup">
                Start publishing
              </Link>
            ) : null}
          </>
        )}
      </nav>
    </header>
  );
}

function PublicFooter() {
  return (
    <footer className="public-footer">
      <Brand />
      <nav aria-label="Legal" className="public-nav">
        <Link className="public-nav-link" href="/privacy">
          Privacy
        </Link>
        <Link className="public-nav-link" href="/terms">
          Terms
        </Link>
        <Link className="public-nav-link" href="/data-deletion">
          Data deletion
        </Link>
      </nav>
      <span>© {new Date().getFullYear()} VidRelay</span>
    </footer>
  );
}

export function PublicShell({ children }: { children: ReactNode }) {
  return (
    <div className="public-shell">
      <div className="container">
        <PublicHeader />
        <main id="main-content">{children}</main>
        <PublicFooter />
      </div>
    </div>
  );
}
