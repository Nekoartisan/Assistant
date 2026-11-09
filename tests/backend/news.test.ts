import { it, expect } from "vitest";
import { parseFeed } from "../../lib/news";
it("bounds oversized official feeds to one hundred entries per request", () => {
  const entries = Array.from(
    { length: 150 },
    (_, i) =>
      `<item><title>Article ${i}</title><link>https://openai.com/news/${i}</link><pubDate>Mon, 09 Nov 2026 00:00:00 GMT</pubDate></item>`,
  ).join("");
  expect(
    parseFeed(
      "<rss><channel>" + entries + "</channel></rss>",
      "OpenAI",
      "news",
      "2026-11-09T00:00:00Z",
    ),
  ).toHaveLength(100);
});
it("parses official RSS and Atom with publication timestamps separately", () => {
  const fetched = "2026-11-09T00:00:00Z";
  const n = parseFeed(
    "<feed><entry><id>https://arxiv.org/abs/2611.00001</id><title>  Paper\n title </title><summary>Abstract</summary><published>2026-11-08T12:00:00Z</published><updated>2026-11-09T12:00:00Z</updated></entry></feed>",
    "arXiv",
    "paper",
    fetched,
  );
  expect(n[0].publishedAt).toBe("2026-11-08T12:00:00.000Z");
  expect(n[0].fetchedAt).toBe(fetched);
  expect(n[0].title).toBe("Paper title");
});
it("never invents publication date or accepts unsafe source URLs", () => {
  expect(
    parseFeed(
      "<rss><channel><item><title>bad</title><link>javascript:alert(1)</link><pubDate>Mon, 09 Nov 2026 00:00:00 GMT</pubDate></item><item><title>missing date</title><link>https://openai.com/news/a</link></item></channel></rss>",
      "OpenAI",
      "news",
      "2026-11-09T00:00:00Z",
    ),
  ).toEqual([]);
});
