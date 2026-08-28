"use client";

import {
  CheckCircle2,
  ExternalLink,
  RefreshCw,
  RotateCcw,
  SearchCheck,
  Trash2,
  XCircle
} from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";

import { platformLabels, resolveDestinationSchema } from "@vidrelay/shared";
import type { Destination, Post } from "@vidrelay/shared";
import type { FormEvent } from "react";

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

const abandonable = (destination: Destination): boolean =>
  [
    "awaiting_user_action",
    "blocked",
    "failed_permanent",
    "unavailable"
  ].includes(destination.status);

type ManualResolution =
  | {
      acknowledgement: "I CHECKED THE PROVIDER";
      outcome: "not_published";
    }
  | {
      acknowledgement: "I CHECKED THE PROVIDER";
      outcome: "published";
      providerPostId?: string;
      providerUrl?: string;
    };

function ManualResolutionControls({
  busy,
  destination,
  onResolve
}: {
  busy: boolean;
  destination: Destination;
  onResolve: (input: ManualResolution) => Promise<void>;
}) {
  const [acknowledgement, setAcknowledgement] = useState("");
  const [providerPostId, setProviderPostId] = useState("");
  const [providerUrl, setProviderUrl] = useState("");
  const acknowledged = acknowledgement === "I CHECKED THE PROVIDER";
  const providerName = platformLabels[destination.platform];

  const confirmNotPublished = () => {
    if (
      !acknowledged ||
      !window.confirm(
        `Confirm that you personally inspected the connected ${providerName} account and this video was not published? This makes a new retry available and could create a duplicate if the post actually exists.`
      )
    ) {
      return;
    }
    void onResolve({
      acknowledgement: "I CHECKED THE PROVIDER",
      outcome: "not_published"
    });
  };

  const confirmPublished = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (
      !acknowledged ||
      !window.confirm(
        `Confirm that you personally found this video published in the connected ${providerName} account? VidRelay will record this destination as published and will not upload it again.`
      )
    ) {
      return;
    }
    void onResolve({
      acknowledgement: "I CHECKED THE PROVIDER",
      outcome: "published",
      ...(providerPostId.trim() === ""
        ? {}
        : { providerPostId: providerPostId.trim() }),
      ...(providerUrl.trim() === "" ? {} : { providerUrl: providerUrl.trim() })
    });
  };

  return (
    <div className="stack">
      <Notice title="Manual provider check required" tone="warning">
        VidRelay has no reliable provider identifier for this attempt. Open the
        connected {providerName} account separately and inspect its posts for
        this exact video. Do not choose an outcome from memory or guesswork.
      </Notice>
      <div className="field">
        <label htmlFor={`manual-acknowledgement-${destination.id}`}>
          Type I CHECKED THE PROVIDER to unlock these actions
        </label>
        <input
          autoComplete="off"
          className="input"
          id={`manual-acknowledgement-${destination.id}`}
          onChange={event => setAcknowledgement(event.target.value)}
          spellCheck={false}
          value={acknowledgement}
        />
      </div>
      <Button
        disabled={!acknowledged || busy}
        onClick={confirmNotPublished}
        size="small"
        type="button"
        variant="secondary">
        <XCircle aria-hidden="true" size={14} /> Confirm not published
      </Button>
      <form className="stack" onSubmit={confirmPublished}>
        <div className="field">
          <label htmlFor={`provider-post-id-${destination.id}`}>
            Provider post ID (optional published evidence)
          </label>
          <input
            autoComplete="off"
            className="input"
            id={`provider-post-id-${destination.id}`}
            maxLength={256}
            onChange={event => setProviderPostId(event.target.value)}
            value={providerPostId}
          />
        </div>
        <div className="field">
          <label htmlFor={`provider-post-url-${destination.id}`}>
            Provider post URL (optional published evidence)
          </label>
          <input
            autoComplete="url"
            className="input"
            id={`provider-post-url-${destination.id}`}
            onChange={event => setProviderUrl(event.target.value)}
            placeholder="https://…"
            type="url"
            value={providerUrl}
          />
        </div>
        <Button
          busy={busy}
          disabled={!acknowledged}
          size="small"
          type="submit"
          variant="danger">
          <CheckCircle2 aria-hidden="true" size={14} /> Confirm published
        </Button>
      </form>
    </div>
  );
}

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
  const [removingSource, setRemovingSource] = useState(false);
  const leaseUploadRef = useRef<string | null>(null);
  const leaseRef = useRef<PreviewLease | null>(null);
  const previewGenerationRef = useRef(0);
  const loadGenerationRef = useRef(0);

  const loadPreview = useCallback(async (uploadId: string) => {
    if (
      leaseUploadRef.current === uploadId &&
      leaseRef.current !== null &&
      leaseRef.current.expiresAt > Date.now() + 60_000
    ) {
      return;
    }
    const generation = previewGenerationRef.current + 1;
    previewGenerationRef.current = generation;
    leaseUploadRef.current = uploadId;
    try {
      const body = await apiRequest<{ lease: PreviewLease }>(
        `/api/uploads/${uploadId}/preview-lease`,
        { method: "POST" }
      );
      if (previewGenerationRef.current === generation) {
        leaseRef.current = body.lease;
        setLease(body.lease);
      }
    } catch {
      if (previewGenerationRef.current === generation) {
        leaseUploadRef.current = null;
        leaseRef.current = null;
        setLease(null);
      }
    }
  }, []);

  const load = useCallback(async () => {
    const generation = loadGenerationRef.current + 1;
    loadGenerationRef.current = generation;
    const isCurrent = (): boolean => loadGenerationRef.current === generation;
    await Promise.resolve();
    if (id === null || id.trim() === "") {
      if (isCurrent()) {
        setError("No post ID was provided.");
        setLoading(false);
        setRefreshing(false);
      }
      return;
    }
    try {
      const body = await apiRequest<PostDetailResponse>(
        `/api/posts/${encodeURIComponent(id)}`
      );
      if (!isCurrent()) {
        return;
      }
      setDetail(body);
      setError(null);
      if (body.post.upload.status === "ready") {
        void loadPreview(body.post.upload.id);
      } else {
        previewGenerationRef.current += 1;
        setLease(null);
        leaseRef.current = null;
        leaseUploadRef.current = null;
      }
    } catch (caught) {
      if (isCurrent()) {
        setError(errorMessage(caught));
      }
    } finally {
      if (isCurrent()) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [id, loadPreview]);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void load(), 0);
    return () => {
      window.clearTimeout(initialLoad);
      loadGenerationRef.current += 1;
      previewGenerationRef.current += 1;
    };
  }, [load]);

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

  const resolveManually = async (
    destination: Destination,
    input: ManualResolution
  ) => {
    const parsed = resolveDestinationSchema.safeParse(input);
    if (!parsed.success) {
      setError("Review the manual provider evidence before continuing.");
      return;
    }
    setActionId(destination.id);
    setError(null);
    try {
      const body = await apiRequest<{ post: Post }>(
        `/api/posts/${detail!.post.id}/destinations/${destination.id}/resolve`,
        { body: JSON.stringify(parsed.data), method: "POST" }
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

  const abandonDestination = async (destination: Destination) => {
    if (
      !window.confirm(
        `Stop all future retries for ${platformLabels[destination.platform]}? This does not delete a provider post. Only choose this after the outcome is known.`
      )
    ) {
      return;
    }
    setActionId(destination.id);
    setError(null);
    try {
      const body = await apiRequest<{ post: Post }>(
        `/api/posts/${detail!.post.id}/destinations/${destination.id}/abandon`,
        {
          body: JSON.stringify({ acknowledgement: "abandon_destination" }),
          method: "POST"
        }
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

  const removeSource = async () => {
    if (
      !window.confirm(
        "Permanently remove this source video from VidRelay storage? Published provider posts and delivery history remain, but preview and future retries become unavailable."
      )
    ) {
      return;
    }
    setRemovingSource(true);
    setError(null);
    try {
      await apiRequest<unknown>(
        `/api/uploads/${encodeURIComponent(detail!.post.upload.id)}`,
        { method: "DELETE" }
      );
      setLease(null);
      leaseUploadRef.current = null;
      await load();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setRemovingSource(false);
    }
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
  const sourceRemovable =
    post.upload.status === "ready" && post.sourceRemovalEligible;
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
              <h2 id="media-detail-heading">Preflighted media</h2>
              <p>{post.upload.filename}</p>
            </div>
          </div>
          {post.upload.status === "aborted" ? (
            post.upload.storageDeletedAt === null ? (
              <Notice tone="warning">
                Source removal is pending. VidRelay will retry storage cleanup;
                quota is released only after deletion is confirmed.
              </Notice>
            ) : (
              <Notice tone="success">
                The source video was removed from VidRelay storage. Provider
                posts, destination outcomes, and attempt history remain.
              </Notice>
            )
          ) : lease === null ? (
            <Notice tone="info">
              Preview could not be loaded. Publishing status is unaffected.
            </Notice>
          ) : (
            <video
              className="video-preview"
              controls
              onError={() => {
                leaseUploadRef.current = null;
                leaseRef.current = null;
                setLease(null);
              }}
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
          {sourceRemovable ? (
            <div className="stack stack-tight">
              <Notice tone="warning">
                All destinations are published or cancelled. You can release
                storage without deleting provider posts or delivery history.
              </Notice>
              <Button
                busy={removingSource}
                onClick={() => void removeSource()}
                size="small"
                type="button"
                variant="danger">
                <Trash2 aria-hidden="true" size={14} /> Remove source video
              </Button>
            </div>
          ) : null}
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
                    {destination.status === "reconciliation_required" &&
                    destination.reconciliationMode === "automatic" ? (
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
                    {abandonable(destination) ? (
                      <Button
                        busy={actionId === destination.id}
                        onClick={() => void abandonDestination(destination)}
                        size="small"
                        variant="danger">
                        <XCircle aria-hidden="true" size={14} /> Abandon future
                        retries
                      </Button>
                    ) : null}
                  </div>
                  {destination.status === "reconciliation_required" &&
                  destination.reconciliationMode === "manual" ? (
                    <ManualResolutionControls
                      busy={actionId === destination.id}
                      destination={destination}
                      onResolve={input => resolveManually(destination, input)}
                    />
                  ) : null}
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
