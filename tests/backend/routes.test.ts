import { it, expect, afterAll } from "vitest";
import { GET as status } from "../../app/api/status/route";
import { POST as login } from "../../app/api/auth/login/route";
import { GET as dashboard } from "../../app/api/dashboard/route";
import { POST as chat } from "../../app/api/chat/route";
import { PATCH as patch } from "../../app/api/items/[id]/route";
import { GET as cron } from "../../app/api/cron/route";
import { db } from "../../lib/db";
const enabled = !!process.env.TEST_DATABASE_URL;
if (enabled) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
afterAll(async () => {
  if (enabled) await db().end();
});
it("reveals no account, gap, missing-secret names or sync metadata to public status", async () => {
  const r = await status(new Request("http://localhost/api/status"));
  const j = await r.json();
  expect(j.authenticated).toBe(false);
  expect(j.accounts).toEqual([]);
  expect(j.lastSyncAt).toBeNull();
  expect(j.gaps).toEqual([]);
  expect(JSON.stringify(j)).not.toContain("DATABASE_URL");
});
it("rejects all private routes before accessing database", async () => {
  expect(
    (await dashboard(new Request("http://localhost/api/dashboard"))).status,
  ).toBe(401);
  expect(
    (await chat(new Request("http://localhost/api/chat", { method: "POST" })))
      .status,
  ).toBe(401);
  expect(
    (
      await patch(
        new Request("http://localhost/api/items/a", { method: "PATCH" }),
        { params: Promise.resolve({ id: "a" }) },
      )
    ).status,
  ).toBe(401);
  expect(
    (await cron(new Request("http://localhost/api/cron?task=morning"))).status,
  ).toBe(401);
});
it("rejects cross-site password login even with correct password", async () => {
  process.env.APP_URL = "https://bao.example";
  process.env.OWNER_PASSWORD = "p".repeat(16);
  const r = await login(
    new Request("https://bao.example/api/auth/login", {
      method: "POST",
      headers: { origin: "https://evil.example" },
      body: JSON.stringify({ password: "p".repeat(16) }),
    }),
  );
  expect(r.status).toBe(403);
});
it.skipIf(!enabled)(
  "real DB login issues private expiring cookie and authenticated dashboard is durable",
  async () => {
    process.env.APP_URL = "https://bao.example";
    process.env.OWNER_PASSWORD = "p".repeat(16);
    process.env.SESSION_SECRET = "s".repeat(40);
    const r = await login(
      new Request("https://bao.example/api/auth/login", {
        method: "POST",
        headers: { origin: "https://bao.example" },
        body: JSON.stringify({ password: "p".repeat(16) }),
      }),
    );
    expect(r.status).toBe(200);
    const c = r.headers.get("set-cookie")!;
    expect(c).toContain("HttpOnly");
    expect(c).toContain("SameSite=Strict");
    expect(c).toContain("Secure");
    const response = await dashboard(
      new Request("https://bao.example/api/dashboard?weeks=2", {
        headers: { cookie: c.split(";")[0] },
      }),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).items).toBeInstanceOf(Array);
  },
);
