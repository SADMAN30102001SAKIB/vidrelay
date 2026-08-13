import type { Context } from "hono";
import type { ZodType } from "zod";

import type { AppEnv } from "../env";
import { AppError } from "./errors";
import { readLimitedText } from "./request-body";

const maximumJsonBytes = 256 * 1024;

export const parseJson = async <T>(
  context: Context<AppEnv>,
  schema: ZodType<T>
): Promise<T> => {
  let input: unknown;
  const raw = await readLimitedText(context.req.raw, maximumJsonBytes, {
    code: "json_too_large",
    message: "The JSON request body is too large."
  });
  try {
    input = JSON.parse(raw);
  } catch {
    throw new AppError(
      400,
      "invalid_json",
      "The request body must be valid JSON."
    );
  }

  const result = schema.safeParse(input);
  if (!result.success) {
    throw new AppError(422, "validation_failed", "Some fields are invalid.", {
      issues: result.error.issues.map(issue => ({
        message: issue.message,
        path: issue.path.join(".")
      }))
    });
  }

  return result.data;
};
