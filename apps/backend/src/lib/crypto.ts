const encoder = new TextEncoder();
const decoder = new TextDecoder();

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
};

const bytesToBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
};

const base64UrlToBytes = (value: string): Uint8Array => {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(normalized + padding);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
};

const importAesKey = async (encodedKey: string): Promise<CryptoKey> => {
  const raw = base64UrlToBytes(encodedKey);
  if (raw.byteLength !== 32) {
    throw new Error("TOKEN_ENCRYPTION_KEY must be a 32-byte base64url value.");
  }

  return await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(raw),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"]
  );
};

export const randomToken = (byteLength = 32): string => {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
};

const sha256 = async (value: string | Uint8Array): Promise<Uint8Array> => {
  const input = typeof value === "string" ? encoder.encode(value) : value;
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", toArrayBuffer(input))
  );
};

export const sha256Base64Url = async (
  value: string | Uint8Array
): Promise<string> => bytesToBase64Url(await sha256(value));

export const sha256Hex = async (value: string | Uint8Array): Promise<string> =>
  Array.from(await sha256(value), byte =>
    byte.toString(16).padStart(2, "0")
  ).join("");

export const hmacBase64Url = async (
  secret: string,
  value: string
): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(encoder.encode(secret)),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    toArrayBuffer(encoder.encode(value))
  );
  return bytesToBase64Url(new Uint8Array(signature));
};

export const hmacSha256Hex = async (
  secret: string,
  value: string
): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(encoder.encode(secret)),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    toArrayBuffer(encoder.encode(value))
  );
  return Array.from(new Uint8Array(signature), byte =>
    byte.toString(16).padStart(2, "0")
  ).join("");
};

export const constantTimeEqual = (left: string, right: string): boolean => {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;

  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }

  return difference === 0;
};

export const encryptJson = async (
  value: unknown,
  encodedKey: string,
  keyVersion = 1
): Promise<string> => {
  const key = await importAesKey(encodedKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { iv: toArrayBuffer(iv), name: "AES-GCM" },
    key,
    toArrayBuffer(encoder.encode(JSON.stringify(value)))
  );

  return [
    "v" + String(keyVersion),
    bytesToBase64Url(iv),
    bytesToBase64Url(new Uint8Array(ciphertext))
  ].join(".");
};

export const decryptJson = async <T>(
  value: string,
  encodedKey: string
): Promise<T> => {
  const [version, encodedIv, encodedCiphertext, extra] = value.split(".");
  if (
    version === undefined ||
    !/^v\d+$/.test(version) ||
    encodedIv === undefined ||
    encodedCiphertext === undefined ||
    extra !== undefined
  ) {
    throw new Error("Encrypted value has an invalid envelope.");
  }

  const key = await importAesKey(encodedKey);
  const plaintext = await crypto.subtle.decrypt(
    { iv: toArrayBuffer(base64UrlToBytes(encodedIv)), name: "AES-GCM" },
    key,
    toArrayBuffer(base64UrlToBytes(encodedCiphertext))
  );

  return JSON.parse(decoder.decode(plaintext)) as T;
};

const passwordIterations = 600_000;

export const hashPassword = async (password: string): Promise<string> => {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(encoder.encode(password)),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    {
      hash: "SHA-256",
      iterations: passwordIterations,
      name: "PBKDF2",
      salt: toArrayBuffer(salt)
    },
    key,
    256
  );

  return [
    "pbkdf2_sha256",
    String(passwordIterations),
    bytesToBase64Url(salt),
    bytesToBase64Url(new Uint8Array(bits))
  ].join("$");
};

export const verifyPassword = async (
  password: string,
  encodedHash: string
): Promise<boolean> => {
  const [algorithm, iterationText, encodedSalt, expected, extra] =
    encodedHash.split("$");
  const iterations = Number(iterationText);
  if (
    algorithm !== "pbkdf2_sha256" ||
    !Number.isSafeInteger(iterations) ||
    iterations < 100_000 ||
    encodedSalt === undefined ||
    expected === undefined ||
    extra !== undefined
  ) {
    return false;
  }

  const key = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(encoder.encode(password)),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    {
      hash: "SHA-256",
      iterations,
      name: "PBKDF2",
      salt: toArrayBuffer(base64UrlToBytes(encodedSalt))
    },
    key,
    256
  );

  return constantTimeEqual(bytesToBase64Url(new Uint8Array(bits)), expected);
};
