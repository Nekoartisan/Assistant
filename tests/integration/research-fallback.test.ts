import { describe, expect, it, vi, afterEach } from 'vitest';
import * as news from '../../lib/news';

afterEach(() => vi.unstubAllGlobals());
describe('arXiv resilient collection', () => {
  it('falls back to announcements, explicitly labeling their date basis', async () => {
    expect(typeof news.fetchResearchFeed, 'A blocked API must have an RSS fallback').toBe('function');
    const requested: string[] = [];
    vi.stubGlobal('fetch', async (url: string | URL | Request) => {
      requested.push(String(url));
      if (String(url).includes('export.arxiv.org')) return new Response('unavailable', { status: 503 });
      return new Response('<rss><channel><item><title>Example paper</title><link>https://arxiv.org/abs/2611.01234</link><description>Research abstract</description><pubDate>Mon, 09 Nov 2026 00:00:00 -0500</pubDate></item></channel></rss>');
    });
    const result = await news.fetchResearchFeed();
    expect(requested).toHaveLength(2);
    expect(requested[0]).toContain('cs.CV');
    expect(requested[0]).toContain('stat.ML');
    expect(requested[1]).toContain('rss.arxiv.org');
    expect(result.news).toHaveLength(1);
    expect(result.news[0].source).toMatch(/announcement/i);
    expect(result.news[0].publishedAt).toBe('2026-11-09T05:00:00.000Z');
    expect(result.gaps.join(' ')).toMatch(/not.*submission/i);
  });
  it('distinguishes both fetches failing from a valid empty research window', async () => {
    expect(typeof news.fetchResearchFeed).toBe('function');
    vi.stubGlobal('fetch', async () => new Response('unavailable', { status: 503 }));
    await expect(news.fetchResearchFeed()).rejects.toThrow(/arXiv/i);
  });
});
