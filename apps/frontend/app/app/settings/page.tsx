"use client";

import {
  changePasswordSchema,
  deleteAccountSchema,
  updateProfileSchema
} from "@vidrelay/shared";
import { Check, Copy, KeyRound, LogOut, Save, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { clsx } from "clsx";

import type { DeletionView, User } from "@vidrelay/shared";
import type { FormEvent } from "react";

import {
  Button,
  LoadingState,
  Notice,
  PageHeader,
  StatusBadge,
  buttonClass
} from "@/components/ui";
import { apiRequest, errorMessage } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { useSession } from "@/providers/SessionProvider";

type SettingsTab = "data" | "profile" | "security";

interface AccountSession {
  createdAt: number;
  current: boolean;
  expiresAt: number;
  id: string;
  lastSeenAt: number;
  userAgent: string | null;
}

const tabFromQuery = (value: string | null): SettingsTab =>
  value === "security" || value === "data" ? value : "profile";

function SettingsContent() {
  const { refresh, user } = useSession();
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeTab = tabFromQuery(searchParams.get("tab"));
  const [name, setName] = useState(user?.name ?? "");
  const [workspaceName, setWorkspaceName] = useState(
    user?.workspace.name ?? ""
  );
  const [timezone, setTimezone] = useState(user?.workspace.timezone ?? "UTC");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [sessions, setSessions] = useState<AccountSession[]>([]);
  const [deletion, setDeletion] = useState<DeletionView | null>(null);
  const [deletionPassword, setDeletionPassword] = useState("");
  const [deletionConfirmation, setDeletionConfirmation] = useState("");
  const [deletionReference, setDeletionReference] = useState<string | null>(
    null
  );
  const [deletionReferenceCopied, setDeletionReferenceCopied] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const loadSecurity = useCallback(async () => {
    try {
      const body = await apiRequest<{ sessions: AccountSession[] }>(
        "/api/auth/sessions"
      );
      setSessions(body.sessions);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, []);

  const loadDeletion = useCallback(async () => {
    try {
      const body = await apiRequest<{ deletion: DeletionView | null }>(
        "/api/account/deletion"
      );
      setDeletion(body.deletion);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, []);

  useEffect(() => {
    void Promise.all([
      apiRequest<{ sessions: AccountSession[] }>("/api/auth/sessions"),
      apiRequest<{ deletion: DeletionView | null }>("/api/account/deletion")
    ])
      .then(([sessionBody, deletionBody]) => {
        setSessions(sessionBody.sessions);
        setDeletion(deletionBody.deletion);
      })
      .catch((caught: unknown) => setError(errorMessage(caught)));
  }, [loadDeletion, loadSecurity]);

  const chooseTab = (tab: SettingsTab) => {
    router.replace(`/app/settings?tab=${tab}`);
  };

  const saveProfile = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setSuccess(null);
    const parsed = updateProfileSchema.safeParse({
      name,
      timezone,
      workspaceName
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Review the profile fields.");
      return;
    }
    setBusy("profile");
    try {
      await apiRequest<{ user: User }>("/api/auth/profile", {
        body: JSON.stringify(parsed.data),
        method: "PATCH"
      });
      await refresh();
      setSuccess("Profile and workspace details were updated.");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  };

  const changePassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setSuccess(null);
    const parsed = changePasswordSchema.safeParse({
      currentPassword,
      newPassword
    });
    if (!parsed.success) {
      setError(
        parsed.error.issues[0]?.message ?? "Review the password fields."
      );
      return;
    }
    setBusy("password");
    try {
      await apiRequest<{ changed: boolean }>("/api/auth/password", {
        body: JSON.stringify(parsed.data),
        method: "POST"
      });
      setCurrentPassword("");
      setNewPassword("");
      setSuccess("Password changed. Other active sessions were revoked.");
      await loadSecurity();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  };

  const revokeSession = async (session: AccountSession) => {
    if (
      !window.confirm(
        session.current
          ? "Revoke this session and return to the login page?"
          : "Revoke this active session?"
      )
    ) {
      return;
    }
    setBusy(`session-${session.id}`);
    setError(null);
    try {
      await apiRequest<unknown>(`/api/auth/sessions/${session.id}`, {
        method: "DELETE"
      });
      if (session.current) {
        await refresh();
      } else {
        await loadSecurity();
        setSuccess("The session was revoked.");
      }
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  };

  const requestDeletion = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setSuccess(null);
    const parsed = deleteAccountSchema.safeParse({
      confirmation: deletionConfirmation,
      password: deletionPassword
    });
    if (!parsed.success) {
      setError(
        parsed.error.issues[0]?.message ??
          "Enter the exact confirmation phrase."
      );
      return;
    }
    if (
      !window.confirm(
        "Submit the irreversible VidRelay account deletion request? Published provider posts will not be deleted."
      )
    ) {
      return;
    }
    setBusy("deletion");
    try {
      const body = await apiRequest<{
        deletion: DeletionView;
        reference: string;
      }>("/api/account/deletion", {
        body: JSON.stringify(parsed.data),
        method: "POST"
      });
      setDeletion(body.deletion);
      setDeletionReference(body.reference);
      setDeletionReferenceCopied(false);
      setDeletionPassword("");
      setSuccess(
        "Deletion was requested and your server-side sessions were closed. Save the private reference below."
      );
      try {
        localStorage.setItem("vidrelay.deletion-reference", body.reference);
      } catch {
        setSuccess(
          "Deletion was requested and your server-side sessions were closed. Browser storage was unavailable, so copy the private reference below now."
        );
      }
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  };

  const copyDeletionReference = async () => {
    if (deletionReference === null) {
      return;
    }
    setError(null);
    setSuccess(null);
    try {
      if (navigator.clipboard === undefined) {
        throw new Error("Clipboard access is unavailable.");
      }
      await navigator.clipboard.writeText(deletionReference);
      setDeletionReferenceCopied(true);
      setSuccess("Private deletion reference copied to the clipboard.");
    } catch {
      setDeletionReferenceCopied(false);
      setError(
        "The browser could not copy the private reference. Select it and copy it manually."
      );
    }
  };

  return (
    <div className="stack">
      <PageHeader
        description="Manage profile data, authentication, active sessions, and the account lifecycle."
        eyebrow="Workspace administration"
        title="Settings"
      />
      {error === null ? null : <Notice tone="danger">{error}</Notice>}
      {success === null ? null : <Notice tone="success">{success}</Notice>}

      <div aria-label="Settings sections" className="settings-tabs">
        {(["profile", "security", "data"] as const).map(tab => (
          <button
            aria-pressed={activeTab === tab}
            className={clsx(
              "settings-tab",
              activeTab === tab && "settings-tab-active"
            )}
            key={tab}
            onClick={() => chooseTab(tab)}
            type="button">
            {tab === "profile"
              ? "Profile"
              : tab === "security"
                ? "Security"
                : "Data & deletion"}
          </button>
        ))}
      </div>

      {activeTab === "profile" ? (
        <section aria-labelledby="profile-heading" className="panel stack">
          <div>
            <h2 id="profile-heading">Profile and workspace</h2>
            <p>Email is the account identifier and cannot be changed in v1.</p>
          </div>
          <form
            className="form-stack"
            onSubmit={event => void saveProfile(event)}>
            <div className="field">
              <label htmlFor="settings-email">Email address</label>
              <input
                className="input"
                disabled
                id="settings-email"
                value={user?.email ?? ""}
              />
            </div>
            <div className="field">
              <label htmlFor="settings-name">Your name</label>
              <input
                className="input"
                id="settings-name"
                maxLength={80}
                minLength={2}
                onChange={event => setName(event.target.value)}
                required
                value={name}
              />
            </div>
            <div className="field">
              <label htmlFor="settings-workspace">Workspace name</label>
              <input
                className="input"
                id="settings-workspace"
                maxLength={80}
                minLength={2}
                onChange={event => setWorkspaceName(event.target.value)}
                required
                value={workspaceName}
              />
            </div>
            <div className="field">
              <label htmlFor="settings-timezone">IANA time zone</label>
              <input
                className="input"
                id="settings-timezone"
                onChange={event => setTimezone(event.target.value)}
                required
                value={timezone}
              />
            </div>
            <Button busy={busy === "profile"} type="submit">
              <Save aria-hidden="true" size={16} /> Save changes
            </Button>
          </form>
        </section>
      ) : null}

      {activeTab === "security" ? (
        <div className="settings-grid">
          <section aria-labelledby="password-heading" className="panel stack">
            <div>
              <h2 id="password-heading">Change password</h2>
              <p>Changing it revokes every other active session.</p>
            </div>
            <form
              className="form-stack"
              onSubmit={event => void changePassword(event)}>
              <div className="field">
                <label htmlFor="current-password">Current password</label>
                <input
                  autoComplete="current-password"
                  className="input"
                  id="current-password"
                  onChange={event => setCurrentPassword(event.target.value)}
                  required
                  type="password"
                  value={currentPassword}
                />
              </div>
              <div className="field">
                <label htmlFor="new-password">New password</label>
                <input
                  autoComplete="new-password"
                  className="input"
                  id="new-password"
                  minLength={12}
                  onChange={event => setNewPassword(event.target.value)}
                  required
                  type="password"
                  value={newPassword}
                />
                <span className="field-help">At least 12 characters.</span>
              </div>
              <Button busy={busy === "password"} type="submit">
                <KeyRound aria-hidden="true" size={16} /> Change password
              </Button>
            </form>
          </section>

          <section aria-labelledby="sessions-heading" className="panel stack">
            <div>
              <h2 id="sessions-heading">Active sessions</h2>
              <p>Revoke devices you do not recognize.</p>
            </div>
            <div className="list">
              {sessions.map(session => (
                <article className="list-row" key={session.id}>
                  <div>
                    <strong>
                      {session.current
                        ? "This browser"
                        : (session.userAgent ?? "Unknown browser")}
                    </strong>
                    <p className="post-meta">
                      Last seen{" "}
                      {formatDate(session.lastSeenAt, user?.workspace.timezone)}{" "}
                      · expires{" "}
                      {formatDate(session.expiresAt, user?.workspace.timezone)}
                    </p>
                  </div>
                  {session.current ? (
                    <StatusBadge label="Current" tone="success" />
                  ) : null}
                  <Button
                    busy={busy === `session-${session.id}`}
                    onClick={() => void revokeSession(session)}
                    size="small"
                    variant="ghost">
                    <LogOut aria-hidden="true" size={14} /> Revoke
                  </Button>
                </article>
              ))}
            </div>
          </section>
        </div>
      ) : null}

      {activeTab === "data" ? (
        <section
          aria-labelledby="deletion-heading"
          className="panel danger-zone stack">
          <div>
            <h2 id="deletion-heading">Delete account and workspace</h2>
            <p>
              This asynchronous deletion request is available only to the sole
              owner of a single-member workspace.
            </p>
          </div>
          <Notice tone="warning">
            Pending local publishing is cancelled and stored VidRelay
            media/account data is removed asynchronously. Posts already
            published on provider platforms are not deleted.
          </Notice>
          {deletion === null ? null : (
            <div className="summary-list">
              <div className="summary-row">
                <span>Latest request</span>
                <StatusBadge
                  label={deletion.status.replaceAll("_", " ")}
                  tone={
                    deletion.status === "complete"
                      ? "success"
                      : deletion.status === "manual_review"
                        ? "danger"
                        : deletion.status === "retry_scheduled"
                          ? "warning"
                          : "info"
                  }
                />
              </div>
              <div className="summary-row">
                <span>Requested</span>
                <strong>
                  {formatDate(deletion.requestedAt, user?.workspace.timezone)}
                </strong>
              </div>
              {deletion.nextAttemptAt === null ? null : (
                <div className="summary-row">
                  <span>Next automatic attempt</span>
                  <strong>
                    {formatDate(
                      deletion.nextAttemptAt,
                      user?.workspace.timezone
                    )}
                  </strong>
                </div>
              )}
              {deletion.status === "processing" ||
              deletion.status === "retry_scheduled" ||
              deletion.status === "manual_review" ? (
                <div className="summary-row">
                  <span>Current phase</span>
                  <strong>{deletion.phase.replaceAll("_", " ")}</strong>
                </div>
              ) : null}
            </div>
          )}
          {deletion?.status === "manual_review" ? (
            <Notice tone="danger">
              Automatic deletion could not finish. Contact the service operator
              with your private reference
              {deletion.failureCode === null ? (
                "."
              ) : (
                <>
                  {" "}
                  and support code{" "}
                  <strong className="code-text">{deletion.failureCode}</strong>.
                </>
              )}
            </Notice>
          ) : null}
          {deletionReference === null ? null : (
            <Notice tone="success">
              Private status reference:{" "}
              <strong className="code-text deletion-reference">
                {deletionReference}
              </strong>
              . Copy and keep it for the public status checker.
            </Notice>
          )}
          {user?.role === "operator" ? (
            <Notice tone="info">
              Service operators cannot delete their own account while they are
              responsible for deletion recovery. Manage the service operator
              lifecycle through controlled service administration.
            </Notice>
          ) : deletionReference === null ? (
            <form
              className="form-stack"
              onSubmit={event => void requestDeletion(event)}>
              <div className="field">
                <label htmlFor="deletion-password">Current password</label>
                <input
                  autoComplete="current-password"
                  className="input"
                  id="deletion-password"
                  onChange={event => setDeletionPassword(event.target.value)}
                  required
                  type="password"
                  value={deletionPassword}
                />
              </div>
              <div className="field">
                <label htmlFor="deletion-confirmation">
                  Type DELETE MY ACCOUNT
                </label>
                <input
                  autoComplete="off"
                  className="input code-text"
                  id="deletion-confirmation"
                  onChange={event =>
                    setDeletionConfirmation(event.target.value)
                  }
                  required
                  value={deletionConfirmation}
                />
              </div>
              <Button busy={busy === "deletion"} type="submit" variant="danger">
                <Trash2 aria-hidden="true" size={16} /> Request permanent
                deletion
              </Button>
            </form>
          ) : (
            <div className="button-row">
              <Button
                onClick={() => void copyDeletionReference()}
                type="button"
                variant="secondary">
                {deletionReferenceCopied ? (
                  <Check aria-hidden="true" size={16} />
                ) : (
                  <Copy aria-hidden="true" size={16} />
                )}
                {deletionReferenceCopied
                  ? "Reference copied"
                  : "Copy private reference"}
              </Button>
              <Link className={buttonClass("secondary")} href="/data-deletion">
                Open public status checker
              </Link>
              <Link
                className={buttonClass("ghost")}
                href="/auth/login?deleted=requested">
                Leave this signed-out session
              </Link>
            </div>
          )}
        </section>
      ) : null}
    </div>
  );
}

export default function SettingsPage() {
  return (
    <Suspense fallback={<LoadingState label="Loading settings…" />}>
      <SettingsContent />
    </Suspense>
  );
}
