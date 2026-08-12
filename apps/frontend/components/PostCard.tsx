import { ArrowRight } from "lucide-react";
import Link from "next/link";

import type { Post } from "@vidrelay/shared";

import { formatDate, truncate } from "@/lib/format";
import { postStatusView } from "@/lib/status";

import { PlatformMark, StatusBadge } from "./ui";

export function PostCard({
  post,
  timezone
}: {
  post: Post;
  timezone?: string | undefined;
}) {
  const status = postStatusView(post.status);
  return (
    <Link
      className="post-card"
      href={`/app/posts/detail?id=${encodeURIComponent(post.id)}`}>
      <div className="stack">
        <div className="cluster">
          <StatusBadge {...status} />
          <span className="post-meta">
            {formatDate(post.createdAt, timezone)}
          </span>
        </div>
        <p className="post-caption">
          {post.sharedCaption.trim() === ""
            ? "Untitled video post"
            : truncate(post.sharedCaption)}
        </p>
        <div className="cluster" aria-label="Destinations">
          {post.destinations.map(destination => (
            <PlatformMark
              announce
              key={destination.id}
              platform={destination.platform}
            />
          ))}
        </div>
      </div>
      <ArrowRight aria-hidden="true" size={20} />
    </Link>
  );
}
