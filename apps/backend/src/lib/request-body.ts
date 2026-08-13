import { AppError } from "./errors";

export const readLimitedText = async (
  request: Request,
  maximumBytes: number,
  error: { code: string; message: string }
): Promise<string> => {
  const declaredLength = request.headers.get("Content-Length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (Number.isFinite(parsedLength) && parsedLength > maximumBytes) {
      throw new AppError(413, error.code, error.message);
    }
  }
  if (request.body === null) {
    return "";
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = "";
  for (;;) {
    const result = await reader.read();
    if (result.done) {
      text += decoder.decode();
      return text;
    }
    bytesRead += result.value.byteLength;
    if (bytesRead > maximumBytes) {
      try {
        await reader.cancel();
      } catch {
        // The byte limit remains authoritative if the peer closes during cancellation.
      }
      throw new AppError(413, error.code, error.message);
    }
    text += decoder.decode(result.value, { stream: true });
  }
};
