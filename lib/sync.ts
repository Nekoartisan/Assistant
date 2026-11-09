import { createHash } from "node:crypto";
import { db, claimLease, releaseLease, saveFacts, setState } from "./db";
import {
  googleAccess,
  googleGet,
  gmailUrl,
  allowedEmail,
  calendarFacts,
  type CalendarEvent,
} from "./google";
import {
  parseMailBody,
  validateFacts,
  type MimePart,
  type Fact,
} from "./extraction";
import { extractThread } from "./llm";
import { syncNews } from "./news";
interface Cursor {
  mailComplete?: boolean;
  mailQueue?: string[];
  mailPage?: string | null;
  mailListingDone?: boolean;
  historyId?: string;
  historyPage?: string | null;
  historyTarget?: string;
  lookback?: number;
  calendars?: { id: string }[];
  calendarIndex?: number;
  calendarPage?: string | null;
  calendarStart?: string;
  calendarEnd?: string;
  calendarComplete?: boolean;
  historyGap?: string;
  attachmentGaps?: string[];
}
interface Account {
  email: string;
  refresh_token: string;
  cursor?: Cursor;
}
interface MailPart extends MimePart {
  filename?: string;
  parts?: MailPart[];
}
interface MailMessage {
  id: string;
  internalDate?: string;
  payload: MailPart;
}
async function storeCursor(email: string, c: Cursor) {
  await db()`update accounts set cursor=${db().json(c as never)} where email=${email}`;
}
async function source(
  email: string,
  kind: string,
  id: string,
  body: string,
  url: string,
) {
  const sid = `${email}:${kind}:${id}`;
  const revision = createHash("sha256").update(body).digest("hex");
  const prev =
    await db()`select revision,extracted from sources where id=${sid}`;
  if (prev[0]?.revision === revision && prev[0]?.extracted)
    return { id: sid, unchanged: true };
  await db()`update items set data=jsonb_set(data,'{status}','"needs_review"') where source_id=${sid} and data->>'status'='open'`;
  await db()`insert into sources(id,account,kind,body,url,revision) values(${sid},${email},${kind},${body},${url},${revision}) on conflict(id) do update set body=excluded.body,revision=excluded.revision,extracted=false,updated_at=now()`;
  return { id: sid, unchanged: false };
}
async function hydrate(
  part: MailPart,
  messageId: string,
  token: string,
  gaps: string[],
  email: string,
) {
  if (
    part.filename &&
    !["text/plain", "text/html"].includes(part.mimeType || "")
  ) {
    gaps.push(
      `${email}: attachment not read (${part.filename.slice(0, 100)}); attachment-only deadlines require manual review.`,
    );
    return;
  }
  if (
    part.body?.attachmentId &&
    ["text/plain", "text/html"].includes(part.mimeType || "")
  ) {
    const a = await googleGet<{ data: string; size: number }>(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(part.body.attachmentId)}`,
      token,
    );
    if (a.size > 1500000)
      throw new Error(
        "Email body attachment too large; manual review required",
      );
    part.body.data = a.data;
  }
  for (const p of part.parts || [])
    await hydrate(p, messageId, token, gaps, email);
}
async function mailThread(
  email: string,
  id: string,
  token: string,
  gaps: string[],
) {
  let thread: { messages?: MailMessage[] };
  try {
    thread = await googleGet(
      `https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(id)}?format=full`,
      token,
    );
  } catch (e) {
    if ((e as { status?: number }).status === 404) {
      await db()`update items set data=jsonb_set(data,'{status}','"dismissed"') where source_id=${`${email}:mail:${id}`}`;
      return;
    }
    throw e;
  }
  if (!thread.messages?.length) throw new Error("Thread body unavailable");
  for (const m of thread.messages)
    await hydrate(m.payload, m.id, token, gaps, email);
  const body = thread.messages
    .map((m) => parseMailBody(m.payload))
    .join("\n\n");
  const url = gmailUrl(email, id);
  const s = await source(email, "mail", id, body, url);
  if (s.unchanged) return;
  const previousRows =
    await db()`select fact_key,data from items where source_id=${s.id}`;
  const previous: Fact[] = previousRows.map((r) => ({
    ...r.data,
    key: r.fact_key,
    cancelled: r.data.status === "dismissed",
  }));
  const receivedAt = new Date(
    Number(thread.messages.at(-1)?.internalDate || Date.now()),
  ).toISOString();
  const facts = await extractThread(body, receivedAt, previous);
  await saveFacts(s.id, email, url, facts);
}
async function enqueueMail(email: string, c: Cursor, token: string) {
  if (!c.historyId) {
    const p = await googleGet<{ historyId: string }>(
      "https://gmail.googleapis.com/gmail/v1/users/me/profile",
      token,
    );
    c.historyId = p.historyId;
    c.lookback = Math.floor(Date.now() / 1000) - 90 * 86400;
    await storeCursor(email, c);
  }
  if (!c.mailComplete) {
    if (c.mailListingDone) return;
    const q = new URLSearchParams({
      maxResults: "10",
      includeSpamTrash: "true",
      q: `after:${c.lookback}`,
      ...(c.mailPage ? { pageToken: c.mailPage } : {}),
    });
    const page = await googleGet<{
      threads?: { id: string }[];
      nextPageToken?: string;
    }>(`https://gmail.googleapis.com/gmail/v1/users/me/threads?${q}`, token);
    c.mailQueue = (page.threads || []).map((t) => t.id);
    c.mailPage = page.nextPageToken || null;
    c.mailListingDone = !page.nextPageToken;
  } else {
    const q = new URLSearchParams({
      startHistoryId: c.historyId,
      maxResults: "100",
      ...(c.historyPage ? { pageToken: c.historyPage } : {}),
    });
    const page = await googleGet<{
      history?: {
        messages?: { threadId: string }[];
        messagesAdded?: { message: { threadId: string } }[];
        messagesDeleted?: { message: { threadId: string } }[];
      }[];
      nextPageToken?: string;
      historyId: string;
    }>(`https://gmail.googleapis.com/gmail/v1/users/me/history?${q}`, token);
    c.mailQueue = [
      ...new Set(
        (page.history || []).flatMap((h) => [
          ...(h.messages || []).map((m) => m.threadId),
          ...(h.messagesAdded || []).map((m) => m.message.threadId),
          ...(h.messagesDeleted || []).map((m) => m.message.threadId),
        ]),
      ),
    ];
    c.historyPage = page.nextPageToken || null;
    c.historyTarget = page.historyId;
  }
  await storeCursor(email, c);
}
async function syncCalendar(
  email: string,
  c: Cursor,
  token: string,
  gaps: string[],
) {
  if (!c.calendars || c.calendarComplete) {
    const list = await googleGet<{
      items?: { id: string }[];
      nextPageToken?: string;
    }>(
      "https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250",
      token,
    );
    c.calendars = list.items || [];
    if (list.nextPageToken)
      gaps.push(
        `${email}: calendar list exceeds 250 calendars; remaining calendars not read.`,
      );
    c.calendarIndex = 0;
    c.calendarPage = null;
    c.calendarComplete = false;
    c.calendarStart = new Date(Date.now() - 90 * 86400000).toISOString();
    c.calendarEnd = new Date(Date.now() + 365 * 86400000).toISOString();
    await storeCursor(email, c);
  }
  const calendar = c.calendars[c.calendarIndex || 0];
  if (!calendar) {
    c.calendarComplete = true;
    await storeCursor(email, c);
    return;
  }
  const q = new URLSearchParams({
    singleEvents: "true",
    showDeleted: "true",
    maxResults: "100",
    timeMin: c.calendarStart!,
    timeMax: c.calendarEnd!,
    ...(c.calendarPage ? { pageToken: c.calendarPage } : {}),
  });
  const page = await googleGet<{
    items?: CalendarEvent[];
    nextPageToken?: string;
  }>(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendar.id)}/events?${q}`,
    token,
  );
  for (const e of page.items || []) {
    const body = JSON.stringify(e);
    const url = e.htmlLink?.startsWith("https://calendar.google.com/")
      ? e.htmlLink
      : "https://calendar.google.com/calendar/u/0/r";
    const s = await source(
      email,
      "calendar",
      calendar.id + ":" + e.id,
      body,
      url,
    );
    if (!s.unchanged) {
      const facts = validateFacts({ facts: calendarFacts(e) }, body);
      await saveFacts(s.id, email, url, facts);
    }
  }
  c.calendarPage = page.nextPageToken || null;
  if (!page.nextPageToken) c.calendarIndex = (c.calendarIndex || 0) + 1;
  if ((c.calendarIndex || 0) >= c.calendars.length) c.calendarComplete = true;
  await storeCursor(email, c);
}
export async function syncAccount(
  account: Account,
  budget: number,
  stopAt: number,
) {
  const gaps: string[] = [];
  let processed = 0;
  const email = account.email;
  if (!allowedEmail(email))
    throw new Error("Stored account is not allowlisted");
  const c: Cursor = structuredClone(account.cursor || {});
  const token = await googleAccess(account.refresh_token);
  try {
    if (!process.env.OPENAI_API_KEY || !process.env.OPENAI_MODEL)
      gaps.push(`${email}: model API missing; mail extraction is paused.`);
    else {
      if (!c.mailQueue?.length) await enqueueMail(email, c, token);
      while (c.mailQueue?.length && processed < budget && Date.now() < stopAt) {
        await mailThread(email, c.mailQueue[0], token, gaps);
        c.mailQueue.shift();
        processed++;
        await storeCursor(email, c);
      }
      if (!c.mailQueue?.length) {
        if (c.mailListingDone) c.mailComplete = true;
        if (c.mailComplete && !c.historyPage && c.historyTarget) {
          c.historyId = c.historyTarget;
          delete c.historyTarget;
        }
        await storeCursor(email, c);
      }
    }
  } catch (e) {
    if ((e as { status?: number }).status === 404) {
      c.mailComplete = false;
      c.mailListingDone = false;
      c.mailPage = null;
      c.mailQueue = [];
      delete c.historyId;
      c.historyGap = `${email}: Gmail history expired; 90-day backfill restarted. Older stored facts may be stale.`;
      await storeCursor(email, c);
    } else
      gaps.push(
        `${email}: email extraction paused; saved cursor will retry. ${safeSyncError(e)}`,
      );
  }
  if (Date.now() < stopAt) {
    try {
      await syncCalendar(email, c, token, gaps);
    } catch {
      gaps.push(`${email}: calendar read failed; saved page will retry.`);
    }
  }
  if (!c.mailComplete)
    gaps.push(`${email}: initial 90-day mail backfill incomplete.`);
  if (!c.calendarComplete)
    gaps.push(`${email}: calendar window scan incomplete.`);
  if (c.historyGap) gaps.push(c.historyGap);
  const attachments = [
    ...new Set([
      ...(c.attachmentGaps || []),
      ...gaps.filter((g) => g.includes("attachment not read")),
    ]),
  ].slice(-100);
  c.attachmentGaps = attachments;
  gaps.push(...attachments);
  await storeCursor(email, c);
  await db()`update accounts set last_sync_at=now(),gap=${gaps.length ? [...new Set(gaps)].join("\n") : null} where email=${email}`;
  return { processed, gaps: [...new Set(gaps)] };
}
function safeSyncError(e: unknown) {
  const m = e instanceof Error ? e.message : "";
  return /^(Model |Evidence |Full thread |Email body|Thread body)/.test(m)
    ? m
    : "Integration unavailable; check provider configuration.";
}
export async function runSync() {
  const lease = await claimLease("sync", 180);
  if (!lease)
    return {
      ok: false,
      summary: "A sync is already in progress.",
      gaps: ["Retry after the current bounded sync finishes."],
    };
  const gaps: string[] = [];
  let processed = 0;
  const stopAt = Date.now() + 28000;
  try {
    const news = await syncNews();
    gaps.push(...news.gaps);
    const accounts =
      await db()`select * from accounts order by last_sync_at nulls first`;
    if (!accounts.length) gaps.push("No Google accounts connected.");
    for (const a of accounts) {
      if (Date.now() >= stopAt) {
        gaps.push("Time budget reached; saved cursors continue on next sync.");
        break;
      }
      try {
        const r = await syncAccount(
          a as unknown as Account,
          Math.max(1, Math.floor(10 / accounts.length)),
          stopAt,
        );
        processed += r.processed;
        gaps.push(...r.gaps);
      } catch {
        gaps.push(
          `${a.email}: Google authorization unavailable; reconnect if expired.`,
        );
      }
    }
    const lastSyncAt = new Date().toISOString();
    await setState("sync", { gaps: [...new Set(gaps)], lastSyncAt });
    return {
      ok: true,
      summary: `Processed ${processed} full email threads; stored ${news.count} research entries. Coverage is limited to completed pages; see gaps.`,
      gaps: [...new Set(gaps)],
    };
  } finally {
    await releaseLease("sync", lease);
  }
}
