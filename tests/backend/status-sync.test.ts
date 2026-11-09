import { afterAll, beforeAll, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { GET } from "../../app/api/status/route";
import { claimLease, db, releaseLease } from "../../lib/db";
import { sign } from "../../lib/security";

const enabled = !!process.env.TEST_DATABASE_URL;
if (enabled) {
  const url = new URL(process.env.TEST_DATABASE_URL!);
  if (!["localhost", "127.0.0.1"].includes(url.hostname) || !url.pathname.endsWith("_test")) throw new Error("Disposable local test database required");
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}
beforeAll(async () => {
  process.env.SESSION_SECRET = "s".repeat(40);
  if (enabled) {
    await db().unsafe(await readFile("db/001_init.sql", "utf8"));
    await db()`delete from leases where name='sync'`;
  }
});
afterAll(async () => {
  if (enabled) {
    await db()`delete from leases where name='sync'`;
    await db().end();
  }
});
function status(owner = true) {
  return GET(
    new Request("http://localhost/api/status", {
      headers: owner ? { cookie: `bao_session=${sign({ owner: true })}` } : {},
    }),
  ).then((r) => r.json());
}
it.skipIf(!enabled)(
  "reports only a live sync lease as in progress without exposing the token",
  async () => {
    expect(await status()).toMatchObject({
      syncInProgress: false,
      syncLeaseExpiresAt: null,
    });
    const token = (await claimLease("sync", 180))!;
    const active = await status();
    expect(active.syncInProgress).toBe(true);
    expect(Date.parse(active.syncLeaseExpiresAt)).toBeGreaterThan(Date.now());
    expect(JSON.stringify(active)).not.toContain(token);
    const publicStatus = await status(false);
    expect(publicStatus).not.toHaveProperty("syncInProgress");
    expect(publicStatus).not.toHaveProperty("syncLeaseExpiresAt");
    expect(publicStatus.accounts).toEqual([]);
    expect(publicStatus).not.toHaveProperty("progress");
    expect(active.progress).toMatchObject({scopeDays:90,accounts:expect.any(Array)});
    await db()`update leases set expires_at=now()-interval '1 second' where name='sync'`;
    const expired = await status();
    expect(expired.syncInProgress).toBe(false);
    expect(Date.parse(expired.syncLeaseExpiresAt)).toBeLessThan(Date.now());
    await releaseLease("sync", token);
    expect(await status()).toMatchObject({
      syncInProgress: false,
      syncLeaseExpiresAt: null,
    });
  },
);
