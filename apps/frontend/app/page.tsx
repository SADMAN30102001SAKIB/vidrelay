"use client";

import { firstReleasePlatforms, platformLabels } from "@vidrelay/shared";
import { Cable, ListChecks, Send, UploadCloud } from "lucide-react";
import Link from "next/link";

import type { LucideIcon } from "lucide-react";

import { CapabilityOverview } from "@/components/CapabilityOverview";
import { PublicShell } from "@/components/PublicChrome";
import { PlatformMark, StatusBadge, buttonClass } from "@/components/ui";
import { capabilityStatusView } from "@/lib/status";
import type { StatusView } from "@/lib/status";
import { useSession } from "@/providers/SessionProvider";

const features: Array<{ copy: string; icon: LucideIcon; title: string }> = [
  {
    copy: "Authorize only through each platform’s official OAuth flow.",
    icon: Cable,
    title: "Connect accounts"
  },
  {
    copy: "Check size, duration, dimensions, and the server-inspected codecs before publishing.",
    icon: UploadCloud,
    title: "Preflight once"
  },
  {
    copy: "Set privacy, captions, audience, disclosure, and interaction controls explicitly.",
    icon: Send,
    title: "Compose per platform"
  },
  {
    copy: "See published, retryable, reauthorization, and reconciliation states separately.",
    icon: ListChecks,
    title: "Track every result"
  }
];

export default function HomePage() {
  const { config, configError } = useSession();
  return (
    <PublicShell>
      <section className="hero">
        <div>
          <p className="eyebrow">Cross-platform video publishing</p>
          <h1 className="display-title">
            Publish once.{" "}
            <span className="gradient-word">
              Know what happened everywhere.
            </span>
          </h1>
          <p className="hero-copy">
            Upload one vertical MP4, choose your connected accounts, and keep
            every platform’s required controls and delivery status in one place.
          </p>
          <div className="button-row">
            {config?.signupsEnabled === true ? (
              <Link className={buttonClass("primary")} href="/auth/signup">
                Create an account
              </Link>
            ) : null}
            <Link className={buttonClass("secondary")} href="/auth/login">
              Log in
            </Link>
          </div>
        </div>
        <div
          aria-label="First-release platform availability"
          className="hero-panel">
          <div className="hero-panel-inner">
            <div className="mock-video">
              <UploadCloud aria-hidden="true" size={36} />
              <span>vertical-story.mp4</span>
              <StatusBadge label="Preflight passed" tone="success" />
            </div>
            <div className="destination-stack">
              {firstReleasePlatforms.map(platform => {
                const capability = config?.capabilities.find(
                  item => item.platform === platform
                );
                const status: StatusView =
                  capability !== undefined
                    ? capabilityStatusView(capability.mode)
                    : config === null && configError === null
                      ? { label: "Checking", tone: "info" }
                      : { label: "Unavailable", tone: "warning" };
                return (
                  <div className="destination-row" key={platform}>
                    <PlatformMark platform={platform} />
                    <span>{platformLabels[platform]}</span>
                    <StatusBadge {...status} />
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </section>

      <section className="section" id="how-it-works">
        <div className="section-heading">
          <p className="eyebrow">A controlled publishing flow</p>
          <h2>Four steps, with no hidden platform assumptions</h2>
          <p>
            VidRelay validates the shared media envelope, then preserves the
            controls each destination requires.
          </p>
        </div>
        <div className="feature-grid">
          {features.map(feature => {
            const Icon = feature.icon;
            return (
              <article className="feature-card" key={feature.title}>
                <span className="icon-box">
                  <Icon aria-hidden="true" size={21} />
                </span>
                <h3>{feature.title}</h3>
                <p>{feature.copy}</p>
              </article>
            );
          })}
        </div>
      </section>

      <section className="section" aria-labelledby="availability-heading">
        <div className="section-heading">
          <p className="eyebrow">Live service capability</p>
          <h2 id="availability-heading">
            Availability is disclosed, not simulated
          </h2>
          <p>
            Provider access can depend on credentials, app review, test-account
            limits, and privacy restrictions. The service reports its current
            mode below.
          </p>
        </div>
        <CapabilityOverview />
      </section>
    </PublicShell>
  );
}
