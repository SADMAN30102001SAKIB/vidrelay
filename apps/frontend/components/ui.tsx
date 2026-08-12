import { AlertCircle, CheckCircle2, Info, LoaderCircle } from "lucide-react";
import { clsx } from "clsx";

import { platformLabels } from "@vidrelay/shared";
import type { Platform } from "@vidrelay/shared";
import type { ButtonHTMLAttributes, ReactNode } from "react";

import type { StatusTone } from "@/lib/status";

export const buttonClass = (
  variant: "danger" | "ghost" | "primary" | "secondary" = "primary",
  options?: { small?: boolean; wide?: boolean }
): string =>
  clsx(
    "button",
    `button-${variant}`,
    options?.small && "button-small",
    options?.wide && "button-wide"
  );

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  busy?: boolean;
  children: ReactNode;
  size?: "default" | "small";
  variant?: "danger" | "ghost" | "primary" | "secondary";
  wide?: boolean;
}

export function Button({
  busy = false,
  children,
  className,
  disabled,
  size = "default",
  variant = "primary",
  wide = false,
  ...props
}: ButtonProps) {
  return (
    <button
      aria-busy={busy || undefined}
      className={clsx(
        buttonClass(variant, { small: size === "small", wide }),
        className
      )}
      disabled={disabled === true || busy}
      {...props}>
      {busy ? (
        <LoaderCircle aria-hidden="true" className="spinner" size={16} />
      ) : null}
      {children}
    </button>
  );
}

export function Notice({
  children,
  title,
  tone = "info"
}: {
  children: ReactNode;
  title?: string;
  tone?: "danger" | "info" | "success" | "warning";
}) {
  const Icon =
    tone === "success" ? CheckCircle2 : tone === "danger" ? AlertCircle : Info;
  return (
    <div
      aria-live={tone === "danger" ? "assertive" : "polite"}
      className={`notice notice-${tone}`}
      role={tone === "danger" ? "alert" : "status"}>
      <Icon aria-hidden="true" size={19} />
      <div>
        {title === undefined ? null : <strong>{title}</strong>}
        <p>{children}</p>
      </div>
    </div>
  );
}

export function StatusBadge({
  label,
  tone
}: {
  label: string;
  tone: StatusTone;
}) {
  return <span className={`status-badge status-${tone}`}>{label}</span>;
}

export function PlatformMark({
  announce = false,
  platform
}: {
  announce?: boolean;
  platform: Platform;
}) {
  const letters: Record<Platform, string> = {
    facebook: "f",
    instagram: "ig",
    tiktok: "tt",
    youtube: "yt"
  };
  return (
    <span
      aria-hidden={announce ? undefined : true}
      aria-label={announce ? platformLabels[platform] : undefined}
      className={`platform-mark platform-${platform}`}
      role={announce ? "img" : undefined}>
      {letters[platform]}
    </span>
  );
}

function StateFrame({
  children,
  className,
  description,
  title
}: {
  children?: ReactNode;
  className: string;
  description: string;
  title: string;
}) {
  return (
    <div className={className}>
      <div className="state-content">
        <h2>{title}</h2>
        <p>{description}</p>
        {children}
      </div>
    </div>
  );
}

export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return (
    <div aria-live="polite" className="loading-state" role="status">
      <LoaderCircle aria-hidden="true" className="spinner" size={24} />
      <span>{label}</span>
    </div>
  );
}

export function EmptyState({
  action,
  description,
  title
}: {
  action?: ReactNode;
  description: string;
  title: string;
}) {
  return (
    <StateFrame className="empty-state" description={description} title={title}>
      {action}
    </StateFrame>
  );
}

export function ErrorState({
  action,
  description = "Please try again.",
  title = "We couldn’t load this page"
}: {
  action?: ReactNode;
  description?: string;
  title?: string;
}) {
  return (
    <StateFrame className="error-state" description={description} title={title}>
      {action}
    </StateFrame>
  );
}

export function PageHeader({
  action,
  description,
  eyebrow,
  title
}: {
  action?: ReactNode;
  description?: string;
  eyebrow?: string;
  title: string;
}) {
  return (
    <header className="page-header">
      <div>
        {eyebrow === undefined ? null : <p className="eyebrow">{eyebrow}</p>}
        <h1 className="page-title">{title}</h1>
        {description === undefined ? null : (
          <p className="page-subtitle">{description}</p>
        )}
      </div>
      {action}
    </header>
  );
}
