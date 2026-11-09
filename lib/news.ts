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
async function fetchFeed(url: string, source: string, kind: 'paper' | 'news') {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(8000),
    headers: { 'User-Agent': 'BaoAssistant/1.0 (private research desk)' },
  });
  if (!response.ok) throw new Error('Feed unavailable');
  const entries = parseFeed(await response.text(), source, kind, new Date().toISOString());
  if (!entries.length) throw new Error('No valid feed entries');
  return entries;
}
export async function fetchResearchFeed(): Promise<{news: News[]; gaps: string[]}> {
  try {
    const news = await fetchFeed('https://export.arxiv.org/api/query?' + arxivQuery, 'arXiv', 'paper');
    return { news, gaps: [] };
  } catch {
    try {
      const news = await fetchFeed('https://rss.arxiv.org/rss/cs.AI+cs.LG+cs.CL+cs.CV+stat.ML', 'arXiv announcements (RSS)', 'paper');
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
export async function syncNews() {
  const gaps: string[] = [];
  let count = 0;
  const cached = await getState<{ at: string; gaps: string[] }>("newsSync");
  if (cached && Date.now() - Date.parse(cached.at) < 3600000)
    return { count: 0, gaps: cached.gaps };
  for (const f of feeds) {
    try {
      const result = f.kind === 'paper'
        ? await fetchResearchFeed()
        : { news: await fetchFeed(f.url, f.source, f.kind), gaps: [] };
      gaps.push(...result.gaps);
      const news = result.news;
      for (const n of news) {
        await db()`insert into news(id,data,published_at) values(${n.id},${db().json(n as never)},${n.publishedAt}) on conflict(id) do update set data=excluded.data,fetched_at=now()`;
        count++;
      }
    } catch {
      gaps.push(
        `${f.source} feed unavailable or invalid; stored articles remain available.`,
      );
    }
  }
  await setState("newsSync", { at: new Date().toISOString(), gaps });
  return { count, gaps };
}
