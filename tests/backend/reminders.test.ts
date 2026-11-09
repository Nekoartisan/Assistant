import { it, expect } from "vitest";
import { selectReminders, sanitizeMessage } from "../../lib/reminders";
import type { Deadline } from "../../lib/types";
const base: Deadline = {
  id: "x",
  title: "exam",
  kind: "exam",
  dueAt: null,
  dateOnly: null,
  timezone: null,
  originalDateText: "",
  evidence: "exam",
  sourceUrl: "https://example.com",
  sourceAccount: "one@example.com",
  status: "open",
  confidence: 1,
  updatedAt: "2026-11-09T00:00:00Z",
};
it("date-only reminders fire on Bangkok calendar date without midnight arithmetic", () => {
  const now = "2026-11-08T23:00:00Z";
  const r = selectReminders(
    [
      { ...base, dateOnly: "2026-11-09" },
      { ...base, id: "future", dateOnly: "2026-11-10" },
      {
        ...base,
        id: "exclusive-end",
        dateOnly: "2026-11-09",
        notes: "Calendar all-day end date is exclusive.",
      },
    ],
    now,
  );
  expect(r).toHaveLength(1);
  expect(r[0].key).toContain("date:2026-11-09");
  expect(r[0].text).toContain("date only");
});
it("exact-time reminders use stable 24h/3h/1h keys and exclude review/cancelled items", () => {
  const now = "2026-11-09T00:00:00Z";
  const r = selectReminders(
    [
      { ...base, dueAt: "2026-11-09T00:30:00Z" },
      {
        ...base,
        id: "r",
        status: "needs_review",
        dueAt: "2026-11-09T00:30:00Z",
      },
      { ...base, id: "c", status: "dismissed", dueAt: "2026-11-09T00:30:00Z" },
    ],
    now,
  );
  expect(r).toHaveLength(1);
  expect(r[0].key).toContain(":1h");
  expect(sanitizeMessage("a\u0000b")).toBe("ab");
});
