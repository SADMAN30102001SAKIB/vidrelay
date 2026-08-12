"use client";

import { platformLabels, platforms } from "@vidrelay/shared";
import { ExternalLink, RefreshCw, Unplug } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";

import type { Capability, Connection, Platform } from "@vidrelay/shared";

import {
  Button,
  EmptyState,
  ErrorState,
  LoadingState,
  Notice,
  PageHeader,
  PlatformMark,
  StatusBadge
} from "@/components/ui";
import { apiRequest, apiUrl, errorMessage } from "@/lib/api";
import { capabilityStatusView, connectionStatusView } from "@/lib/status";
import { useSession } from "@/providers/SessionProvider";

const oauthMessages: Record<
  string,
  { copy: string; tone: "danger" | "success" | "warning" }
> = {
  connected: { copy: "The provider connection was saved.", tone: "success" },
  denied: {
    copy: "Authorization was cancelled on the provider screen.",
    tone: "warning"
  },
  failed: {
    copy: "The provider could not complete authorization. Try again.",
    tone: "danger"
  },
  invalid_state: {
    copy: "The authorization session expired or was already used. Start again.",
    tone: "danger"
  },
  no_eligible_accounts: {
    copy: "Authorization succeeded, but no eligible publishing account was returned.",
    tone: "warning"
  }
};

function ConnectionsContent() {
  const { config } = useSession();
  const searchParams = useSearchParams();
  const [connections, setConnections] = useState<Connection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actingId, setActingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const body = await apiRequest<{ connections: Connection[] }>(
        "/api/connections"
      );
      setConnections(body.connections);
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void apiRequest<{ connections: Connection[] }>("/api/connections")
      .then(body => {
        if (!cancelled) {
          setConnections(body.connections);
          setError(null);
        }
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setError(errorMessage(caught));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const startOAuth = (platform: Platform) => {
    window.location.assign(
      apiUrl(
        `/api/oauth/${platform}/start?returnTo=${encodeURIComponent("/app/connections")}`
      )
    );
  };

  const checkConnection = async (id: string) => {
    setActingId(id);
    setError(null);
    try {
      const body = await apiRequest<{ connection: Connection }>(
        `/api/connections/${id}/check`,
        {
          method: "POST"
        }
      );
      setConnections(current =>
        current.map(connection =>
          connection.id === id ? body.connection : connection
        )
      );
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setActingId(null);
    }
  };

  const disconnect = async (connection: Connection) => {
    if (
      !window.confirm(
        `Disconnect ${connection.displayName}? VidRelay will attempt to revoke its provider access.`
      )
    ) {
      return;
    }
    setActingId(connection.id);
    setError(null);
    try {
      await apiRequest<unknown>(`/api/connections/${connection.id}`, {
        method: "DELETE"
      });
      await load();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setActingId(null);
    }
  };

  if (loading) {
    return <LoadingState label="Loading connected accounts…" />;
  }
  if (error !== null && connections.length === 0) {
    return (
      <ErrorState
        action={<Button onClick={() => void load()}>Try again</Button>}
        description={error}
      />
    );
  }

  const oauthResult = searchParams.get("result");
  const oauthNotice =
    oauthResult === null ? undefined : oauthMessages[oauthResult];
  const provider = searchParams.get("provider");
  const count = searchParams.get("count");

  return (
    <div className="stack">
      <PageHeader
        description="Provider login happens through OAuth. VidRelay never asks for a social password."
        eyebrow="Destinations"
        title="Connections"
      />
      {oauthNotice === undefined ? null : (
        <Notice tone={oauthNotice.tone}>
          {provider === null ? "" : `${provider}: `}
          {oauthNotice.copy}
          {oauthResult === "connected" && count !== null
            ? ` ${count} account(s) discovered.`
            : ""}
        </Notice>
      )}
      {error === null ? null : <Notice tone="danger">{error}</Notice>}

      <div className="connection-grid">
        {platforms.map(platform => {
          const capability: Capability | undefined = config?.capabilities.find(
            item => item.platform === platform
          );
          const accounts = connections.filter(
            connection => connection.platform === platform
          );
          const canAuthorize =
            capability?.configured === true && capability.mode !== "disabled";
          return (
            <section className="connection-card stack" key={platform}>
              <div className="connection-title">
                <PlatformMark platform={platform} />
                <div className="connection-title-text">
                  <h2>{platformLabels[platform]}</h2>
                  <p>
                    {capability?.message ??
                      "Capability details are unavailable."}
                  </p>
                </div>
                {capability === undefined ? null : (
                  <StatusBadge {...capabilityStatusView(capability.mode)} />
                )}
              </div>

              {accounts.length === 0 ? (
                <EmptyState
                  description={`No ${platformLabels[platform]} publishing account is connected.`}
                  title="Not connected"
                />
              ) : (
                <div className="list">
                  {accounts.map(connection => {
                    const status = connectionStatusView(connection.status);
                    return (
                      <article
                        className="connection-account"
                        key={connection.id}>
                        <div className="avatar" aria-hidden="true">
                          {connection.displayName.slice(0, 2).toUpperCase()}
                        </div>
                        <div className="connection-title-text">
                          <h3>{connection.displayName}</h3>
                          <p className="code-text">
                            {connection.remoteAccountId}
                          </p>
                          {connection.lastError === null ? null : (
                            <p>{connection.lastError}</p>
                          )}
                        </div>
                        <StatusBadge {...status} />
                        <div className="button-row">
                          {connection.status === "reauth_required" ? (
                            <Button
                              onClick={() => startOAuth(platform)}
                              size="small"
                              variant="secondary">
                              <ExternalLink aria-hidden="true" size={15} />{" "}
                              Reconnect
                            </Button>
                          ) : (
                            <Button
                              busy={actingId === connection.id}
                              onClick={() =>
                                void checkConnection(connection.id)
                              }
                              size="small"
                              variant="ghost">
                              <RefreshCw aria-hidden="true" size={15} /> Check
                            </Button>
                          )}
                          <Button
                            busy={actingId === connection.id}
                            onClick={() => void disconnect(connection)}
                            size="small"
                            variant="danger">
                            <Unplug aria-hidden="true" size={15} /> Disconnect
                          </Button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
              <Button
                disabled={!canAuthorize}
                onClick={() => startOAuth(platform)}
                variant="secondary">
                <ExternalLink aria-hidden="true" size={16} />
                {accounts.length === 0 ? "Connect" : "Add another"}{" "}
                {platformLabels[platform]}
              </Button>
            </section>
          );
        })}
      </div>
    </div>
  );
}

export default function ConnectionsPage() {
  return (
    <Suspense fallback={<LoadingState label="Loading connected accounts…" />}>
      <ConnectionsContent />
    </Suspense>
  );
}
