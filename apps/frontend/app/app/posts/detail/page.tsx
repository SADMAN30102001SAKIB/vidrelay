"use client";

import { ExternalLink, RefreshCw, RotateCcw, SearchCheck } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";

import type { Destination, Post } from "@vidrelay/shared";

import {
  Button,
  ErrorState,
  LoadingState,
  Notice,
  PageHeader,
  PlatformMark,
  StatusBadge,
  buttonClass
} from "@/components/ui";
import { apiRequest, apiUrl, errorMessage } from "@/lib/api";
import { formatDate, formatDuration, truncate } from "@/lib/format";
import {
  destinationIsActive,
  destinationStatusView,
  postStatusView
} from "@/lib/status";
import { useSession } from "@/providers/SessionProvider";

interface PublishAttempt {
  attemptNumber: number;
  destinationId: string;
  errorCode: string | null;
  errorMessage: string | null;
  finishedAt: number | null;
  stage: string;
  startedAt: number;
  status: string;
  updatedAt: number;
}

interface PostDetailResponse {
  attempts: PublishAttempt[];
  post: Post;
}

interface PreviewLease {
  expiresAt: number;
  id: string;
  url: string;
}

const retryable = (destination: Destination): boolean =>
  ["failed_permanent", "unavailable"].includes(destination.status);

function PostDetailContent() {
  const searchParams = useSearchParams();
  const id = searchParams.get("id");
  const oauthProvider = searchParams.get("provider");
  const oauthResult = searchParams.get("result");
  const { user } = useSession();
  const [detail, setDetail] = useState<PostDetailResponse | null>(null);
  const [lease, setLease] = useState<PreviewLease | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionId, setActionId] = useState<string | null>(null);
  const leaseUploadRef = useRef<string | null>(null);

  const loadPreview = useCallback(async (uploadId: string) => {
    if (leaseUploadRef.current === uploadId) {
      return;
    }
    leaseUploadRef.current = uploadId;
    try {
      const body = await apiRequest<{ lease: PreviewLease }>(
        `/api/uploads/${uploadId}/preview-lease`,
        { method: "POST" }
      );
      setLease(body.lease);
    } catch {
      leaseUploadRef.current = null;
    }
  }, []);

  const load = useCallback(async () => {
    await Promise.resolve();
    if (id === null || id.trim() === "") {
      setError("No post ID was provided.");
      setLoading(false);
      return;
    }
    try {
      const body = await apiRequest<PostDetailResponse>(
        `/api/posts/${encodeURIComponent(id)}`
      );
      setDetail(body);
      setError(null);
      void loadPreview(body.post.upload.id);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [id, loadPreview]);

  useEffect(() => {
    let cancelled = false;
    const request =
      id === null || id.trim() === ""
        ? Promise.reject(new Error("No post ID was provided."))
        : apiRequest<PostDetailResponse>(
            `/api/posts/${encodeURIComponent(id)}`
          );
    void request
      .then(body => {
        if (!cancelled) {
          setDetail(body);
          setError(null);
          void loadPreview(body.post.upload.id);
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
  }, [id, loadPreview]);

  const active =
    detail?.post.destinations.some(destination =>
      destinationIsActive(destination.status)
    ) ?? false;
  useEffect(() => {
    if (!active) {
      return;
    }
    const interval = window.setInterval(() => void load(), 4000);
    return () => window.clearInterval(interval);
  }, [active, load]);

  const requestAction = async (
    destination: Destination,
    action: "reconcile" | "retry"
  ) => {
    if (
      action === "reconcile" &&
      !window.confirm(
        "Request a provider-only reconciliation? This checks the uncertain outcome and does not blindly upload a duplicate."
      )
    ) {
      return;
    }
    setActionId(destination.id);
    setError(null);
    try {
      const acknowledgement =
        action === "retry" ? "retry_destination" : "reconcile_destination";
      const body = await apiRequest<{ post: Post }>(
        `/api/posts/${detail!.post.id}/destinations/${destination.id}/${action}`,
        { body: JSON.stringify({ acknowledgement }), method: "POST" }
      );
      setDetail(current =>
        current === null ? null : { ...current, post: body.post }
      );
      await load();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setActionId(null);
    }
  };

  const reconnect = (destination: Destination) => {
    const returnTo = `/app/posts/detail?id=${encodeURIComponent(detail!.post.id)}`;
    window.location.assign(
      apiUrl(
        `/api/oauth/${destination.platform}/start?returnTo=${encodeURIComponent(returnTo)}`
      )
    );
  };

  if (loading) {
    return <LoadingState label="Loading post evidence…" />;
  }
  if (detail === null) {
    return (
      <ErrorState
        action={
          <Link className={buttonClass("secondary")} href="/app/posts">
            Back to posts
          </Link>
        }
        description={error ?? "The post could not be found."}
        title="Post unavailable"
      />
    );
  }

  const { post, attempts } = detail;
  const postStatus = postStatusView(post.status);
  return (
    <div className="stack" aria-live={active ? "polite" : undefined}>
      <PageHeader
        action={
          <div className="button-row">
            <StatusBadge {...postStatus} />
            <Button
              busy={refreshing}
              onClick={() => {
                setRefreshing(true);
                void load();
              }}
              size="small"
              variant="secondary">
              <RefreshCw aria-hidden="true" size={15} /> Refresh
            </Button>
          </div>
        }
        description={`Submitted ${formatDate(post.submittedAt ?? post.createdAt, user?.workspace.timezone)}`}
        eyebrow="Post detail"
        title={
          post.sharedCaption.trim() === ""
            ? "Untitled video post"
            : truncate(post.sharedCaption, 120)
        }
      />
      {oauthResult === "connected" ? (
        <Notice tone="success">
          The {oauthProvider ?? "provider"} account was reconnected. Retry the
          affected destination to start a new attempt.
        </Notice>
      ) : null}
      {oauthResult !== null && oauthResult !== "connected" ? (
        <Notice tone="warning">
          The {oauthProvider ?? "provider"} reconnection did not complete. Start
          the connection flow again before retrying this destination.
        </Notice>
      ) : null}
      {active ? (
        <Notice tone="info">
          This page refreshes active destination states every four seconds.
        </Notice>
      ) : null}
      {post.status === "partial_success" ? (
        <Notice tone="warning">
          At least one destination published and at least one did not. Review
          each result before retrying.
        </Notice>
      ) : null}
      {error === null ? null : <Notice tone="danger">{error}</Notice>}

      <div className="detail-layout">
        <section className="panel stack" aria-labelledby="media-detail-heading">
          <div className="panel-header">
            <div>
              <h2 id="media-detail-heading">Verified media</h2>
              <p>{post.upload.filename}</p>
            </div>
          </div>
          {lease === null ? (
            <Notice tone="info">
              Preview could not be loaded. Publishing status is unaffected.
            </Notice>
          ) : (
            <video
              className="video-preview"
              controls
              playsInline
              preload="metadata"
              src={lease.url}>
              Your browser does not support video preview.
            </video>
          )}
          <div className="media-facts">
            <div className="media-fact">
              <span>Frame</span>
              <strong>
                {post.upload.width ?? "?"}×{post.upload.height ?? "?"}
              </strong>
            </div>
            <div className="media-fact">
              <span>Duration</span>
              <strong>
                {post.upload.durationMs === null
                  ? "Unknown"
                  : formatDuration(post.upload.durationMs / 1000)}
              </strong>
            </div>
            <div className="media-fact">
              <span>Video</span>
              <strong>{post.upload.videoCodec ?? "Unknown"}</strong>
            </div>
            <div className="media-fact">
              <span>Audio</span>
              <strong>{post.upload.audioCodec ?? "Unknown"}</strong>
            </div>
          </div>
        </section>

        <section className="panel stack" aria-labelledby="delivery-heading">
          <div className="panel-header">
            <div>
              <h2 id="delivery-heading">Destination delivery</h2>
              <p>Independent provider outcomes for this submission.</p>
            </div>
          </div>
          <div className="destination-timeline">
            {post.destinations.map(destination => {
              const status = destinationStatusView(destination.status);
              const destinationAttempts = attempts.filter(
                attempt => attempt.destinationId === destination.id
              );
              return (
                <article
                  className="destination-status-card stack"
                  key={destination.id}>
                  <div className="panel-header">
                    <div className="connection-title">
                      <PlatformMark announce platform={destination.platform} />
                      <div className="connection-title-text">
                        <h3>{destination.connectionDisplayName}</h3>
                        <p>{destination.stage.replaceAll("_", " ")}</p>
                      </div>
                    </div>
                    <StatusBadge {...status} />
                  </div>
                  {destination.lastError === null ? null : (
                    <Notice tone="danger">{destination.lastError}</Notice>
                  )}
                  {destination.nextPollAt === null ? null : (
                    <p className="post-meta">
                      Next provider check:{" "}
                      {formatDate(
                        destination.nextPollAt,
                        user?.workspace.timezone
                      )}
                    </p>
                  )}
                  <div className="button-row">
                    {destination.providerUrl === null ? null : (
                      <a
                        className={buttonClass("secondary", { small: true })}
                        href={destination.providerUrl}
                        rel="noreferrer"
                        target="_blank">
                        View on provider{" "}
                        <ExternalLink aria-hidden="true" size={14} />
                      </a>
                    )}
                    {retryable(destination) ||
                    (destination.status === "reauth_required" &&
                      oauthResult === "connected" &&
                      oauthProvider === destination.platform) ? (
                      <Button
                        busy={actionId === destination.id}
                        onClick={() => void requestAction(destination, "retry")}
                        size="small"
                        variant="secondary">
                        <RotateCcw aria-hidden="true" size={14} /> Retry
                        destination
                      </Button>
                    ) : null}
                    {destination.status === "reauth_required" &&
                    !(
                      oauthResult === "connected" &&
                      oauthProvider === destination.platform
                    ) ? (
                      <Button
                        onClick={() => reconnect(destination)}
                        size="small"
                        variant="secondary">
                        Reconnect account{" "}
                        <ExternalLink aria-hidden="true" size={14} />
                      </Button>
                    ) : null}
                    {destination.status === "reconciliation_required" ? (
                      <Button
                        busy={actionId === destination.id}
                        onClick={() =>
                          void requestAction(destination, "reconcile")
                        }
                        size="small"
                        variant="secondary">
                        <SearchCheck aria-hidden="true" size={14} /> Reconcile
                        outcome
                      </Button>
                    ) : null}
                  </div>
                  <details>
                    <summary>
                      Attempt history ({destinationAttempts.length})
                    </summary>
                    {destinationAttempts.length === 0 ? (
                      <p className="post-meta">
                        No attempt record is available yet.
                      </p>
                    ) : (
                      <ol className="timeline-list">
                        {destinationAttempts.map(attempt => (
                          <li
                            className="timeline-item"
                            key={`${attempt.destinationId}-${attempt.attemptNumber}`}>
                            <strong>
                              Attempt {attempt.attemptNumber}:{" "}
                              {attempt.status.replaceAll("_", " ")}
                            </strong>
                            <span>{attempt.stage.replaceAll("_", " ")}</span>
                            <span>
                              {formatDate(
                                attempt.updatedAt,
                                user?.workspace.timezone
                              )}
                            </span>
                            {attempt.errorMessage === null ? null : (
                              <span>{attempt.errorMessage}</span>
                            )}
                            {attempt.errorCode === null ? null : (
                              <code className="code-text">
                                {attempt.errorCode}
                              </code>
                            )}
                          </li>
                        ))}
                      </ol>
                    )}
                  </details>
                </article>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}

export default function PostDetailPage() {
  return (
    <Suspense fallback={<LoadingState label="Loading post evidence…" />}>
      <PostDetailContent />
    </Suspense>
  );
}
