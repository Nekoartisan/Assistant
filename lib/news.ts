import { XMLParser } from "fast-xml-parser";
import { createHash } from "node:crypto";
import { plainText } from "./extraction";
import { db, getState, setState } from "./db";
import type { News } from "./types";
export function safeUrl(value: unknown) {
  try {
    const u = new URL(String(value));
    return u.protocol === "https:" || u.protocol === "http:"
      ? u.toString()
      : null;
  } catch {
    return null;
  }
}
export function parseFeed(
  xml: string,
  source: string,
  kind: "paper" | "news",
  fetchedAt: string,
): News[] {
  if (xml.length > 3000000 || /<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new Error("Unsafe feed");
  const p = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    processEntities: false,
  }).parse(xml);
  let entries = p.feed?.entry || p.rss?.channel?.item || [];
  if (!Array.isArray(entries)) entries = [entries];
  return entries.slice(0, 100).flatMap((e: Record<string, unknown>) => {
    const links = Array.isArray(e.link) ? e.link : [e.link];
    const link = links.find(
      (v: unknown) =>
        typeof v === "string" ||
        (v &&
          typeof v === "object" &&
          (!(v as Record<string, string>)["@_rel"] ||
            (v as Record<string, string>)["@_rel"] === "alternate")),
    );
    const url = safeUrl(
      typeof link === "object" ? link?.["@_href"] : link || e.id,
    );
    const pub =
      typeof e.published === "string"
        ? e.published
        : typeof e.pubDate === "string"
          ? e.pubDate
          : null;
    const d = pub ? new Date(pub) : null;
    if (
      !url ||
      !d ||
      !Number.isFinite(d.getTime()) ||
      typeof e.title !== "string"
    )
      return [];
    return [
      {
        id: createHash("sha256").update(url).digest("hex").slice(0, 32),
        title: plainText(e.title).replace(/\s+/g, " ").slice(0, 500),
        summary: plainText(String(e.summary || e.description || "")).slice(
          0,
          2000,
        ),
        url,
        publishedAt: d.toISOString(),
        fetchedAt,
        source,
        kind,
      },
    ];
  });
}
const arxivQuery = new URLSearchParams({
  search_query: 'cat:cs.AI OR cat:cs.CL OR cat:cs.LG OR cat:cs.CV OR cat:stat.ML',
  sortBy: 'submittedDate', sortOrder: 'descending', max_results: '100',
});
async function fetchFeed(url: string, source: string, kind: 'paper' | 'news', stopAt: number) {
  const remaining = Math.floor(stopAt - Date.now());
  if (remaining <= 0) throw new Error('Feed time budget reached');
  const response = await fetch(url, {
    signal: AbortSignal.timeout(Math.min(2000, remaining)),
    headers: { 'User-Agent': 'BaoAssistant/1.0 (private research desk)' },
  });
  if (!response.ok) throw new Error('Feed unavailable');
  const entries = parseFeed(await response.text(), source, kind, new Date().toISOString());
  if (!entries.length) throw new Error('No valid feed entries');
  return entries;
}
export async function fetchResearchFeed(stopAt = Date.now() + 4000): Promise<{news: News[]; gaps: string[]}> {
  try {
    const news = await fetchFeed('https://export.arxiv.org/api/query?' + arxivQuery, 'arXiv', 'paper', stopAt);
    return { news, gaps: [] };
  } catch {
    try {
      const news = await fetchFeed('https://rss.arxiv.org/rss/cs.AI+cs.LG+cs.CL+cs.CV+stat.ML', 'arXiv announcements (RSS)', 'paper', stopAt);
      return { news, gaps: ['arXiv API unavailable: using RSS announcement dates, not original submission dates. Feed coverage is bounded.'] };
    } catch {
      throw new Error('arXiv API and announcement feed unavailable or invalid');
    }
  }
}
const feeds = [
  { source: 'arXiv', kind: 'paper' as const, url: '' },
  {
    source: "OpenAI",
    kind: "news" as const,
    url: "https://openai.com/news/rss.xml",
  },
  {
    source: "Google DeepMind",
    kind: "news" as const,
    url: "https://deepmind.google/blog/rss.xml",
  },
];
export async function syncNews(stopAt = Date.now() + 4000) {
  const gaps: string[] = [];
  let count = 0;
  let complete = true;
  const cached = await getState<{ at: string | null; gaps: string[] }>("newsSync");
  if (cached?.at && Date.now() - Date.parse(cached.at) < 3600000)
    return { count: 0, gaps: cached.gaps };
  for (const f of feeds) {
    if (Date.now() >= stopAt) {
      complete = false;
      gaps.push('Research feeds deferred: time budget reached; stored articles remain available.');
      break;
    }
    try {
      const result = f.kind === 'paper'
        ? await fetchResearchFeed(stopAt)
        : { news: await fetchFeed(f.url, f.source, f.kind, stopAt), gaps: [] };
      gaps.push(...result.gaps);
      const news = result.news;
      const unique = [...new Map(news.map((n) => [n.id, n])).values()];
      if (unique.length) {
        await db()`insert into news(id,data,published_at)
          select entry->>'id',entry,(entry->>'publishedAt')::timestamptz
          from jsonb_array_elements(${db().json(unique as never)}) as entry
          on conflict(id) do update set data=excluded.data,fetched_at=now()`;
        count += unique.length;
      }
    } catch {
      complete = false;
      gaps.push(
        `${f.source} feed unavailable or invalid; stored articles remain available.`,
      );
    }
  }
  await setState("newsSync", { at: complete ? new Date().toISOString() : null, status: complete ? 'completed' : 'partial', gaps });
  return { count, gaps };
}
