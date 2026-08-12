"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import type { FormEvent } from "react";

import { AuthFrame } from "@/components/AuthFrame";
import { Button, LoadingState, Notice } from "@/components/ui";
import { errorMessage } from "@/lib/api";
import { useSession } from "@/providers/SessionProvider";

export default function SignupPage() {
  const { config, configError, refreshConfig, register } = useSession();
  const router = useRouter();
  const [name, setName] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [timezone, setTimezone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  );
  const [busy, setBusy] = useState(false);
  const [configBusy, setConfigBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const retryConfiguration = async () => {
    setConfigBusy(true);
    try {
      await refreshConfig();
    } catch {
      return;
    } finally {
      setConfigBusy(false);
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await register({ email, name, password, timezone, workspaceName });
      router.replace("/app/connections");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  if (config === null) {
    return (
      <AuthFrame
        heading="Create your workspace"
        subheading={
          configError === null
            ? "Checking account availability…"
            : "Account availability could not be checked."
        }>
        {configError === null ? (
          <LoadingState />
        ) : (
          <>
            <Notice tone="danger">{configError}</Notice>
            <Button
              busy={configBusy}
              onClick={() => void retryConfiguration()}
              type="button"
              wide>
              Try again
            </Button>
          </>
        )}
      </AuthFrame>
    );
  }

  return (
    <AuthFrame
      heading="Create your workspace"
      subheading="Connect provider accounts only after your VidRelay account is ready.">
      {config.signupsEnabled ? null : (
        <Notice tone="warning">
          New account registration is currently disabled.
        </Notice>
      )}
      {error === null ? null : <Notice tone="danger">{error}</Notice>}
      <form className="form-stack" onSubmit={event => void submit(event)}>
        <div className="field">
          <label htmlFor="name">Your name</label>
          <input
            autoComplete="name"
            className="input"
            id="name"
            maxLength={80}
            minLength={2}
            onChange={event => setName(event.target.value)}
            required
            value={name}
          />
        </div>
        <div className="field">
          <label htmlFor="workspace-name">Workspace name</label>
          <input
            className="input"
            id="workspace-name"
            maxLength={80}
            minLength={2}
            onChange={event => setWorkspaceName(event.target.value)}
            required
            value={workspaceName}
          />
        </div>
        <div className="field">
          <label htmlFor="signup-email">Email address</label>
          <input
            autoComplete="email"
            className="input"
            id="signup-email"
            onChange={event => setEmail(event.target.value)}
            required
            type="email"
            value={email}
          />
        </div>
        <div className="field">
          <label htmlFor="signup-password">Password</label>
          <input
            aria-describedby="password-help"
            autoComplete="new-password"
            className="input"
            id="signup-password"
            minLength={12}
            onChange={event => setPassword(event.target.value)}
            required
            type="password"
            value={password}
          />
          <span className="field-help" id="password-help">
            Use at least 12 characters.
          </span>
        </div>
        <div className="field">
          <label htmlFor="timezone">IANA time zone</label>
          <input
            className="input"
            id="timezone"
            onChange={event => setTimezone(event.target.value)}
            required
            value={timezone}
          />
          <span className="field-help">
            For example, Asia/Dhaka or America/New_York.
          </span>
        </div>
        <Button
          busy={busy}
          disabled={!config.signupsEnabled}
          type="submit"
          wide>
          Create account
        </Button>
      </form>
      <p className="form-help">
        By creating an account, you agree to the{" "}
        <Link className="text-link" href="/terms">
          Terms
        </Link>{" "}
        and acknowledge the{" "}
        <Link className="text-link" href="/privacy">
          Privacy notice
        </Link>
        .
      </p>
      <p className="form-help">
        Already have an account?{" "}
        <Link className="text-link" href="/auth/login">
          Log in
        </Link>
        .
      </p>
    </AuthFrame>
  );
}
