import { it, expect, vi, afterAll } from "vitest";
vi.mock("../../lib/sync", () => ({
  runSync: async () => ({ ok: true, summary: "test transport", gaps: [] }),
}));
vi.mock("../../lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/db")>();
  return { ...actual, dashboard: vi.fn() };
});
import { runReminders, selectReminders } from "../../lib/reminders";
import { db, dashboard, claimDelivery } from "../../lib/db";
import type { Deadline } from "../../lib/types";
const enabled = !!process.env.TEST_DATABASE_URL;
if (enabled) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
afterAll(async () => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  if (enabled) await db().end();
});
it.skipIf(!enabled)(
  "already-reserved candidates do not starve later due reminders",
  async () => {
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    const prefix = "delivery-" + crypto.randomUUID();
    const items: Deadline[] = Array.from({ length: 9 }, (_, i) => ({
      id: prefix + i,
      title: "Reminder " + i,
      kind: "exam",
      dueAt: "2030-01-01T00:30:00Z",
      dateOnly: null,
      timezone: "UTC",
      originalDateText: "2030-01-01T00:30:00Z",
      evidence: "Exam",
      sourceUrl: "https://mail.google.com/",
      sourceAccount: "one@example.com",
      status: "open",
      confidence: 1,
      updatedAt: "2030-01-01T00:00:00Z",
    }));
    vi.mocked(dashboard).mockResolvedValue({
      items,
      news: [],
      gaps: [],
      lastSyncAt: null,
    });
    for (const r of selectReminders(items.slice(0, 8), "2030-01-01T00:00:00Z"))
      await claimDelivery(r.key, "telegram", r.text);
    process.env.TELEGRAM_BOT_TOKEN = "test-only";
    process.env.TELEGRAM_CHAT_ID = "1";
    delete process.env.RESEND_API_KEY;
    const sent: string[] = [];
    vi.stubGlobal(
      "fetch",
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        sent.push(body.text);
        return Response.json({
          ok: true,
          result: { message_id: 1, text: body.text },
        });
      },
    );
    await runReminders("poll");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Reminder 8");
    await db()`delete from deliveries where dedupe_key like ${prefix + "%"}`;
  },
);
