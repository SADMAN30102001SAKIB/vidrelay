"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";

import type { FormEvent } from "react";

import { AuthFrame } from "@/components/AuthFrame";
import { Button, LoadingState, Notice } from "@/components/ui";
import { errorMessage } from "@/lib/api";
import { useSession } from "@/providers/SessionProvider";

const safeReturnTo = (value: string | null): string =>
  value !== null &&
  value.startsWith("/app") &&
  !value.startsWith("//") &&
  !value.includes("\\")
    ? value
    : "/app";

function LoginForm() {
  const { login } = useSession();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login({ email, password });
      router.replace(safeReturnTo(searchParams.get("returnTo")));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {searchParams.get("deleted") === "requested" ? (
        <Notice tone="success">
          Your deletion request was accepted and this session has been closed.
        </Notice>
      ) : null}
      {error === null ? null : <Notice tone="danger">{error}</Notice>}
      <form className="form-stack" onSubmit={event => void submit(event)}>
        <div className="field">
          <label htmlFor="email">Email address</label>
          <input
            autoComplete="email"
            className="input"
            id="email"
            inputMode="email"
            onChange={event => setEmail(event.target.value)}
            required
            type="email"
            value={email}
          />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            autoComplete="current-password"
            className="input"
            id="password"
            onChange={event => setPassword(event.target.value)}
            required
            type="password"
            value={password}
          />
        </div>
        <Button busy={busy} type="submit" wide>
          Log in
        </Button>
      </form>
      <p className="form-help">
        New to VidRelay?{" "}
        <Link className="text-link" href="/auth/signup">
          Create an account
        </Link>
        .
      </p>
    </>
  );
}

export default function LoginPage() {
  return (
    <AuthFrame
      heading="Welcome back"
      subheading="Sign in to manage your publishing workspace.">
      <Suspense fallback={<LoadingState label="Loading sign-in…" />}>
        <LoginForm />
      </Suspense>
    </AuthFrame>
  );
}
