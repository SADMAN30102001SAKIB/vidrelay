"use client";

import { ArrowRight, Cable, Send, UploadCloud } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import type { Connection, Post } from "@vidrelay/shared";

import { PostCard } from "@/components/PostCard";
import {
  Button,
  EmptyState,
  ErrorState,
  LoadingState,
  Notice,
  PageHeader,
  buttonClass
} from "@/components/ui";
import { apiRequest, errorMessage } from "@/lib/api";
import { destinationIsActive } from "@/lib/status";
import { useSession } from "@/providers/SessionProvider";

export default function DashboardPage() {
  const { config, configError, user } = useSession();
  const [connections, setConnections] = useState<Connection[]>([]);
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        const [connectionBody, postBody] = await Promise.all([
          apiRequest<{ connections: Connection[] }>("/api/connections"),
          apiRequest<{ items: Post[]; nextCursor: string | null }>("/api/posts")
        ]);
        setConnections(connectionBody.connections);
        setPosts(postBody.items);
      } catch (caught) {
        setError(errorMessage(caught));
      } finally {
        setLoading(false);
      }
    };
    void load();
  }, []);

  if (loading) {
    return <LoadingState label="Loading your workspace…" />;
  }
  if (error !== null) {
    return (
      <ErrorState
        action={
          <Button onClick={() => window.location.reload()}>Try again</Button>
        }
        description={error}
      />
    );
  }

  const connected = connections.filter(
    connection => connection.status === "connected"
  ).length;
  const active = posts.filter(post =>
    post.destinations.some(destination =>
      destinationIsActive(destination.status)
    )
  ).length;
  const published = posts.filter(post => post.status === "published").length;

  return (
    <div className="stack">
      <PageHeader
        action={
          <Link className={buttonClass("primary")} href="/app/create">
            <Send aria-hidden="true" size={17} />
            Create post
          </Link>
        }
        description="A live view of account readiness and recent destination results."
        eyebrow="Workspace overview"
        title={`Welcome, ${user?.name.split(" ")[0] ?? "publisher"}`}
      />

      {configError === null ? null : (
        <Notice tone="warning">
          Platform capability details could not be refreshed.
        </Notice>
      )}
      {config?.capabilities.some(
        capability => capability.mode !== "direct_publish"
      ) === true ? (
        <Notice tone="info">
          Some providers are restricted by configuration, app review, or privacy
          mode. Create Post will show the exact limitation before submission.
        </Notice>
      ) : null}

      <div className="metric-grid">
        <article className="metric-card">
          <Cable aria-hidden="true" size={20} />
          <span className="metric-value">{connected}</span>
          <span className="metric-label">Connected destinations</span>
        </article>
        <article className="metric-card">
          <UploadCloud aria-hidden="true" size={20} />
          <span className="metric-value">{active}</span>
          <span className="metric-label">Posts in progress</span>
        </article>
        <article className="metric-card">
          <Send aria-hidden="true" size={20} />
          <span className="metric-value">{published}</span>
          <span className="metric-label">
            Fully published in recent history
          </span>
        </article>
      </div>

      <div className="dashboard-grid">
        <section className="panel" aria-labelledby="recent-posts-heading">
          <div className="panel-header">
            <div>
              <h2 id="recent-posts-heading">Recent posts</h2>
              <p>Latest provider-confirmed states.</p>
            </div>
            <Link className="text-link" href="/app/posts">
              View all <ArrowRight aria-hidden="true" size={15} />
            </Link>
          </div>
          {posts.length === 0 ? (
            <EmptyState
              action={
                <Link className={buttonClass("primary")} href="/app/create">
                  Create your first post
                </Link>
              }
              description="Upload a video and choose at least one connected destination."
              title="No posts yet"
            />
          ) : (
            <div className="post-list">
              {posts.slice(0, 4).map(post => (
                <PostCard
                  key={post.id}
                  post={post}
                  timezone={user?.workspace.timezone}
                />
              ))}
            </div>
          )}
        </section>

        <section className="panel" aria-labelledby="readiness-heading">
          <div className="panel-header">
            <div>
              <h2 id="readiness-heading">Publishing readiness</h2>
              <p>Connected account health.</p>
            </div>
          </div>
          {connections.length === 0 ? (
            <EmptyState
              action={
                <Link
                  className={buttonClass("secondary")}
                  href="/app/connections">
                  Connect an account
                </Link>
              }
              description="Provider authorization always happens on the provider’s OAuth screen."
              title="No destinations connected"
            />
          ) : (
            <div className="list">
              {connections.slice(0, 6).map(connection => (
                <div className="list-row" key={connection.id}>
                  <div>
                    <strong>{connection.displayName}</strong>
                    <p className="post-meta">{connection.platform}</p>
                  </div>
                  <span
                    className={`status-badge status-${connection.status === "connected" ? "success" : "warning"}`}>
                    {connection.status.replaceAll("_", " ")}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
