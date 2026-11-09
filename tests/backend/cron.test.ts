import { it, expect, vi } from "vitest";
vi.mock("../../lib/reminders", () => ({
  runReminders: vi.fn(async (task: string) => ({ ok: true, task })),
}));
import { GET } from "../../app/api/cron/route";
import { runReminders } from "../../lib/reminders";
it("authorized poll invokes durable reminder workflow, not sync alone", async () => {
  process.env.CRON_SECRET = "c".repeat(40);
  const r = await GET(
    new Request("https://bao.example/api/cron?task=poll", {
      headers: { authorization: "Bearer " + "c".repeat(40) },
    }),
  );
  expect(r.status).toBe(200);
  expect(runReminders).toHaveBeenCalledWith("poll");
});
