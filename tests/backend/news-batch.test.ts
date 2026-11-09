import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { db } from "../../lib/db";
import { syncNews } from "../../lib/news";
const enabled = !!process.env.TEST_DATABASE_URL;
if (enabled) {
  const target = new URL(process.env.TEST_DATABASE_URL!);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || !target.pathname.includes('test'))
    throw new Error('News batch tests require a local disposable test database.');
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}
beforeAll(async () => {
  if (!enabled) return;
  await db().unsafe(await readFile("db/001_init.sql", "utf8"));
});
afterAll(async () => {
  vi.unstubAllGlobals();
  if (enabled) {
    await db().unsafe("drop trigger if exists test_news_writes on news; drop function if exists test_news_write(); drop table if exists test_news_count");
    await db()`delete from news`;
    await db()`delete from state where key='newsSync'`;
    await db().end();
  }
});
it.skipIf(!enabled)("defers optional feeds once their shared deadline expires without caching success", async () => {
  await db()`delete from state where key='newsSync'`;
  let calls = 0;
  vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
    calls++;
    return new Promise<Response>((resolve,reject) => {
      const timer = setTimeout(() => resolve(new Response('<rss><channel/></rss>')),700);
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(timer); reject(init.signal?.reason);
      }, {once:true});
    });
  });
  const start = performance.now();
  const result = await syncNews(Date.now() + 250);
  expect(performance.now() - start).toBeLessThan(550);
  expect(calls).toBe(1);
  expect(result.count).toBe(0);
  expect(result.gaps.join(' ')).toMatch(/deferred|budget/);
  const state = (await db()`select value from state where key='newsSync'`)[0]?.value;
  expect(state?.status).toBe('partial');
  expect(state?.at).toBeNull();
});
it.skipIf(!enabled)("stores 300 feed entries using at most three insert statements", async () => {
  await db()`delete from state where key='newsSync'`;
  await db()`delete from news`;
  await db().unsafe(`create table test_news_count(n int); insert into test_news_count values(0);
    create function test_news_write() returns trigger language plpgsql as $$ begin update test_news_count set n=n+1; return null; end $$;
    create trigger test_news_writes after insert on news for each statement execute function test_news_write()`);
  vi.stubGlobal("fetch", async (url: string) => new Response('<rss><channel>' + Array.from({ length: 100 }, (_, i) => `<item><title>Entry ${i}</title><link>https://example.com/${encodeURIComponent(String(url))}/${i}</link><pubDate>Mon, 09 Nov 2026 00:00:00 GMT</pubDate></item>`).join('') + '</channel></rss>'));
  const result = await syncNews();
  expect(result.count).toBe(300);
  expect(Number((await db()`select count(*) from news`)[0].count)).toBe(300);
  expect((await db()`select n from test_news_count`)[0].n).toBeLessThanOrEqual(3);
});
