import { createHash } from "node:crypto";
import { db, claimLease, releaseLease, saveFacts, setState, getState } from "./db";
import {
  googleAccess,
  googleGet,
  gmailUrl,
  allowedEmail,
  type CalendarEvent,
} from "./google";
import {
  parseMailBody,
  type MimePart,
  type Fact,
} from "./extraction";
import { extractThread } from "./llm";
import { syncNews } from "./news";
import { saveCalendarPage } from "./bulk-facts";
interface Cursor {
  mailComplete?: boolean;
  mailQueue?: string[];
  mailRetries?: Record<string, { attempts: number; nextRetryAt: string; reason: string }>;
  mailPage?: string | null;
  mailListingDone?: boolean;
  historyId?: string;
  historyPage?: string | null;
  historyTarget?: string;
  lookback?: number;
  calendars?: { id: string }[];
  calendarIndex?: number;
  calendarPage?: string | null;
  calendarQueue?: CalendarEvent[];
  calendarNext?: string | null;
  calendarStart?: string;
  calendarEnd?: string;
  calendarComplete?: boolean;
  calendarSyncedAt?: string;
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
  stopAt: number,
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
      stopAt,
    );
    if (a.size > 1500000)
      throw new Error(
        "Email body attachment too large; manual review required",
      );
    part.body.data = a.data;
  }
  for (const p of part.parts || [])
    await hydrate(p, messageId, token, gaps, email, stopAt);
}
async function mailThread(
  email: string,
  id: string,
  token: string,
  gaps: string[],
  stopAt: number,
) {
  let thread: { messages?: MailMessage[] };
  try {
    thread = await googleGet(
      `https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(id)}?format=full`,
      token,
      stopAt,
    );
  } catch (e) {
    if ((e as { status?: number }).status === 404) {
      await db()`update items set data=jsonb_set(data,'{status}','"dismissed"') where source_id=${`${email}:mail:${id}`}`;
      return false;
    }
    throw e;
  }
  if (!thread.messages?.length) throw new Error("Thread body unavailable");
  for (const m of thread.messages)
    await hydrate(m.payload, m.id, token, gaps, email, stopAt);
  // Keep full message bodies and quoted subject evidence in chronological order.
  // Transport timestamps are explicitly metadata, never obligation evidence.
  const messages = [...thread.messages].sort((a, b) => Number(a.internalDate || 0) - Number(b.internalDate || 0));
  const body = messages.map(m => {
    const headers = m.payload.headers || [];
    const header = (name: string) => headers.filter(h => h.name.toLowerCase() === name.toLowerCase()).map(h => `${name}: ${h.value}`).join('\n');
    const date = header('Date') || `Date metadata (internalDate fallback): ${m.internalDate ? new Date(Number(m.internalDate)).toISOString() : 'unavailable'}`;
    return [`Message ID: ${m.id || 'unavailable'}`, header('Subject'), header('From'), date, 'Full body:', parseMailBody(m.payload)].filter(Boolean).join('\n');
  }).join('\n\n--- next message ---\n\n');
  const url = gmailUrl(email, id);
  const s = await source(email, "mail", id, body, url);
  if (s.unchanged) return true;
  const previousRows =
    await db()`select fact_key,data from items where source_id=${s.id}`;
  const previous: Fact[] = previousRows.map((r) => ({
    ...r.data,
    key: r.fact_key,
    cancelled: r.data.status === "dismissed",
  }));
  const receivedAt = new Date(
    Number(messages.at(-1)?.internalDate || Date.now()),
  ).toISOString();
  if (Date.now() >= stopAt) throw new Error("Time budget reached before mail extraction.");
  const facts = await extractThread(body, receivedAt, previous, Math.max(1, Math.floor(Math.min(20000, stopAt - Date.now()))));
  await saveFacts(s.id, email, url, facts);
  return true;
}
async function enqueueMail(email: string, c: Cursor, token: string, stopAt: number) {
  if (!c.historyId) {
    const p = await googleGet<{ historyId: string }>(
      "https://gmail.googleapis.com/gmail/v1/users/me/profile",
      token,
      stopAt,
    );
    c.historyId = p.historyId;
    c.lookback = Math.floor(Date.now() / 1000) - 90 * 86400;
    await storeCursor(email, c);
  }
  if (!c.mailListingDone && !c.mailComplete) {
    const q = new URLSearchParams({
      maxResults: "10",
      includeSpamTrash: "true",
      q: `after:${c.lookback}`,
      ...(c.mailPage ? { pageToken: c.mailPage } : {}),
    });
    const page = await googleGet<{
      threads?: { id: string }[];
      nextPageToken?: string;
    }>(`https://gmail.googleapis.com/gmail/v1/users/me/threads?${q}`, token, stopAt);
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
    }>(`https://gmail.googleapis.com/gmail/v1/users/me/history?${q}`, token, stopAt);
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
    if (page.historyId !== c.historyId || page.nextPageToken || c.mailQueue.length)
      c.historyTarget = page.historyId;
  }
  // Failed IDs stay exclusively in the durable retry lane, including history duplicates.
  c.mailQueue = [...new Set(c.mailQueue || [])].filter(id => !c.mailRetries?.[id]);
  await storeCursor(email, c);
}
async function syncCalendar(
  email: string,
  c: Cursor,
  token: string,
  gaps: string[],
  stopAt: number,
  progress: (count: number) => void,
) {
  // Backfill continuation must not repeatedly restart an already-fresh calendar scan.
  const completedAt = Date.parse(c.calendarSyncedAt || '');
  if (c.calendarComplete && Number.isFinite(completedAt) && Date.now() - completedAt < 15 * 60000) return;
  if (!c.calendars || c.calendarComplete) {
    const list = await googleGet<{ items?: { id: string }[]; nextPageToken?: string }>(
      "https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250", token, stopAt,
    );
    c.calendars = list.items || [];
    if (list.nextPageToken)
      gaps.push(`${email}: calendar list exceeds 250 calendars; remaining calendars not read.`);
    c.calendarIndex = 0;
    c.calendarPage = null;
    delete c.calendarQueue;
    delete c.calendarNext;
    c.calendarComplete = false;
    c.calendarStart = new Date(Date.now() - 90 * 86400000).toISOString();
    c.calendarEnd = new Date(Date.now() + 365 * 86400000).toISOString();
    await storeCursor(email, c);
    progress(0);
  }
  // Empty calendars and full pages may advance repeatedly within the same frozen phase.
  for (let page = 0; page < 32 && Date.now() < stopAt; page++) {
    const calendar = c.calendars[c.calendarIndex || 0];
    if (!calendar) {
      if (!c.calendarComplete) {
        c.calendarComplete = true;
        c.calendarSyncedAt = new Date().toISOString();
        await storeCursor(email, c);
        progress(0);
      }
      break;
    }
    if (!c.calendarQueue) {
      const q = new URLSearchParams({
        singleEvents: "true", showDeleted: "true", maxResults: "100",
        timeMin: c.calendarStart!, timeMax: c.calendarEnd!,
        ...(c.calendarPage ? { pageToken: c.calendarPage } : {}),
      });
      const result = await googleGet<{items?: CalendarEvent[]; nextPageToken?: string}>(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendar.id)}/events?${q}`, token, stopAt,
      );
      c.calendarQueue = result.items || [];
      c.calendarNext = result.nextPageToken || null;
      await storeCursor(email, c);
    }
    if (Date.now() >= stopAt) break;
    const next: Cursor = structuredClone(c);
    next.calendarPage = c.calendarNext || null;
    if (!c.calendarNext) next.calendarIndex = (c.calendarIndex || 0) + 1;
    next.calendarComplete = (next.calendarIndex || 0) >= c.calendars.length;
    if (next.calendarComplete) next.calendarSyncedAt = new Date().toISOString();
    delete next.calendarQueue;
    delete next.calendarNext;
    // Source/item writes and page advancement are one transaction, including old queues.
    const changed = await saveCalendarPage(email, calendar.id, c.calendarQueue, next);
    Object.assign(c, next);
    delete c.calendarQueue;
    delete c.calendarNext;
    progress(changed);
    if (c.calendarComplete) break;
  }
}
export async function syncAccount(
  account: Account,
  budget: number,
  stopAt: number,
  onPhase?: (phase: string) => Promise<void>,
) {
  const gaps: string[] = [];
  let processed = 0;
  let calendarProcessed = 0;
  let madeProgress = false;
  let attempted = 0;
  const email = account.email;
  if (!allowedEmail(email))
    throw new Error("Stored account is not allowlisted");
  const c: Cursor = structuredClone(account.cursor || {});
  // Keep a small independent calendar turn even when mail hits its deadline.
  const mailStopAt = stopAt - Math.min(3000, Math.max(0, stopAt - Date.now()) / 5);
  await onPhase?.("authorization");
  const token = await googleAccess(account.refresh_token, mailStopAt);
  try {
    await onPhase?.("mail");
    if (!process.env.OPENAI_API_KEY || !process.env.OPENAI_MODEL)
      gaps.push(`${email}: model API missing; mail extraction is paused.`);
    else {
      c.mailRetries ||= {};
      c.mailQueue = [...new Set(c.mailQueue || [])].filter(id => !c.mailRetries![id]);
      if (c.mailComplete) c.mailListingDone = true; // legacy cursors
      const attemptedIds = new Set<string>();
      let pages = 0;
      let historyFinished = false;
      // Retry at most two due failures per turn, leaving a fair share for discovery.
      const dueRetries = Object.keys(c.mailRetries).filter(id => Date.parse(c.mailRetries![id].nextRetryAt) <= Date.now()).slice(0, Math.min(2, budget));
      while (attempted < Math.min(8, budget) && Date.now() < mailStopAt) {
        if (!c.mailQueue.length && !historyFinished && pages < 16) {
          const history = !!c.mailListingDone;
          const before = JSON.stringify(c);
          await enqueueMail(email, c, token, mailStopAt);
          pages++;
          if (JSON.stringify(c) !== before) madeProgress = true;
          if (history && !c.historyPage) historyFinished = true;
        }
        const fresh: string[] = c.mailQueue.filter(id => !attemptedIds.has(id));
        // One retry plus one fresh item per concurrent batch; retries never monopolize it.
        const batch = [dueRetries.shift(), ...fresh].filter((id): id is string => !!id && !attemptedIds.has(id)).slice(0, Math.min(2, budget - attempted, 8 - attempted));
        if (!batch.length) {
          if (!historyFinished && pages < 16 && !c.mailQueue.length) continue;
          break;
        }
        batch.forEach(id => attemptedIds.add(id));
        attempted += batch.length;
        const results = await Promise.allSettled(batch.map(id => mailThread(email, id, token, gaps, mailStopAt)));
        for (const [index, result] of results.entries()) {
          const id = batch[index];
          c.mailQueue = c.mailQueue.filter(pending => pending !== id);
          if (result.status === 'fulfilled') {
            delete c.mailRetries[id];
            if (result.value) processed++;
            madeProgress = true;
          } else {
            const attempts = (c.mailRetries[id]?.attempts || 0) + 1;
            c.mailRetries[id] = {
              attempts,
              nextRetryAt: new Date(Date.now() + Math.min(3600000, 30000 * 2 ** Math.min(attempts - 1, 7))).toISOString(),
              reason: safeSyncError(result.reason),
            };
          }
        }
        // One cursor writer: failed moves and successful removals checkpoint together.
        c.mailComplete = !!c.mailListingDone && !c.mailQueue.length && !Object.keys(c.mailRetries).length && !c.historyPage;
        if (!c.mailQueue.length && !c.historyPage && c.historyTarget) {
          c.historyId = c.historyTarget;
          delete c.historyTarget;
        }
        await storeCursor(email, c);
      }
      c.mailComplete = !!c.mailListingDone && !c.mailQueue.length && !Object.keys(c.mailRetries).length && !c.historyPage;
      if (!c.mailQueue.length && !c.historyPage && c.historyTarget) {
        c.historyId = c.historyTarget;
        delete c.historyTarget;
      }
      await storeCursor(email, c);
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
      await onPhase?.("calendar");
      await syncCalendar(email, c, token, gaps, stopAt, count => { calendarProcessed += count; madeProgress = true; });
    } catch (error) {
      gaps.push(`${email}: calendar read failed; saved page will retry. ${error instanceof Error && error.message.startsWith('Calendar event') ? error.message : ''}`.trim());
    }
  }
  for (const [id, retry] of Object.entries(c.mailRetries || {}))
    gaps.push(`${email}: thread ${id} failed; durable retry ${retry.attempts} after ${retry.nextRetryAt}. ${retry.reason}`);
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
  return { processed, calendarProcessed, madeProgress, gaps: [...new Set(gaps)] };
}
function safeSyncError(e: unknown) {
  if (e instanceof Error && (['TimeoutError', 'AbortError'].includes(e.name) || e.message.startsWith('Time budget')))
    return 'Time budget reached; saved cursor will retry.';
  const m = e instanceof Error ? e.message : "";
  return /^(Model |Evidence |Full thread |Email body|Thread body)/.test(m)
    ? m
    : "Integration unavailable; check provider configuration.";
}
export async function runSync() {
  const lease = await claimLease("sync", 65);
  if (!lease)
    return {
      ok: false,
      summary: "A sync is already in progress.",
      gaps: ["Retry after the current bounded sync finishes."],
    };
  const gaps: string[] = [];
  let processed = 0;
  let calendarProcessed = 0;
  let madeProgress = false;
  // Leave 20 seconds of the 60-second route for startup, durable writes and cleanup.
  const stopAt = Date.now() + 40000;
  const startedAt = new Date().toISOString();
  let failed = false;
  try {
    const previous = await getState<{ lastSyncAt?: string }>("sync");
    const checkpoint = async (phase: string, account: string | null = null) => {
      await setState("sync", { phase, account, status: "running", startedAt, processed, calendarProcessed, madeProgress, gaps: [...new Set(gaps)], lastSyncAt: previous?.lastSyncAt || null });
    };
    await checkpoint("starting");
    const accounts =
      await db()`select * from accounts order by last_sync_at nulls first,email`;
    if (!accounts.length) gaps.push("No Google accounts connected.");
    for (let index = 0; index < accounts.length && Date.now() < stopAt; index += 2) {
      // At most two cursor writers/accounts, each with two mail workers (global cap four).
      await checkpoint("accounts");
      const turns = accounts.slice(index, index + 2).map(async a => {
        try {
          const r = await syncAccount(a as unknown as Account, 8, stopAt - 4000);
          processed += r.processed;
          calendarProcessed += r.calendarProcessed;
          madeProgress ||= r.madeProgress;
          gaps.push(...r.gaps);
        } catch {
          const gap = `${a.email}: Google authorization unavailable; reconnect if expired.`;
          gaps.push(gap);
          await db()`update accounts set last_sync_at=now(),gap=${gap} where email=${a.email}`;
        }
      });
      const settled = await Promise.allSettled(turns);
      if (settled.some(r => r.status === 'rejected')) throw new Error('Account checkpoint unavailable');
    }
    await checkpoint("news");
    const news = Date.now() < stopAt
      ? await syncNews(Math.min(stopAt, Date.now() + 4000))
      : { count: 0, gaps: ['Research feeds deferred: time budget reached; stored articles remain available.'] };
    gaps.push(...news.gaps);
    return {
      ok: true,
      summary: `Processed ${processed} full email threads; stored ${news.count} research entries. Coverage is limited to completed pages; see gaps.`,
      gaps: [...new Set(gaps)],
    };
  } catch {
    failed = true;
    gaps.push("Sync failed: integration unavailable; saved cursors will retry.");
    return { ok: false, summary: `Sync paused after ${processed} full email threads; saved progress will retry.`, gaps: [...new Set(gaps)] };
  } finally {
    try {
      await setState("sync", {
        phase: "finished",
        status: failed ? "failed" : gaps.length ? "partial" : "completed",
        processed,
        calendarProcessed,
        madeProgress,
        startedAt,
        gaps: [...new Set(gaps)],
        lastSyncAt: new Date().toISOString(),
      });
    } finally {
      await releaseLease("sync", lease);
    }
  }
}
