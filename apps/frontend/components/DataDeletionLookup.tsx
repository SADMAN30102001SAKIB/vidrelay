"use client";

import { useState } from "react";

import type { FormEvent } from "react";

import { apiRequest, errorMessage } from "@/lib/api";
import { formatDate } from "@/lib/format";

import { Button, Notice } from "./ui";

interface DeletionView {
  completedAt: number | null;
  id: string;
  requestedAt: number;
  status: "complete" | "failed" | "processing" | "requested";
}

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
            const saved = localStorage.getItem("vidrelay.deletion-reference");
            if (saved === null) {
              setError("No deletion reference is saved in this browser.");
            } else {
              setReference(saved);
              setError(null);
            }
          }}
          type="button"
          variant="ghost">
          Use reference saved in this browser
        </Button>
      </form>
      {error === null ? null : <Notice tone="danger">{error}</Notice>}
      {deletion === null ? null : (
        <Notice tone={deletion.status === "complete" ? "success" : "info"}>
          Status: {deletion.status}. Requested{" "}
          {formatDate(deletion.requestedAt)}
          {deletion.completedAt === null
            ? "."
            : ` and completed ${formatDate(deletion.completedAt)}.`}
        </Notice>
      )}
    </section>
  );
}
