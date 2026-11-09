import { it, expect } from "vitest";
import { parseFeed } from "../../lib/news";
it.skipIf(process.env.LIVE_PUBLIC_FEEDS !== "1")(
  "parses real unauthenticated arXiv and official news feeds",
  async () => {
    const feeds = [
      [
        "arXiv",
        "paper",
        "https://export.arxiv.org/api/query?search_query=cat:cs.AI+OR+cat:cs.CL+OR+cat:cs.LG&sortBy=submittedDate&sortOrder=descending&max_results=100",
      ],
      ["OpenAI", "news", "https://openai.com/news/rss.xml"],
      ["Google DeepMind", "news", "https://deepmind.google/blog/rss.xml"],
    ] as const;
    await Promise.all(
      feeds.map(async ([source, kind, url]) => {
        const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
        expect(r.status).toBe(200);
        const parsed = parseFeed(
          await r.text(),
          source,
          kind,
          new Date().toISOString(),
        );
        expect(parsed.length).toBeGreaterThan(0);
        expect(parsed.length).toBeLessThanOrEqual(100);
        console.log(source + ": " + parsed.length + " actual parsed entries");
      }),
    );
  },
  20000,
);
