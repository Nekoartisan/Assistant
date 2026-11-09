import { it, expect, vi, afterEach } from "vitest";
import { extractThread, complete } from "../../lib/llm";
afterEach(() => vi.unstubAllGlobals());
it("uses configured chat-completions API and validates evidence", async () => {
  process.env.OPENAI_API_KEY = "test";
  process.env.OPENAI_BASE_URL = "https://api.example/v1";
  process.env.OPENAI_MODEL = "test-model";
  const fetcher = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  facts: [
                    {
                      key: "x",
                      title: "Exam",
                      kind: "exam",
                      dueAt: null,
                      dateOnly: "2026-12-10",
                      timezone: null,
                      originalDateText: "10 December 2026",
                      evidence: "Exam 10 December 2026",
                      confidence: 0.9,
                      cancelled: false,
                    },
                  ],
                }),
              },
            },
          ],
        }),
      ),
  );
  vi.stubGlobal("fetch", fetcher);
  const facts = await extractThread(
    "Exam 10 December 2026",
    "2026-11-09T00:00:00Z",
    [],
  );
  expect(facts[0].dateOnly).toBe("2026-12-10");
  expect(fetcher.mock.calls[0][0]).toBe(
    "https://api.example/v1/chat/completions",
  );
  expect(String(fetcher.mock.calls[0][1]?.body)).toContain("test-model");
});
it("does not silently truncate unprocessed full mail", async () => {
  await expect(
    extractThread("x".repeat(120001), "2026-11-09T00:00:00Z", []),
  ).rejects.toThrow(/large/i);
});
it("rejects provider errors without leaking response body", async () => {
  vi.stubGlobal(
    "fetch",
    async () => new Response("secret-provider-debug", { status: 401 }),
  );
  await expect(complete("system", "data")).rejects.toThrow(
    "Model request failed (401)",
  );
});
