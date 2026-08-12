import { apiErrorSchema } from "@vidrelay/shared";

import { ApiClientError } from "./api";

export type UploadMode = "direct" | "worker_proxy";

export interface CompletedPart {
  etag: string;
  partNumber: number;
}

export interface MultipartDescriptor {
  mode: UploadMode;
  partCount: number;
  partSize: number;
}

export interface PersistedUpload {
  completed: CompletedPart[];
  fingerprint: string;
  id: string;
  multipart: MultipartDescriptor;
}

export const uploadStorageKey = "vidrelay.active-upload.v1";

export const fileFingerprint = (file: File): string =>
  [file.name, file.size, file.lastModified].join(":");

export const readPersistedUpload = (): PersistedUpload | null => {
  try {
    const raw = sessionStorage.getItem(uploadStorageKey);
    if (raw === null) {
      return null;
    }
    const value = JSON.parse(raw) as Partial<PersistedUpload>;
    if (
      typeof value.fingerprint !== "string" ||
      typeof value.id !== "string" ||
      !Array.isArray(value.completed) ||
      value.multipart === undefined ||
      (value.multipart.mode !== "direct" &&
        value.multipart.mode !== "worker_proxy") ||
      !Number.isInteger(value.multipart.partCount) ||
      !Number.isInteger(value.multipart.partSize)
    ) {
      return null;
    }
    return value as PersistedUpload;
  } catch {
    return null;
  }
};

export const persistUpload = (upload: PersistedUpload | null): void => {
  if (upload === null) {
    sessionStorage.removeItem(uploadStorageKey);
  } else {
    sessionStorage.setItem(uploadStorageKey, JSON.stringify(upload));
  }
};

interface PutPartOptions {
  blob: Blob;
  mode: UploadMode;
  onProgress: (loaded: number) => void;
  signal: AbortSignal;
  url: string;
}

export const putUploadPart = ({
  blob,
  mode,
  onProgress,
  signal,
  url
}: PutPartOptions): Promise<string> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("The upload was cancelled.", "AbortError"));
      return;
    }
    const request = new XMLHttpRequest();
    const abort = () => request.abort();
    request.open("PUT", url);
    request.withCredentials = mode === "worker_proxy";
    request.setRequestHeader("Content-Type", "application/octet-stream");
    if (mode === "worker_proxy") {
      request.setRequestHeader("X-VidRelay-CSRF", "1");
    }
    request.upload.addEventListener("progress", event => {
      if (event.lengthComputable) {
        onProgress(event.loaded);
      }
    });
    request.addEventListener("load", () => {
      signal.removeEventListener("abort", abort);
      if (request.status < 200 || request.status >= 300) {
        let message = `Part upload failed with status ${request.status}.`;
        try {
          const parsed = apiErrorSchema.safeParse(
            JSON.parse(request.responseText) as unknown
          );
          if (parsed.success) {
            reject(
              new ApiClientError(
                request.status,
                parsed.data.error.code,
                parsed.data.error.message,
                parsed.data.requestId
              )
            );
            return;
          }
        } catch {
          message = `Part upload failed with status ${request.status}.`;
        }
        reject(new Error(message));
        return;
      }

      if (mode === "worker_proxy") {
        try {
          const body = JSON.parse(request.responseText) as { etag?: unknown };
          if (typeof body.etag !== "string" || body.etag.length === 0) {
            throw new Error(
              "The upload proxy did not return a part identifier."
            );
          }
          resolve(body.etag);
        } catch (error) {
          reject(error);
        }
        return;
      }

      const etag = request.getResponseHeader("ETag");
      if (etag === null || etag.length === 0) {
        reject(
          new Error(
            "The storage upload succeeded but its ETag was hidden. The storage CORS policy must expose the ETag header before this upload can be completed."
          )
        );
        return;
      }
      resolve(etag);
    });
    request.addEventListener("error", () => {
      signal.removeEventListener("abort", abort);
      reject(
        new Error("The part upload was interrupted by a network or CORS error.")
      );
    });
    request.addEventListener("abort", () => {
      signal.removeEventListener("abort", abort);
      reject(new DOMException("The upload was cancelled.", "AbortError"));
    });
    signal.addEventListener("abort", abort, { once: true });
    request.send(blob);
  });
