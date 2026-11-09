import { it, expect, afterAll } from "vitest";
import { PATCH } from "../../app/api/items/[id]/route";
import { db, saveFacts } from "../../lib/db";
import { sign } from "../../lib/security";
const enabled = !!process.env.TEST_DATABASE_URL;
if (enabled) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
afterAll(async () => {
  if (enabled) await db().end();
});
it.skipIf(!enabled)(
  "explicit human date confirmation promotes review confidence and persists override",
  async () => {
    process.env.APP_URL = "https://bao.example";
    process.env.SESSION_SECRET = "s".repeat(40);
    const sid = "review-" + crypto.randomUUID();
    await db()`insert into sources(id,account,kind,body,url) values(${sid},'one@example.com','mail','Exam date unclear','https://mail.google.com/')`;
    await saveFacts(sid, "one@example.com", "https://mail.google.com/", [
      {
        key: "exam",
        title: "Exam",
        kind: "exam",
        dateOnly: null,
        dueAt: null,
        timezone: null,
        evidence: "Exam date unclear",
        originalDateText: "date unclear",
        confidence: 0.4,
        cancelled: false,
      },
    ]);
    const id = (await db()`select id from items where source_id=${sid}`)[0].id;
    const r = await PATCH(
      new Request("https://bao.example/api/items/" + id, {
        method: "PATCH",
        headers: {
          origin: "https://bao.example",
          cookie: "bao_session=" + sign({ owner: true }),
        },
        body: JSON.stringify({ dateOnly: "2026-12-10", status: "open" }),
      }),
      { params: Promise.resolve({ id }) },
    );
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.confidence).toBe(1);
    expect(j.status).toBe("open");
    expect(j.dateOnly).toBe("2026-12-10");
    expect(
      (await db()`select manual from items where id=${id}`)[0].manual,
    ).toBe(true);
    await db()`delete from sources where id=${sid}`;
  },
);
