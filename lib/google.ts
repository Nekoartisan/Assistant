import { randomBytes, createHash } from "node:crypto";
import { sign, decrypt, encrypt, verify } from "./security";
import { db } from "./db";
import type { Fact } from "./extraction";
export const GOOGLE_SCOPES =
  "openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.readonly";
export function allowedEmail(email: string) {
  const list = (process.env.OWNER_EMAILS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return (
    list.length > 0 && list.length <= 2 && list.includes(email.toLowerCase())
  );
}
export function gmailUrl(account: string, threadId: string) {
  return `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(account)}#all/${encodeURIComponent(threadId)}`;
}
export function oauthStart() {
  const verifier = randomBytes(32).toString("base64url"),
    nonce = randomBytes(32).toString("base64url");
  const state = sign({ nonce, verifier }, 600);
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID || "",
    redirect_uri: process.env.APP_URL + "/api/google/callback",
    response_type: "code",
    scope: GOOGLE_SCOPES,
    access_type: "offline",
    prompt: "consent select_account",
    state: nonce,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  }).toString();
  return { url: url.toString(), state };
}
function readSignal(stopAt: number, cap: number) {
  const remaining = Math.floor(stopAt - Date.now());
  if (remaining <= 0) throw new Error("Time budget reached before Google request.");
  return AbortSignal.timeout(Math.min(cap, remaining));
}
async function tokenRequest(data: Record<string, string>, stopAt?: number) {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({
      ...data,
      client_id: process.env.GOOGLE_CLIENT_ID || "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET || "",
    }),
    signal: readSignal(stopAt ?? Date.now() + 12000, stopAt === undefined ? 12000 : 4000),
  });
  if (!r.ok)
    throw new Error(
      "Google authorization expired or unavailable; reconnect account.",
    );
  return r.json();
}
export async function oauthFinish(code: string, nonce: string, cookie: string) {
  const state = verify(cookie);
  if (!state || state.nonce !== nonce || typeof state.verifier !== "string")
    throw new Error("Invalid OAuth state");
  const used =
    await db()`insert into state(key,value) values(${"oauth:" + nonce},'true') on conflict do nothing returning key`;
  if (!used.length) throw new Error("OAuth state already used");
  const t = await tokenRequest({
    code,
    grant_type: "authorization_code",
    redirect_uri: process.env.APP_URL + "/api/google/callback",
    code_verifier: state.verifier,
  });
  const scopes = String(t.scope || "").split(" ");
  if (
    !scopes.includes("https://www.googleapis.com/auth/gmail.readonly") ||
    !scopes.includes("https://www.googleapis.com/auth/calendar.readonly")
  )
    throw new Error("Required readonly scopes not granted");
  const r = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${t.access_token}` },
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error("Cannot verify Google account");
  const u = await r.json();
  if (
    u.email_verified !== true ||
    typeof u.email !== "string" ||
    !allowedEmail(u.email)
  )
    throw new Error("Google account is not allowlisted");
  const email = u.email.toLowerCase();
  if (!t.refresh_token)
    throw new Error(
      "No refresh token granted; revoke app consent and reconnect.",
    );
  await db()`insert into accounts(email,refresh_token) values(${email},${encrypt(t.refresh_token)}) on conflict(email) do update set refresh_token=excluded.refresh_token,gap=null`;
  return email;
}
export async function googleAccess(encrypted: string, stopAt = Date.now() + 12000) {
  const t = await tokenRequest({
    grant_type: "refresh_token",
    refresh_token: decrypt(encrypted),
  }, stopAt);
  if (typeof t.access_token !== "string")
    throw new Error("Google access token unavailable");
  return t.access_token as string;
}
export async function googleGet<T>(url: string, token: string, stopAt = Date.now() + 12000): Promise<T> {
  const u = new URL(url);
  if (
    u.protocol !== "https:" ||
    !["gmail.googleapis.com", "www.googleapis.com"].includes(u.hostname)
  )
    throw new Error("Invalid Google API host");
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: readSignal(stopAt, 4000),
  });
  if (!r.ok) {
    const e = new Error(`Google read failed (${r.status})`) as Error & {
      status: number;
    };
    e.status = r.status;
    throw e;
  }
  return r.json();
}
export interface CalendarEvent {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  status?: string;
  updated?: string;
  htmlLink?: string;
  start?: { date?: string; dateTime?: string; timeZone?: string };
  end?: { date?: string; dateTime?: string; timeZone?: string };
}
export function calendarFacts(e: CalendarEvent): Fact[] {
  if (e.status === "cancelled")
    return [
      {
        key: "cancelled",
        title: e.summary || "Cancelled event",
        kind: "event",
        dueAt: null,
        dateOnly: null,
        timezone: null,
        originalDateText: "cancelled",
        evidence: "cancelled",
        confidence: 1,
        cancelled: true,
      },
    ];
  return (["start", "end"] as const).flatMap((boundary) => {
    const d = e[boundary];
    if (!d) return [];
    const original = d.dateTime || d.date || "";
    return [
      {
        key: boundary,
        title:
          (e.summary || "Untitled event") +
          (boundary === "end" ? " — ends" : ""),
        kind: "event" as const,
        dueAt: d.dateTime || null,
        dateOnly: d.date || null,
        timezone: d.timeZone || null,
        originalDateText: original,
        evidence: JSON.stringify(d),
        confidence: 1,
        cancelled: false,
        notes:
          boundary === "end" && d.date
            ? "Calendar all-day end date is exclusive."
            : undefined,
        location: e.location,
      },
    ];
  });
}
