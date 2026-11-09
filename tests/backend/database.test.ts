import { it, expect, afterAll } from "vitest";
import { readFile } from "node:fs/promises";
import {
  db,
  claimLease,
  releaseLease,
  rateLimit,
  saveFacts,
  dashboard,
  claimDelivery,
  finishDelivery,
} from "../../lib/db";
const enabled = !!process.env.TEST_DATABASE_URL;
if (enabled) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
afterAll(async () => {
  if (enabled) await db().end();
});
it.skipIf(!enabled)(
  "real Postgres enforces leases, evidence persistence, updates and reminder dedupe",
  async () => {
    const sql = db();
    await sql.unsafe(await readFile("db/001_init.sql", "utf8"));
    const source = "test-" + crypto.randomUUID();
    const a = await claimLease(source, 60);
    expect(a).toBeTruthy();
    expect(await claimLease(source, 60)).toBeNull();
    await releaseLease(source, a!);
    expect(await claimLease(source, 60)).toBeTruthy();
    expect(await rateLimit(source, 1)).toBe(true);
    expect(await rateLimit(source, 1)).toBe(false);
    await sql`insert into sources(id,account,kind,body,url) values(${source},'owner@example.com','mail','Deadline 10 December','https://mail.google.com/')`;
    const f = {
      key: "assignment",
      title: "Homework",
      kind: "deadline" as const,
      dueAt: null,
      dateOnly: "2026-12-10",
      timezone: null,
      originalDateText: "10 December",
      evidence: "10 December",
      confidence: 0.9,
      cancelled: false,
    };
    await saveFacts(source, "owner@example.com", "https://mail.google.com/", [
      f,
    ]);
    await saveFacts(source, "owner@example.com", "https://mail.google.com/", [
      { ...f, dateOnly: "2026-12-11" },
    ]);
    const rows = await sql`select data from items where source_id=${source}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].data.dateOnly).toBe("2026-12-11");
    await saveFacts(source, "owner@example.com", "https://mail.google.com/", [
      { ...f, cancelled: true },
    ]);
    expect(
      (await sql`select data from items where source_id=${source}`)[0].data
        .status,
    ).toBe("dismissed");
    expect(await claimDelivery(source, "telegram", "body")).toBe(true);
    expect(await claimDelivery(source, "telegram", "body")).toBe(false);
    await finishDelivery(source, "telegram", "sent");
    expect((await dashboard(8)).items).toBeInstanceOf(Array);
    await sql`delete from sources where id=${source}`;
    await sql`delete from leases where name=${source}`;
    await sql`delete from deliveries where dedupe_key=${source}`;
  },
);
