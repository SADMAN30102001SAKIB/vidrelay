import type { Bindings } from "../env";
import { requireSecret } from "../env";

const encoder = new TextEncoder();

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
};

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");

const sha256Hex = async (value: string): Promise<string> =>
  hex(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        toArrayBuffer(encoder.encode(value))
      )
    )
  );

const hmac = async (key: Uint8Array, value: string): Promise<Uint8Array> => {
  const imported = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(key),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"]
  );
  return new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      imported,
      toArrayBuffer(encoder.encode(value))
    )
  );
};

const awsEncode = (value: string): string =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    character => "%" + character.charCodeAt(0).toString(16).toUpperCase()
  );

const canonicalPath = (bucket: string, key: string): string =>
  "/" + awsEncode(bucket) + "/" + key.split("/").map(awsEncode).join("/");

const canonicalQuery = (values: URLSearchParams): string =>
  Array.from(values.entries())
    .map(([key, value]) => [awsEncode(key), awsEncode(value)] as const)
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => {
      const keyOrder = leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      return keyOrder === 0
        ? leftValue < rightValue
          ? -1
          : leftValue > rightValue
            ? 1
            : 0
        : keyOrder;
    })
    .map(([key, value]) => key + "=" + value)
    .join("&");

const timestamp = (date: Date): { date: string; value: string } => {
  const value = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { date: value.slice(0, 8), value };
};

const signingKey = async (
  secret: string,
  date: string
): Promise<Uint8Array> => {
  const day = await hmac(encoder.encode("AWS4" + secret), date);
  const region = await hmac(day, "auto");
  const service = await hmac(region, "s3");
  return await hmac(service, "aws4_request");
};

interface R2Credentials {
  accessKeyId: string;
  accountId: string;
  bucket: string;
  secretAccessKey: string;
}

const credentialsFrom = (bindings: Bindings): R2Credentials => ({
  accessKeyId: requireSecret(bindings.R2_ACCESS_KEY_ID, "R2_ACCESS_KEY_ID"),
  accountId: requireSecret(bindings.R2_ACCOUNT_ID, "R2_ACCOUNT_ID"),
  bucket: bindings.R2_BUCKET_NAME,
  secretAccessKey: requireSecret(
    bindings.R2_SECRET_ACCESS_KEY,
    "R2_SECRET_ACCESS_KEY"
  )
});

const endpoint = (credentials: R2Credentials, key: string): URL => {
  if (!/^[a-f0-9]+$/i.test(credentials.accountId)) {
    throw new Error("R2_ACCOUNT_ID has an invalid format.");
  }
  const url = new URL(
    "https://" +
      credentials.accountId +
      ".r2.cloudflarestorage.com" +
      canonicalPath(credentials.bucket, key)
  );
  return url;
};

export const presignR2UploadPart = async (
  bindings: Bindings,
  input: {
    contentLength: number;
    expiresSeconds?: number;
    key: string;
    multipartUploadId: string;
    now?: Date;
    partNumber: number;
  }
): Promise<string> => {
  const credentials = credentialsFrom(bindings);
  const url = endpoint(credentials, input.key);
  url.searchParams.set("partNumber", String(input.partNumber));
  url.searchParams.set("uploadId", input.multipartUploadId);
  const time = timestamp(input.now ?? new Date());
  const scope = time.date + "/auto/s3/aws4_request";
  url.searchParams.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
  url.searchParams.set(
    "X-Amz-Credential",
    credentials.accessKeyId + "/" + scope
  );
  url.searchParams.set("X-Amz-Date", time.value);
  url.searchParams.set(
    "X-Amz-Expires",
    String(Math.min(Math.max(input.expiresSeconds ?? 900, 1), 604800))
  );
  url.searchParams.set(
    "X-Amz-SignedHeaders",
    "content-length;content-type;host"
  );

  const canonicalHeaders =
    "content-length:" +
    String(input.contentLength) +
    "\ncontent-type:application/octet-stream\nhost:" +
    url.host +
    "\n";
  const canonicalRequest = [
    "PUT",
    url.pathname,
    canonicalQuery(url.searchParams),
    canonicalHeaders,
    "content-length;content-type;host",
    "UNSIGNED-PAYLOAD"
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    time.value,
    scope,
    await sha256Hex(canonicalRequest)
  ].join("\n");
  const signature = hex(
    await hmac(
      await signingKey(credentials.secretAccessKey, time.date),
      stringToSign
    )
  );
  url.searchParams.set("X-Amz-Signature", signature);
  return url.toString();
};

const signedR2Request = async (
  credentials: R2Credentials,
  input: {
    body?: string;
    key: string;
    method: "POST" | "DELETE";
    query: Record<string, string>;
  }
): Promise<Response> => {
  const url = endpoint(credentials, input.key);
  for (const [key, value] of Object.entries(input.query)) {
    url.searchParams.set(key, value);
  }
  const time = timestamp(new Date());
  const payloadHash = await sha256Hex(input.body ?? "");
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalHeaders =
    "host:" +
    url.host +
    "\n" +
    "x-amz-content-sha256:" +
    payloadHash +
    "\n" +
    "x-amz-date:" +
    time.value +
    "\n";
  const canonicalRequest = [
    input.method,
    url.pathname,
    canonicalQuery(url.searchParams),
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join("\n");
  const scope = time.date + "/auto/s3/aws4_request";
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    time.value,
    scope,
    await sha256Hex(canonicalRequest)
  ].join("\n");
  const signature = hex(
    await hmac(
      await signingKey(credentials.secretAccessKey, time.date),
      stringToSign
    )
  );
  const headers = new Headers({
    Authorization:
      "AWS4-HMAC-SHA256 Credential=" +
      credentials.accessKeyId +
      "/" +
      scope +
      ", SignedHeaders=" +
      signedHeaders +
      ", Signature=" +
      signature,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": time.value
  });
  if (input.body !== undefined) {
    headers.set("Content-Type", "application/xml");
  }

  const requestInit: RequestInit = {
    headers,
    method: input.method
  };
  if (input.body !== undefined) {
    requestInit.body = input.body;
  }
  return await fetch(url, requestInit);
};

const xmlValue = (xml: string, tag: string): string | null => {
  const match = new RegExp("<" + tag + ">([^<]+)</" + tag + ">").exec(xml);
  return (
    match?.[1]
      ?.replaceAll("&amp;", "&")
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&quot;", '"') ?? null
  );
};

const assertR2Response = async (
  response: Response,
  operation: string
): Promise<string> => {
  const body = await response.text();
  if (!response.ok) {
    throw new Error(
      operation +
        " failed with R2 status " +
        String(response.status) +
        (body.length > 0 ? ": " + body.slice(0, 300) : ".")
    );
  }
  return body;
};

export const createR2MultipartUpload = async (
  bindings: Bindings,
  key: string
): Promise<string> => {
  const response = await signedR2Request(credentialsFrom(bindings), {
    key,
    method: "POST",
    query: { uploads: "" }
  });
  const body = await assertR2Response(response, "Create multipart upload");
  const uploadId = xmlValue(body, "UploadId");
  if (uploadId === null) {
    throw new Error("R2 did not return a multipart upload ID.");
  }
  return uploadId;
};

const xmlEscape = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

export const completeR2MultipartUpload = async (
  bindings: Bindings,
  input: {
    key: string;
    multipartUploadId: string;
    parts: { etag: string; partNumber: number }[];
  }
): Promise<void> => {
  const body =
    "<CompleteMultipartUpload>" +
    input.parts
      .slice()
      .sort((left, right) => left.partNumber - right.partNumber)
      .map(
        part =>
          "<Part><PartNumber>" +
          String(part.partNumber) +
          "</PartNumber><ETag>" +
          xmlEscape(part.etag) +
          "</ETag></Part>"
      )
      .join("") +
    "</CompleteMultipartUpload>";
  const response = await signedR2Request(credentialsFrom(bindings), {
    body,
    key: input.key,
    method: "POST",
    query: { uploadId: input.multipartUploadId }
  });
  await assertR2Response(response, "Complete multipart upload");
};

export const abortR2MultipartUpload = async (
  bindings: Bindings,
  key: string,
  multipartUploadId: string
): Promise<void> => {
  const response = await signedR2Request(credentialsFrom(bindings), {
    key,
    method: "DELETE",
    query: { uploadId: multipartUploadId }
  });
  if (response.status === 404) {
    return;
  }
  const body = await response.clone().text();
  if (response.status === 400 && body.includes("NoSuchUpload")) {
    return;
  }
  await assertR2Response(response, "Abort multipart upload");
};
