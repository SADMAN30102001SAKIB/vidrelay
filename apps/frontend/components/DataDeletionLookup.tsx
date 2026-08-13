"use client";

import { useState } from "react";

import type { DeletionView } from "@vidrelay/shared";
import type { FormEvent } from "react";

import { apiRequest, errorMessage } from "@/lib/api";
import { formatDate } from "@/lib/format";

import { Button, Notice } from "./ui";

const statusLabel = (status: DeletionView["status"]): string =>
  status.replaceAll("_", " ");

const phaseLabel = (phase: DeletionView["phase"]): string =>
  phase.replaceAll("_", " ");

const statusMessage = (deletion: DeletionView): string => {
  if (deletion.status === "complete") {
    return "VidRelay account and workspace deletion is complete.";
  }
  if (deletion.status === "manual_review") {
    return "Automatic deletion could not finish. Contact the service operator and provide this private reference and the support code shown with this status.";
  }
  if (
    deletion.status === "retry_scheduled" &&
    deletion.nextAttemptAt !== null
  ) {
    return `A temporary problem delayed deletion. Another automatic attempt is scheduled for ${formatDate(deletion.nextAttemptAt)}.`;
  }
  if (deletion.status === "processing") {
    return "VidRelay is deleting provider authorization, stored media, and local account data.";
  }
  return "The request is queued for automatic processing.";
};

export function DataDeletionLookup() {
  const [reference, setReference] = useState("");
  const [deletion, setDeletion] = useState<DeletionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setDeletion(null);
    try {
      const body = await apiRequest<{ deletion: DeletionView }>(
        `/api/deletion-status/${encodeURIComponent(reference.trim())}`
      );
      setDeletion(body.deletion);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="deletion-status-heading" className="panel stack">
      <div>
        <h2 id="deletion-status-heading">Check a deletion request</h2>
        <p>Use the private reference shown when the request was submitted.</p>
      </div>
      <form className="form-stack" onSubmit={event => void submit(event)}>
        <div className="field">
          <label htmlFor="deletion-reference">Deletion reference</label>
          <input
            autoComplete="off"
            className="input code-text"
            id="deletion-reference"
            onChange={event => setReference(event.target.value)}
            required
            spellCheck={false}
            value={reference}
          />
        </div>
        <Button busy={busy} type="submit">
          Check status
        </Button>
        <Button
          onClick={() => {
            try {
              const saved = localStorage.getItem("vidrelay.deletion-reference");
              if (saved === null) {
                setError("No deletion reference is saved in this browser.");
              } else {
                setReference(saved);
                setError(null);
              }
            } catch {
              setError(
                "Browser storage is unavailable. Enter your private reference manually."
              );
            }
          }}
          type="button"
          variant="ghost">
          Use reference saved in this browser
        </Button>
      </form>
      {error === null ? null : <Notice tone="danger">{error}</Notice>}
      {deletion === null ? null : (
        <Notice
          tone={
            deletion.status === "complete"
              ? "success"
              : deletion.status === "manual_review"
                ? "danger"
                : deletion.status === "retry_scheduled"
                  ? "warning"
                  : "info"
          }>
          <strong>Status: {statusLabel(deletion.status)}.</strong>{" "}
          {statusMessage(deletion)} Requested {formatDate(deletion.requestedAt)}
          {deletion.completedAt === null
            ? "."
            : `; completed ${formatDate(deletion.completedAt)}.`}
          {deletion.status === "processing" ||
          deletion.status === "retry_scheduled" ||
          deletion.status === "manual_review" ? (
            <> Current phase: {phaseLabel(deletion.phase)}.</>
          ) : null}
          {deletion.failureCode === null ? null : (
            <>
              {" "}
              Support code:{" "}
              <strong className="code-text">{deletion.failureCode}</strong>.
            </>
          )}
        </Notice>
      )}
    </section>
  );
}
