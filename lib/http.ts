import { authenticated, validOrigin } from "./security";
import { rateLimit } from "./db";
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function json(data: unknown, status = 200, headers?: HeadersInit) {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...Object.fromEntries(new Headers(headers).entries()),
    },
  });
}
export function protect(r: Request, mutating = false) {
  if (!authenticated(r)) throw new HttpError(401, "Sign in required");
  if (mutating && !validOrigin(r))
    throw new HttpError(403, "Invalid request origin");
}
export async function limit(key: string, count: number, seconds = 60) {
  if (!process.env.DATABASE_URL)
    throw new HttpError(503, "Database setup required");
  if (!(await rateLimit(key, count, seconds)))
    throw new HttpError(429, "Too many requests; try again later");
}
export async function body(r: Request) {
  let text = "";
  const reader = r.body?.getReader();
  if (!reader) throw new HttpError(400, "JSON body required");
  const decoder = new TextDecoder();
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 16000) {
      await reader.cancel();
      throw new HttpError(413, "Request body too large");
    }
    text += decoder.decode(value, { stream: true });
  }
  try {
    return JSON.parse(text + decoder.decode());
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}
export function endpoint<A extends unknown[]>(
  fn: (r: Request, ...args: A) => Promise<Response>,
) {
  return async (r: Request, ...args: A) => {
    try {
      return await fn(r, ...args);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      if (e instanceof Error && e.name === "ZodError")
        return json({ error: "Invalid request values" }, 400);
      return json(
        {
          error:
            "Operation unavailable. Check server configuration, database migration and integration credentials.",
        },
        503,
      );
    }
  };
}
export function weeks(value: unknown) {
  const n = Number(value ?? 1);
  if (!Number.isInteger(n) || n < 1 || n > 8)
    throw new HttpError(400, "weeks must be between 1 and 8");
  return n;
}
export function missingConfiguration() {
  const missing = [
    "DATABASE_URL",
    "APP_URL",
    "OWNER_PASSWORD",
    "SESSION_SECRET",
    "TOKEN_ENCRYPTION_KEY",
    "OWNER_EMAILS",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "OPENAI_API_KEY",
    "OPENAI_MODEL",
  ].filter((k) => !process.env[k]);
  if (process.env.OWNER_PASSWORD && process.env.OWNER_PASSWORD.length < 16)
    missing.push("OWNER_PASSWORD (minimum 16 characters)");
  if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.length < 32)
    missing.push("SESSION_SECRET (minimum 32 characters)");
  if (
    process.env.TOKEN_ENCRYPTION_KEY &&
    Buffer.from(process.env.TOKEN_ENCRYPTION_KEY, "base64").length !== 32
  )
    missing.push("TOKEN_ENCRYPTION_KEY (32 base64 bytes)");
  const emails = (process.env.OWNER_EMAILS || "").split(",").filter(Boolean);
  if (
    emails.length > 2 ||
    emails.some((e) => !/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(e.trim()))
  )
    missing.push("OWNER_EMAILS (one or two exact email addresses)");
  return missing;
}
