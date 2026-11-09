import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { db, saveFacts, dashboard } from "../../lib/db";
import type { Fact } from "../../lib/extraction";
import { DateTime } from "luxon";

const enabled = !!process.env.TEST_DATABASE_URL;
if (enabled) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const sources: string[] = [];
const account = "reinstatement@example.com";
const url = "https://mail.google.com/";
const fact: Fact = {
  key: "assignment",
  title: "Assignment",
  kind: "deadline",
  dueAt: null,
  dateOnly: "2026-11-12",
  timezone: null,
  originalDateText: "12 November 2026",
  evidence: "Assignment due 12 November 2026",
  confidence: 0.95,
  cancelled: false,
};

async function source() {
  const id = "reinstatement-" + crypto.randomUUID();
  sources.push(id);
  await db()`insert into sources(id,account,kind,body,url) values(${id},${account},'mail',${fact.evidence},${url})`;
  return id;
}

async function item(id: string) {
  const rows = await db()`select data,manual from items where source_id=${id}`;
  expect(rows).toHaveLength(1);
  return rows[0];
}

beforeAll(async () => {
  if (enabled) await db().unsafe(await readFile("db/001_init.sql", "utf8"));
});
afterEach(async () => {
  vi.useRealTimers();
  if (enabled && sources.length)
    await db()`delete from sources where id=any(${sources.splice(0)})`;
});
afterAll(async () => {
  if (enabled) await db().end();
});

describe.skipIf(!enabled)("real PostgreSQL deadline reconciliation", () => {
  it("reopens an automatically cancelled deadline when verified facts reinstate it", async () => {
    const id = await source();
    await saveFacts(id, account, url, [fact]);
    const originalId = (await item(id)).data.id;
    await saveFacts(id, account, url, [{ ...fact, cancelled: true }]);
    expect((await item(id)).data.status).toBe("dismissed");
    expect((await item(id)).manual).toBe(false);
    await saveFacts(id, account, url, [fact]);
    expect((await item(id)).data).toMatchObject({ id: originalId, status: "open" });
  });

  it("reopens a vanished deadline only when the fact returns", async () => {
    const id = await source();
    await saveFacts(id, account, url, [fact]);
    await saveFacts(id, account, url, []);
    expect((await item(id)).data.status).toBe("dismissed");
    await saveFacts(id, account, url, []);
    expect((await item(id)).data.status).toBe("dismissed");
    await saveFacts(id, account, url, [fact]);
    expect((await item(id)).data.status).toBe("open");
  });

  it("keeps uncertain reinstatements in review instead of reopening reminders", async () => {
    const id = await source();
    await saveFacts(id, account, url, [{ ...fact, cancelled: true }]);
    await saveFacts(id, account, url, [{ ...fact, confidence: 0.5 }]);
    expect((await item(id)).data.status).toBe("needs_review");
  });

  it.each(["done", "dismissed"])("preserves manual %s when active facts return", async (status) => {
    const id = await source();
    await saveFacts(id, account, url, [fact]);
    await db()`update items set manual=true,data=data || ${db().json({ status, dateOnly: "2026-11-13" })} where source_id=${id}`;
    await saveFacts(id, account, url, [fact]);
    expect((await item(id)).data).toMatchObject({ status, dateOnly: "2026-11-13" });
  });

  it("does not silently reopen a manual reviewed date after source-change suppression", async () => {
    const id = await source();
    await saveFacts(id, account, url, [fact]);
    await db()`update items set manual=true,data=data || '{"status":"needs_review","dateOnly":"2026-11-13"}'::jsonb where source_id=${id}`;
    await saveFacts(id, account, url, [fact]);
    expect((await item(id)).data).toMatchObject({ status: "needs_review", dateOnly: "2026-11-13" });
  });

  it("uses the Bangkok week boundary rather than the timestamp's original date", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-09T06:00:00+07:00"));
    const id = await source();
    const facts = [
      { ...fact, key: "before", dateOnly: null, dueAt: "2026-11-15T16:59:59Z" },
      { ...fact, key: "boundary", dateOnly: null, dueAt: "2026-11-15T17:00:00Z" },
      { ...fact, key: "after", dateOnly: null, dueAt: "2026-11-15T23:30:00Z" },
    ];
    await saveFacts(id, account, url, facts);
    const rows = await db()`select id,fact_key from items where source_id=${id}`;
    const visible = new Set((await dashboard(1)).items.map((i) => i.id));
    expect(rows.filter((r) => visible.has(r.id)).map((r) => r.fact_key).sort()).toEqual(["before"]);
  });

  it.each([1, 2, 8])("preserves overdue, undated review and date-only behavior for %i weeks", async (weeks) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-09T06:00:00+07:00"));
    const end = DateTime.fromISO("2026-11-09", { zone: "Asia/Bangkok" }).plus({ weeks });
    const id = await source();
    await saveFacts(id, account, url, [
      { ...fact, key: "overdue", dateOnly: "2026-10-01" },
      { ...fact, key: "review", dateOnly: null, confidence: 0.4 },
      { ...fact, key: "last-date", dateOnly: end.minus({ days: 1 }).toISODate() },
      { ...fact, key: "next-date", dateOnly: end.toISODate() },
      { ...fact, key: "last-instant", dateOnly: null, dueAt: end.minus({ seconds: 1 }).toUTC().toISO() },
      { ...fact, key: "next-instant", dateOnly: null, dueAt: end.toUTC().toISO() },
      // Monday in +14:00 can still be Sunday in Bangkok.
      { ...fact, key: "positive-offset", dateOnly: null, dueAt: end.minus({ hours: 1 }).setZone("Pacific/Kiritimati").toISO() },
      { ...fact, key: "cancelled", cancelled: true },
      { ...fact, key: "done" },
    ]);
    await db()`update items set manual=true,data=jsonb_set(data,'{status}','"done"') where source_id=${id} and fact_key='done'`;
    const rows = await db()`select id,fact_key from items where source_id=${id}`;
    const visible = new Set((await dashboard(weeks)).items.map((i) => i.id));
    expect(rows.filter((r) => visible.has(r.id)).map((r) => r.fact_key).sort()).toEqual([
      "last-date", "last-instant", "overdue", "positive-offset", "review",
    ]);
  });
});
