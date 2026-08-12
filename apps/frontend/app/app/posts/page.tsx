"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { Post, PostStatus } from "@vidrelay/shared";

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
import { useSession } from "@/providers/SessionProvider";

type Filter = "all" | PostStatus;

export default function PostsPage() {
  const { user } = useSession();
  const [posts, setPosts] = useState<Post[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (cursor?: string) => {
    const more = cursor !== undefined;
    try {
      const body = await apiRequest<{
        items: Post[];
        nextCursor: string | null;
      }>(
        cursor === undefined
          ? "/api/posts"
          : `/api/posts?cursor=${encodeURIComponent(cursor)}`
      );
      setPosts(current => (more ? [...current, ...body.items] : body.items));
      setNextCursor(body.nextCursor);
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void apiRequest<{ items: Post[]; nextCursor: string | null }>("/api/posts")
      .then(body => {
        if (!cancelled) {
          setPosts(body.items);
          setNextCursor(body.nextCursor);
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

  const visible = useMemo(
    () =>
      filter === "all" ? posts : posts.filter(post => post.status === filter),
    [filter, posts]
  );

  if (loading) {
    return <LoadingState label="Loading publishing history…" />;
  }
  if (error !== null && posts.length === 0) {
    return (
      <ErrorState
        action={<Button onClick={() => void load()}>Try again</Button>}
        description={error}
      />
    );
  }

  return (
    <div className="stack">
      <PageHeader
        action={
          <Link className={buttonClass("primary")} href="/app/create">
            Create post
          </Link>
        }
        description="Each card reflects the aggregate result; open it for destination-level evidence."
        eyebrow="Publishing history"
        title="Posts"
      />
      {error === null ? null : <Notice tone="danger">{error}</Notice>}
      <div className="filters">
        <label className="field-label" htmlFor="post-status-filter">
          Status
        </label>
        <select
          className="select"
          id="post-status-filter"
          onChange={event => setFilter(event.target.value as Filter)}
          value={filter}>
          <option value="all">All statuses</option>
          <option value="publishing">Publishing</option>
          <option value="published">Published</option>
          <option value="partial_success">Partial success</option>
          <option value="failed">Failed</option>
          <option value="cancelled">Cancelled</option>
        </select>
      </div>
      {visible.length === 0 ? (
        <EmptyState
          action={
            posts.length === 0 ? (
              <Link className={buttonClass("primary")} href="/app/create">
                Create your first post
              </Link>
            ) : undefined
          }
          description={
            posts.length === 0
              ? "Your submitted posts will appear here."
              : "No loaded post matches this filter."
          }
          title={posts.length === 0 ? "No posts yet" : "No matching posts"}
        />
      ) : (
        <div className="post-list">
          {visible.map(post => (
            <PostCard
              key={post.id}
              post={post}
              timezone={user?.workspace.timezone}
            />
          ))}
        </div>
      )}
      {nextCursor === null ? null : (
        <Button
          busy={loadingMore}
          onClick={() => {
            setLoadingMore(true);
            void load(nextCursor);
          }}
          variant="secondary">
          Load older posts
        </Button>
      )}
    </div>
  );
}
