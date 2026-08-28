"use client";

import { firstReleasePlatforms, platformLabels } from "@vidrelay/shared";

import type { Capability, Platform } from "@vidrelay/shared";

import { capabilityStatusView } from "@/lib/status";
import { useSession } from "@/providers/SessionProvider";

import { LoadingState, Notice, PlatformMark, StatusBadge } from "./ui";

const fallbackCapability = (platform: Platform): Capability => ({
  configured: false,
  message: "Live availability is loading.",
  mode: "disabled",
  platform
});

export function CapabilityOverview() {
  const { config, configError } = useSession();
  if (config === null && configError === null) {
    return <LoadingState label="Loading live platform modes…" />;
  }
  return (
    <div className="stack">
      {configError === null ? null : (
        <Notice tone="warning">
          Live capability details are temporarily unavailable.
        </Notice>
      )}
      <div className="connection-grid">
        {firstReleasePlatforms.map(platform => {
          const capability =
            config?.capabilities.find(item => item.platform === platform) ??
            fallbackCapability(platform);
          return (
            <article className="connection-card" key={platform}>
              <div className="connection-title">
                <PlatformMark platform={platform} />
                <div className="connection-title-text">
                  <h3>{platformLabels[platform]}</h3>
                  <p>{capability.message}</p>
                </div>
              </div>
              <StatusBadge {...capabilityStatusView(capability.mode)} />
            </article>
          );
        })}
      </div>
    </div>
  );
}
