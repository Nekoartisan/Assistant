import postgres from "postgres";
import { randomUUID, createHash } from "node:crypto";
import { DateTime } from "luxon";
import type { Fact } from "./extraction";
import type { Deadline, News } from "./types";
import { normalizeCoverageGaps } from "./coverage";
let connection: ReturnType<typeof postgres> | undefined;
export function db() {
  if (!connection) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL missing");
    const host = new URL(url).hostname;
    connection = postgres(url, {
      ssl: ["localhost", "127.0.0.1", "[::1]"].includes(host)
        ? false
        : "require",
      max: 3,
      idle_timeout: 20,
      connect_timeout: 10,
      prepare: false,
    });
  }
  return connection;
}
export async function claimLease(name: string, seconds = 240) {
  const token = randomUUID();
  const rows =
    await db()`insert into leases(name,token,expires_at) values(${name},${token},now()+${seconds}*interval '1 second') on conflict(name) do update set token=excluded.token,expires_at=excluded.expires_at where leases.expires_at<now() returning token`;
  return rows.length ? token : null;
}
export async function releaseLease(name: string, token: string) {
  await db()`delete from leases where name=${name} and token=${token}`;
}
export async function rateLimit(key: string, limit: number, seconds = 60) {
  const rows =
    await db()`insert into rate_limits(key,window_start,count) values(${key},now(),1) on conflict(key) do update set count=case when rate_limits.window_start < now()-${seconds}*interval '1 second' then 1 else rate_limits.count+1 end,window_start=case when rate_limits.window_start < now()-${seconds}*interval '1 second' then now() else rate_limits.window_start end returning count`;
  return rows[0].count <= limit;
}
export async function setState(key: string, value: unknown) {
  await db()`insert into state(key,value) values(${key},${db().json(value as never)}) on conflict(key) do update set value=excluded.value,updated_at=now()`;
}
export async function getState<T>(key: string): Promise<T | null> {
  const r = await db()`select value from state where key=${key}`;
  return r[0]?.value ?? null;
}
export async function saveFacts(
  sourceId: string,
  account: string,
  url: string,
  facts: Fact[],
) {
  await db().begin(async (tx) => {
    const keys = facts.map((f) => f.key);
    await tx`update items set data=jsonb_set(data,'{status}','"dismissed"') where source_id=${sourceId} and not(fact_key=any(${keys}))`;
    for (const f of facts) {
      const id = createHash("sha256")
        .update(sourceId + "\0" + f.key)
        .digest("hex")
        .slice(0, 32);
      const data: Deadline = {
        id,
        title: f.title,
        kind: f.kind,
        dueAt: f.dueAt,
        dateOnly: f.dateOnly,
        timezone: f.timezone,
        originalDateText: f.originalDateText,
        evidence: f.evidence,
        sourceUrl: url,
        sourceAccount: account,
        status: f.cancelled
          ? "dismissed"
          : (!f.dueAt && !f.dateOnly) || f.confidence < 0.8
            ? "needs_review"
            : "open",
        confidence: f.confidence,
        updatedAt: new Date().toISOString(),
        notes: f.notes,
        location: f.location,
      };
      await tx`insert into items(id,source_id,fact_key,data) values(${id},${sourceId},${f.key},${tx.json(data as never)}) on conflict(source_id,fact_key) do update set data=case when items.manual then items.data || jsonb_build_object('evidence',excluded.data->'evidence','originalDateText',excluded.data->'originalDateText','updatedAt',excluded.data->'updatedAt') || case when excluded.data->>'status'='dismissed' then '{"status":"dismissed"}'::jsonb else '{}'::jsonb end else excluded.data || case when items.data->>'status'='done' and excluded.data->>'status'<>'dismissed' then jsonb_build_object('status',items.data->'status') else '{}'::jsonb end end`;
    }
    await tx`update sources set extracted=true where id=${sourceId}`;
  });
}
export async function dashboard(weeks: number) {
  const now = DateTime.now().setZone("Asia/Bangkok");
  const start = now.startOf("week");
  const end = start.plus({ weeks });
  const from = start.minus({ weeks: weeks - 1 });
  const items =
    await db()`select data from items where data->>'status' not in ('dismissed','done') and ((data->>'dueAt' is null and data->>'dateOnly' is null) or coalesce((data->>'dateOnly')::date,((data->>'dueAt')::timestamptz at time zone 'Asia/Bangkok')::date) < ${end.toISODate()}::date) order by coalesce(data->>'dueAt',data->>'dateOnly','9999') limit 500`;
  const news =
    await db()`select data from news where published_at>=${from.toISO()} and published_at<${now.toISO()} order by published_at desc limit 200`;
  const state = await getState<{ gaps: string[]; lastSyncAt: string }>("sync");
  const accounts = await db()`select email,cursor,gap from accounts`;
  const gaps = [...(state?.gaps || [])];
  if (!accounts.length) gaps.push("No Google accounts connected.");
  for (const a of accounts) {
    if (!a.cursor?.mailComplete)
      gaps.push(
        `${a.email}: 90-day email backfill is incomplete; Sync continues the saved cursor.`,
      );
    if (a.gap) gaps.push(a.gap);
  }
  if (items.length === 500)
    gaps.push("Agenda limited to 500 records; narrow or review items.");
  return {
    items: items.map((r) => r.data as Deadline),
    news: news.map((r) => r.data as News),
    gaps: normalizeCoverageGaps(gaps),
    lastSyncAt: state?.lastSyncAt || null,
  };
}
export async function claimDelivery(
  key: string,
  channel: string,
  body: string,
) {
  const r =
    await db()`insert into deliveries(dedupe_key,channel,body) values(${key},${channel},${body}) on conflict do nothing returning dedupe_key`;
  return !!r.length;
}
export async function finishDelivery(
  key: string,
  channel: string,
  status: string,
) {
  await db()`update deliveries set status=${status},updated_at=now() where dedupe_key=${key} and channel=${channel}`;
}
