"use client";

import { commonMediaProfile } from "@vidrelay/shared";
import { FileVideo, RefreshCw, UploadCloud, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { PublicConfig, Upload } from "@vidrelay/shared";
import type { ChangeEvent, DragEvent } from "react";

import { apiRequest, errorMessage } from "@/lib/api";
import { formatBytes, formatDuration } from "@/lib/format";
import {
  fileFingerprint,
  persistUpload,
  putUploadPart,
  readPersistedUpload
} from "@/lib/upload";
import type { MultipartDescriptor, PersistedUpload } from "@/lib/upload";

import { Button, Notice } from "./ui";

interface BrowserMediaFacts {
  duration: number;
  height: number;
  width: number;
}

type UploadPhase =
  | "cancelling"
  | "error"
  | "idle"
  | "ready"
  | "selected"
  | "uploading"
  | "verifying";

interface VideoUploaderProps {
  config: PublicConfig | null;
  onUploadChange: (upload: Upload | null) => void;
}

const inspectVideo = (url: string): Promise<BrowserMediaFacts> =>
  new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      if (
        !Number.isFinite(video.duration) ||
        video.videoWidth === 0 ||
        video.videoHeight === 0
      ) {
        reject(
          new Error(
            "The browser could not read this video’s duration or dimensions."
          )
        );
        return;
      }
      resolve({
        duration: video.duration,
        height: video.videoHeight,
        width: video.videoWidth
      });
    };
    video.onerror = () =>
      reject(new Error("The browser could not open this MP4 file."));
    video.src = url;
  });

const chunk = <T,>(items: T[], size: number): T[][] => {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
};

export function VideoUploader({ config, onUploadChange }: VideoUploaderProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const activeSessionRef = useRef<PersistedUpload | null>(null);
  const cancelRequestedRef = useRef(false);
  const uploadInFlightRef = useRef(false);
  const [file, setFile] = useState<File | null>(null);
  const [facts, setFacts] = useState<BrowserMediaFacts | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [session, setSession] = useState<PersistedUpload | null>(null);
  const [serverUpload, setServerUpload] = useState<Upload | null>(null);
  const [phase, setPhase] = useState<UploadPhase>("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);

  useEffect(
    () => () => {
      abortRef.current?.abort();
      if (previewUrl !== null) {
        URL.revokeObjectURL(previewUrl);
      }
    },
    [previewUrl]
  );

  const clearSelection = () => {
    activeSessionRef.current = null;
    cancelRequestedRef.current = false;
    if (previewUrl !== null) {
      URL.revokeObjectURL(previewUrl);
    }
    setFile(null);
    setFacts(null);
    setPreviewUrl(null);
    setSession(null);
    setServerUpload(null);
    setPhase("idle");
    setProgress(0);
    setError(null);
    setWarnings([]);
    persistUpload(null);
    onUploadChange(null);
    if (inputRef.current !== null) {
      inputRef.current.value = "";
    }
  };

  const chooseFile = async (nextFile: File) => {
    activeSessionRef.current = null;
    setError(null);
    setWarnings([]);
    setServerUpload(null);
    onUploadChange(null);
    if (previewUrl !== null) {
      URL.revokeObjectURL(previewUrl);
    }
    const nextUrl = URL.createObjectURL(nextFile);
    setPreviewUrl(nextUrl);
    setFile(nextFile);
    setFacts(null);
    setProgress(0);

    try {
      const profile = config?.mediaProfile ?? commonMediaProfile;
      const isMp4 =
        nextFile.type === "video/mp4" ||
        nextFile.name.toLowerCase().endsWith(".mp4");
      if (!isMp4) {
        throw new Error("Choose an MP4 video file.");
      }
      if (nextFile.size > profile.maxBytes) {
        throw new Error(
          `The file exceeds the ${formatBytes(profile.maxBytes)} limit.`
        );
      }
      const nextFacts = await inspectVideo(nextUrl);
      const validationErrors: string[] = [];
      if (
        nextFacts.duration < profile.durationSeconds.min ||
        nextFacts.duration > profile.durationSeconds.max
      ) {
        validationErrors.push(
          `Duration must be ${profile.durationSeconds.min}–${profile.durationSeconds.max} seconds.`
        );
      }
      if (
        nextFacts.width < profile.minWidth ||
        nextFacts.height < profile.minHeight
      ) {
        validationErrors.push(
          `Video dimensions must be at least ${profile.minWidth}×${profile.minHeight}.`
        );
      }
      const expectedRatio = profile.ratio.width / profile.ratio.height;
      const actualRatio = nextFacts.width / nextFacts.height;
      if (Math.abs(actualRatio - expectedRatio) > 0.025) {
        validationErrors.push("Video must use a 9:16 vertical aspect ratio.");
      }
      if (validationErrors.length > 0) {
        throw new Error(validationErrors.join(" "));
      }
      setFacts(nextFacts);
      setWarnings([
        "Your browser can check the container, dimensions, and duration. VidRelay verifies H.264 video, AAC audio, frame rate, and file integrity after upload."
      ]);

      const persisted = readPersistedUpload();
      if (persisted?.fingerprint === fileFingerprint(nextFile)) {
        try {
          const body = await apiRequest<{ upload: Upload }>(
            `/api/uploads/${persisted.id}`
          );
          if (body.upload.status === "ready") {
            activeSessionRef.current = persisted;
            setSession(persisted);
            setServerUpload(body.upload);
            setPhase("ready");
            setProgress(100);
            onUploadChange(body.upload);
            return;
          }
          if (
            body.upload.status === "uploading" ||
            body.upload.status === "verifying"
          ) {
            activeSessionRef.current = persisted;
            setSession(persisted);
            setServerUpload(body.upload);
            setPhase("selected");
            setProgress(
              Math.round(
                (persisted.completed.length / persisted.multipart.partCount) *
                  100
              )
            );
            return;
          }
        } catch {
          activeSessionRef.current = null;
          persistUpload(null);
        }
      }
      setSession(null);
      setPhase("selected");
    } catch (caught) {
      setPhase("error");
      setError(errorMessage(caught));
    }
  };

  const handleFiles = (files: FileList | null) => {
    const nextFile = files?.[0];
    if (nextFile !== undefined) {
      void chooseFile(nextFile);
    }
  };

  const upload = async () => {
    if (
      uploadInFlightRef.current ||
      file === null ||
      facts === null
    ) {
      return;
    }
    uploadInFlightRef.current = true;
    cancelRequestedRef.current = false;
    setPhase("uploading");
    setError(null);
    const controller = new AbortController();
    abortRef.current = controller;
    let workingSession = session;
    activeSessionRef.current = workingSession;

    try {
      if (workingSession === null) {
        const body = await apiRequest<{
          multipart: MultipartDescriptor;
          upload: Upload;
        }>("/api/uploads", {
          body: JSON.stringify({
            filename: file.name,
            mimeType: "video/mp4",
            size: file.size
          }),
          method: "POST"
        });
        workingSession = {
          completed: [],
          fingerprint: fileFingerprint(file),
          id: body.upload.id,
          multipart: body.multipart
        };
        activeSessionRef.current = workingSession;
        if (cancelRequestedRef.current || controller.signal.aborted) {
          try {
            await apiRequest<unknown>(`/api/uploads/${workingSession.id}`, {
              method: "DELETE"
            });
            activeSessionRef.current = null;
            cancelRequestedRef.current = false;
            clearSelection();
          } catch (caught) {
            setSession(workingSession);
            persistUpload(workingSession);
            cancelRequestedRef.current = false;
            setPhase("error");
            setError(errorMessage(caught));
          }
          return;
        }
        setServerUpload(body.upload);
        setSession(workingSession);
        persistUpload(workingSession);
      }

      const completed = new Map(
        workingSession.completed.map(part => [part.partNumber, part] as const)
      );
      const remaining = Array.from(
        { length: workingSession.multipart.partCount },
        (_, index) => index + 1
      ).filter(partNumber => !completed.has(partNumber));
      const liveProgress = new Map<number, number>();
      const completedBytes = (): number =>
        [...completed.keys()].reduce((sum, partNumber) => {
          const start = (partNumber - 1) * workingSession!.multipart.partSize;
          return (
            sum +
            Math.min(workingSession!.multipart.partSize, file.size - start)
          );
        }, 0);
      const updateProgress = () => {
        const loaded = [...liveProgress.values()].reduce(
          (sum, value) => sum + value,
          0
        );
        setProgress(
          Math.min(
            99,
            Math.round(((completedBytes() + loaded) / file.size) * 100)
          )
        );
      };

      for (const batch of chunk(remaining, 25)) {
        const partBody = await apiRequest<{
          expiresAt: number;
          mode: "direct" | "worker_proxy";
          parts: Array<{ number: number; url: string }>;
        }>(`/api/uploads/${workingSession.id}/parts`, {
          body: JSON.stringify({ partNumbers: batch }),
          method: "POST",
          signal: controller.signal
        });
        let cursor = 0;
        const worker = async () => {
          while (cursor < partBody.parts.length) {
            const part = partBody.parts[cursor];
            cursor += 1;
            if (part === undefined) {
              return;
            }
            const start =
              (part.number - 1) * workingSession!.multipart.partSize;
            const end = Math.min(
              start + workingSession!.multipart.partSize,
              file.size
            );
            liveProgress.set(part.number, 0);
            const etag = await putUploadPart({
              blob: file.slice(start, end),
              mode: partBody.mode,
              onProgress: loaded => {
                liveProgress.set(part.number, loaded);
                updateProgress();
              },
              signal: controller.signal,
              url: part.url
            });
            liveProgress.delete(part.number);
            completed.set(part.number, { etag, partNumber: part.number });
            workingSession = {
              ...workingSession!,
              completed: [...completed.values()].sort(
                (left, right) => left.partNumber - right.partNumber
              )
            };
            setSession(workingSession);
            persistUpload(workingSession);
            updateProgress();
          }
        };
        await Promise.all(
          Array.from({ length: Math.min(3, batch.length) }, () => worker())
        );
      }

      setPhase("verifying");
      setProgress(100);
      const completedBody = await apiRequest<{ upload: Upload }>(
        `/api/uploads/${workingSession.id}/complete`,
        {
          body: JSON.stringify({
            parts: [...completed.values()].sort(
              (left, right) => left.partNumber - right.partNumber
            )
          }),
          method: "POST",
          signal: controller.signal
        }
      );
      setServerUpload(completedBody.upload);
      if (completedBody.upload.status === "ready") {
        setPhase("ready");
        persistUpload(null);
        onUploadChange(completedBody.upload);
      } else if (completedBody.upload.status === "rejected") {
        setPhase("error");
        setError(
          completedBody.upload.validation.errors.join(" ") ||
            "The server rejected this media file."
        );
      } else {
        setPhase("error");
        setError(
          "Server verification is still pending. Resume to check the upload again."
        );
      }
    } catch (caught) {
      if (cancelRequestedRef.current) {
        if (activeSessionRef.current === null) {
          cancelRequestedRef.current = false;
          clearSelection();
        }
        return;
      }
      setPhase("error");
      setError(errorMessage(caught));
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
      uploadInFlightRef.current = false;
    }
  };

  const cancel = async () => {
    if (phase === "cancelling") {
      return;
    }
    cancelRequestedRef.current = true;
    setPhase("cancelling");
    setError(null);
    abortRef.current?.abort();
    const activeSession = activeSessionRef.current ?? session;
    if (activeSession !== null) {
      try {
        await apiRequest<unknown>(`/api/uploads/${activeSession.id}`, {
          method: "DELETE"
        });
      } catch (caught) {
        cancelRequestedRef.current = false;
        setPhase("error");
        setError(errorMessage(caught));
        return;
      }
      activeSessionRef.current = null;
      cancelRequestedRef.current = false;
      clearSelection();
      return;
    }
    if (!uploadInFlightRef.current) {
      cancelRequestedRef.current = false;
      clearSelection();
    }
  };

  const drop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    if (
      phase !== "cancelling" &&
      phase !== "uploading" &&
      phase !== "verifying"
    ) {
      handleFiles(event.dataTransfer.files);
    }
  };

  if (file === null || previewUrl === null) {
    return (
      <div
        className={`dropzone${dragging ? " dropzone-active" : ""}`}
        onDragEnter={() => setDragging(true)}
        onDragLeave={() => setDragging(false)}
        onDragOver={event => event.preventDefault()}
        onDrop={drop}>
        <UploadCloud aria-hidden="true" size={32} />
        <strong>Drop a vertical MP4 here</strong>
        <span>
          4–60 seconds, 9:16, up to{" "}
          {formatBytes((config?.mediaProfile ?? commonMediaProfile).maxBytes)}
        </span>
        <Button
          onClick={() => inputRef.current?.click()}
          type="button"
          variant="secondary">
          Choose video
        </Button>
        <input
          accept="video/mp4,.mp4"
          aria-label="Choose MP4 video"
          onChange={(event: ChangeEvent<HTMLInputElement>) =>
            handleFiles(event.target.files)
          }
          ref={inputRef}
          type="file"
        />
      </div>
    );
  }

  return (
    <div className="stack">
      <video
        className="video-preview"
        controls
        playsInline
        preload="metadata"
        src={previewUrl}>
        Your browser does not support video preview.
      </video>
      <div className="media-facts">
        <div className="media-fact">
          <span>File</span>
          <strong>{file.name}</strong>
        </div>
        <div className="media-fact">
          <span>Size</span>
          <strong>{formatBytes(file.size)}</strong>
        </div>
        <div className="media-fact">
          <span>Duration</span>
          <strong>
            {facts === null ? "Unreadable" : formatDuration(facts.duration)}
          </strong>
        </div>
        <div className="media-fact">
          <span>Frame</span>
          <strong>
            {facts === null ? "Unreadable" : `${facts.width}×${facts.height}`}
          </strong>
        </div>
      </div>
      {warnings.map(warning => (
        <Notice key={warning} tone="info">
          {warning}
        </Notice>
      ))}
      {serverUpload?.validation.warnings.map(warning => (
        <Notice key={warning} tone="warning">
          {warning}
        </Notice>
      ))}
      {error === null ? null : <Notice tone="danger">{error}</Notice>}
      {phase === "cancelling" ||
      phase === "uploading" ||
      phase === "verifying" ||
      phase === "ready" ? (
        <div className="stack" aria-live="polite">
          <div className="cluster">
            <span>
              {phase === "cancelling"
                ? "Cancelling upload…"
                : phase === "verifying"
                ? "Verifying media…"
                : phase === "ready"
                  ? "Media verified"
                  : "Uploading parts…"}
            </span>
            <strong>{progress}%</strong>
          </div>
          <div
            aria-label={`Upload progress: ${progress}%`}
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={progress}
            className="progress-track"
            role="progressbar">
            <div className="progress-bar" style={{ width: `${progress}%` }} />
          </div>
        </div>
      ) : null}
      {phase === "ready" ? (
        <Notice tone="success">
          Server verification passed. This upload is ready to publish.
        </Notice>
      ) : null}
      <div className="button-row">
        {facts !== null && phase !== "ready" && phase !== "verifying" ? (
          <Button
            busy={phase === "uploading"}
            disabled={phase === "cancelling"}
            onClick={() => void upload()}
            type="button">
            {phase === "error" || session !== null ? (
              <RefreshCw aria-hidden="true" size={16} />
            ) : (
              <FileVideo aria-hidden="true" size={16} />
            )}
            {phase === "error" || session !== null
              ? "Resume upload"
              : "Upload and verify"}
          </Button>
        ) : null}
        <Button
          disabled={phase === "cancelling" || phase === "verifying"}
          onClick={() => void cancel()}
          type="button"
          variant="ghost">
          <X aria-hidden="true" size={16} />
          {phase === "cancelling"
            ? "Cancelling upload"
            : phase === "uploading"
              ? "Cancel upload"
              : "Choose another"}
        </Button>
      </div>
    </div>
  );
}
