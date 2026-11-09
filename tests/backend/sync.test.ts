import { it, expect, vi, afterAll } from "vitest";
import { readFile } from "node:fs/promises";
import { syncAccount } from "../../lib/sync";
import { db, saveFacts } from "../../lib/db";
import { encrypt } from "../../lib/security";
const enabled = !!process.env.TEST_DATABASE_URL;
if (enabled) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
afterAll(async () => {
  vi.unstubAllGlobals();
  if (enabled) await db().end();
});
it.skipIf(!enabled)(
  "persists a partial Gmail page and resumes without skipping or mutating mail",
  async () => {
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString("base64");
    process.env.OWNER_EMAILS = "sync@example.com";
    process.env.OPENAI_API_KEY = "key";
    process.env.OPENAI_MODEL = "test";
    await db().unsafe(await readFile("db/001_init.sql", "utf8"));
    await db()`insert into accounts(email,refresh_token) values('sync@example.com',${encrypt("test-token")}) on conflict(email) do update set cursor='{}',refresh_token=excluded.refresh_token`;
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const u = String(input);
        seen.push(u);
        if (u.includes("oauth2.googleapis.com/token"))
          return Response.json({ access_token: "access" });
        if (u.includes("/profile")) return Response.json({ historyId: "100" });
        if (u.includes("/threads?"))
          return Response.json({ threads: [{ id: "t1" }, { id: "t2" }] });
        if (u.includes("/threads/"))
          return Response.json({
            id: u.endsWith("t1") ? "t1" : "t2",
            messages: [
              {
                internalDate: "1794182400000",
                payload: {
                  mimeType: "text/plain",
                  body: {
                    data: Buffer.from("No deadlines").toString("base64url"),
                  },
                },
              },
            ],
          });
        if (u.includes("/calendarList")) return Response.json({ items: [] });
        if (u.includes("/chat/completions"))
          return Response.json({
            choices: [{ message: { content: '{"facts":[]}' } }],
          });
        throw new Error("unexpected " + u);
      },
    );
    const row = (
      await db()`select * from accounts where email='sync@example.com'`
    )[0];
    await syncAccount(
      row as { email: string; refresh_token: string },
      1,
      Date.now() + 25000,
    );
    let c = (
      await db()`select cursor from accounts where email='sync@example.com'`
    )[0].cursor;
    expect(c.mailQueue).toEqual(["t2"]);
    expect(c.mailComplete).not.toBe(true);
    expect(c.mailListingDone).toBe(true);
    await syncAccount(
      (
        await db()`select * from accounts where email='sync@example.com'`
      )[0] as { email: string; refresh_token: string },
      1,
      Date.now() + 25000,
    );
    c = (
      await db()`select cursor from accounts where email='sync@example.com'`
    )[0].cursor;
    expect(c.mailComplete).toBe(true);
    expect(seen.filter((u) => u.includes("/threads?"))).toHaveLength(1);
    expect(seen.filter((u) => u.includes("/threads/"))).toHaveLength(2);
    await db()`delete from accounts where email='sync@example.com'`;
    await db()`delete from sources where account='sync@example.com'`;
  },
);

it.skipIf(!enabled)(
  "suspends stale reminders when changed source fails extraction",
  async () => {
    process.env.OWNER_EMAILS = "stale@example.com";
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString("base64");
    process.env.OPENAI_API_KEY = "key";
    process.env.OPENAI_MODEL = "test";
    const sid = "stale@example.com:mail:t1";
    await db()`insert into sources(id,account,kind,body,url,revision) values(${sid},'stale@example.com','mail','Exam 10 December 2026','https://mail.google.com/','old') on conflict(id) do update set body=excluded.body,revision=excluded.revision,extracted=false`;
    await saveFacts(sid, "stale@example.com", "https://mail.google.com/", [
      {
        key: "exam",
        title: "Exam",
        kind: "exam",
        dueAt: null,
        dateOnly: "2026-12-10",
        timezone: null,
        originalDateText: "10 December 2026",
        evidence: "Exam",
        confidence: 1,
        cancelled: false,
      },
    ]);
    await db()`insert into accounts(email,refresh_token,cursor) values('stale@example.com',${encrypt("test")},${db().json({ mailQueue: ["t1"], mailComplete: true, historyId: "1" })}) on conflict(email) do update set cursor=excluded.cursor`;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const u = String(input);
      if (u.includes("oauth2.googleapis.com/token"))
        return Response.json({ access_token: "a" });
      if (u.includes("/threads/t1"))
        return Response.json({
          messages: [
            {
              id: "m",
              payload: {
                mimeType: "text/plain",
                body: {
                  data: Buffer.from("Exam cancelled").toString("base64url"),
                },
              },
            },
          ],
        });
      if (u.includes("chat/completions"))
        return Response.json({
          choices: [{ message: { content: "not JSON" } }],
        });
      if (u.includes("calendarList")) return Response.json({ items: [] });
      throw new Error("unexpected");
    });
    await syncAccount(
      (
        await db()`select * from accounts where email='stale@example.com'`
      )[0] as { email: string; refresh_token: string },
      1,
      Date.now() + 10000,
    );
    expect(
      (await db()`select data from items where source_id=${sid}`)[0].data
        .status,
    ).toBe("needs_review");
    await db()`delete from accounts where email='stale@example.com'`;
    await db()`delete from sources where id=${sid}`;
  },
);
