import { it, expect } from "vitest";
import {
  oauthStart,
  allowedEmail,
  gmailUrl,
  calendarFacts,
} from "../../lib/google";
it("uses only readonly scopes, signed PKCE state and explicit allowlist", () => {
  process.env.APP_URL = "https://bao.example";
  process.env.GOOGLE_CLIENT_ID = "client";
  process.env.SESSION_SECRET = "x".repeat(40);
  process.env.OWNER_EMAILS = "one@example.com,two@example.com";
  const { url, state } = oauthStart();
  const u = new URL(url);
  expect(u.searchParams.get("scope")).toBe(
    "openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.readonly",
  );
  expect(u.searchParams.get("code_challenge_method")).toBe("S256");
  expect(state).toBeTruthy();
  expect(allowedEmail("evil@example.com")).toBe(false);
  expect(allowedEmail("ONE@example.com")).toBe(true);
  expect(gmailUrl("one+school@example.com", "abc123")).toContain(
    "authuser=one%2Bschool%40example.com",
  );
});
it("preserves calendar all-day dates and cancellation with both event boundaries", () => {
  const f = calendarFacts({
    id: "e",
    summary: "Exam",
    status: "confirmed",
    start: { date: "2026-12-10" },
    end: { date: "2026-12-12" },
  });
  expect(f[0].dateOnly).toBe("2026-12-10");
  expect(f[0].dueAt).toBeNull();
  expect(f[1].dateOnly).toBe("2026-12-12");
  expect(f[1].notes).toContain("exclusive");
  expect(calendarFacts({ id: "e", status: "cancelled" })[0].cancelled).toBe(
    true,
  );
});
