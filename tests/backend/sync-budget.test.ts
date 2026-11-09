import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { db, getState } from "../../lib/db";
import { encrypt } from "../../lib/security";
import { runSync, syncAccount } from "../../lib/sync";
const enabled = !!process.env.TEST_DATABASE_URL;
if (enabled) {
  const target = new URL(process.env.TEST_DATABASE_URL!);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || !target.pathname.includes('test'))
    throw new Error('Sync budget tests require a local disposable test database.');
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}
const emails = ['a-budget@example.com', 'b-budget@example.com'];
beforeAll(async () => {
  if (enabled) await db().unsafe(await readFile('db/001_init.sql', 'utf8'));
});
beforeEach(async () => {
  if (!enabled) return;
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  process.env.OWNER_EMAILS = emails.join(',');
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.OPENAI_MODEL = 'test';
  await db()`truncate accounts,sources,news,state,leases cascade`;
  for (const email of emails) await db()`insert into accounts(email,refresh_token) values(${email},${encrypt(email)})`;
});
afterAll(async () => {
  vi.unstubAllGlobals();
  if (enabled) {
    await db()`truncate accounts,sources,news,state,leases cascade`;
    await db().end();
  }
});
function providers(seen: string[], advance: (ms: number) => void = () => {}) {
  return async (input: RequestInfo | URL) => {
    const u = String(input); seen.push(u);
    if (u.includes('oauth2.googleapis.com')) return Response.json({access_token:'access'});
    if (u.includes('/profile')) return Response.json({historyId:'100'});
    if (u.includes('/history?')) return Response.json({historyId:'101',history:[]});
    if (u.includes('/threads?')) return Response.json({threads:[{id:'t1'},{id:'t2'}]});
    if (u.includes('/threads/')) return Response.json({messages:[{id:'m',payload:{mimeType:'text/plain',body:{data:Buffer.from('No deadlines').toString('base64url')}}}]});
    if (u.includes('/chat/completions')) { advance(7000); return Response.json({choices:[{message:{content:'{"facts":[]}'}}]}); }
    if (u.includes('calendarList')) return Response.json({items:[]});
    advance(30000);
    throw new Error('slow optional feed');
  };
}
it.skipIf(!enabled)('bounds Google reads by the same frozen account deadline', async () => {
  const seen: string[] = [];
  const normal = providers(seen);
  let aborted = false;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!String(input).includes('/profile')) return normal(input);
    return new Promise<Response>((resolve,reject) => {
      const timer = setTimeout(() => resolve(Response.json({historyId:'100'})), 700);
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(timer); aborted = true; reject(init.signal?.reason);
      }, {once:true});
    });
  });
  const start = performance.now();
  const row = (await db()`select * from accounts order by email limit 1`)[0];
  const result = await syncAccount(row as {email:string;refresh_token:string}, 1, Date.now() + 250);
  expect(aborted).toBe(true);
  expect(result.processed).toBe(0);
  expect(performance.now() - start).toBeLessThan(550);
  const saved = (await db()`select cursor,last_sync_at from accounts where email=${row.email}`)[0];
  expect(saved.cursor.historyId).toBeUndefined();
  expect(saved.last_sync_at).toBeTruthy();
  expect(seen.some(u => u.includes('calendarList'))).toBe(true);
});
it.skipIf(!enabled)('aborts a model call at the deadline and durably isolates its retry without losing pending IDs', async () => {
  const seen: string[] = [];
  const normal = providers(seen);
  let aborted = false;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!String(input).includes('chat/completions')) return normal(input);
    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(Response.json({choices:[{message:{content:'{"facts":[]}'}}]})), 700);
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(timer); aborted = true; reject(init.signal?.reason);
      }, {once:true});
    });
  });
  const start = performance.now();
  const row = (await db()`select * from accounts order by email limit 1`)[0];
  const result = await syncAccount(row as {email:string;refresh_token:string}, 1, Date.now() + 250.5);
  expect(result.processed).toBe(0);
  expect(aborted).toBe(true);
  expect(performance.now() - start).toBeLessThan(550);
  const saved = (await db()`select cursor,gap,last_sync_at from accounts where email=${row.email}`)[0];
  expect(saved.cursor.mailQueue).toEqual(['t2']);
  expect(saved.cursor.mailRetries.t1.attempts).toBe(1);
  expect(saved.cursor.mailRetries.t1.reason).toContain('Time budget');
  expect(saved.cursor.mailComplete).not.toBe(true);
  expect(saved.last_sync_at).toBeTruthy();
  expect(saved.gap).toContain('Time budget reached');
  expect((await db()`select extracted from sources`)[0].extracted).toBe(false);
  expect(seen.some(u => u.includes('calendarList'))).toBe(true);
});
it.skipIf(!enabled)('checkpoints a complete calendar page atomically and retains a failed following page', async () => {
  const normal = providers([]);
  delete process.env.OPENAI_API_KEY;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const u = String(input);
    if (u.includes('calendarList')) return Response.json({items:[{id:'primary'}]});
    if (u.includes('pageToken=page-2')) return new Response(null,{status:503});
    if (u.includes('/events?')) return Response.json({items:[1,2,3].map(i => ({id:'e'+i,summary:'Event '+i,start:{date:'2026-12-01'}})),nextPageToken:'page-2'});
    return normal(input);
  });
  let row = (await db()`select * from accounts order by email limit 1`)[0];
  await syncAccount(row as {email:string;refresh_token:string},1,Date.now()+10000);
  row = (await db()`select * from accounts where email=${row.email}`)[0];
  expect((await db()`select id from sources where kind='calendar' and extracted`)).toHaveLength(3);
  expect(row.cursor.calendarQueue).toBeUndefined();
  expect(row.cursor.calendarComplete).toBe(false);
  expect(row.cursor.calendarPage).toBe('page-2');
  await syncAccount(row as {email:string;refresh_token:string},1,Date.now()+10000);
  const saved = (await db()`select cursor from accounts where email=${row.email}`)[0].cursor;
  expect(saved.calendarPage).toBe('page-2');
  expect(saved.calendarComplete).toBe(false);
  expect((await db()`select id from sources where kind='calendar'`)).toHaveLength(3);
});
it.skipIf(!enabled)('reserves a fair account slice instead of spending the whole run on the first account', async () => {
  const seen: string[] = [];
  let clock = Date.now();
  const startedAt = clock;
  vi.spyOn(Date,'now').mockImplementation(() => clock);
  const normal = providers(seen, ms => { clock += ms; });
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    if (String(input).includes('googleapis.com')) clock += 5000;
    return normal(input);
  });
  try {
    await runSync();
    const accounts = await db()`select cursor,last_sync_at from accounts order by email`;
    expect(accounts.every(a => a.last_sync_at && a.cursor.historyId === '100')).toBe(true);
    expect(seen.filter(u => u.includes('oauth2.googleapis.com'))).toHaveLength(2);
    expect(clock - startedAt).toBeLessThanOrEqual(45000);
  } finally { vi.restoreAllMocks(); }
});
it.skipIf(!enabled)('skips optional news when the work deadline is exhausted', async () => {
  const seen: string[] = [];
  let clock = Date.now();
  vi.spyOn(Date,'now').mockImplementation(() => clock);
  const normal = providers(seen, ms => { clock += ms; });
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const response = await normal(input);
    if (String(input).includes('calendarList')) clock += 40000;
    return response;
  });
  try {
    const result = await runSync();
    expect(seen.every(u => u.includes('googleapis.com') || u.includes('chat/completions'))).toBe(true);
    expect(result.gaps.join(' ')).toMatch(/Research.*deferred/);
    expect((await db()`select * from leases where name='sync'`)).toHaveLength(0);
    const state = await getState<{phase:string;status:string}>('sync');
    expect(state?.phase).toBe('finished');
    expect(state?.status).toBe('partial');
  } finally { vi.restoreAllMocks(); }
});
it.skipIf(!enabled)('does not count a vanished thread as extracted or consume extra turns', async () => {
  const normal = providers([]);
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => String(input).includes('/threads/')
    ? new Response(null,{status:404}) : normal(input));
  const row = (await db()`select * from accounts order by email limit 1`)[0];
  const result = await syncAccount(row as {email:string;refresh_token:string},1,Date.now()+10000);
  expect(result.processed).toBe(0);
  const saved = (await db()`select cursor from accounts where email=${row.email}`)[0].cursor;
  expect(saved.mailQueue).toEqual(['t2']);
  expect(saved.mailComplete).not.toBe(true);
});
it.skipIf(!enabled)('publishes a parallel accounts phase and authoritative finished state under a bounded lease', async () => {
  const normal = providers([]);
  const observed: {url:string;phase?:string;account?:string;ttl:number}[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const state = await getState<{phase:string;account:string}>('sync');
    const lease = (await db()`select extract(epoch from expires_at-now())::float8 as ttl from leases where name='sync'`)[0];
    observed.push({url:String(input),phase:state?.phase,account:state?.account,ttl:lease.ttl});
    return normal(input);
  });
  await runSync();
  expect(observed.filter(r => r.url.includes('googleapis.com')).every(r => r.phase === 'accounts')).toBe(true);
  expect((await getState<{phase:string}>('sync'))?.phase).toBe('finished');
  expect(observed.filter(r => r.url.includes('arxiv')).every(r => r.phase === 'news')).toBe(true);
  expect(observed.every(r => r.ttl <= 65)).toBe(true);
});
it.skipIf(!enabled)('records failed authorization attempts without leaving an account permanently first', async () => {
  vi.stubGlobal('fetch', async () => Response.json({error:'invalid_grant'}, {status:400}));
  await runSync();
  const accounts = await db()`select last_sync_at,gap from accounts order by email`;
  expect(accounts.every(a => a.last_sync_at && /authorization/.test(a.gap))).toBe(true);
  expect((await getState<{status:string;processed:number}>('sync'))?.processed).toBe(0);
  expect((await db()`select * from leases where name='sync'`)).toHaveLength(0);
});
it.skipIf(!enabled)('persists a failed final state and releases the lease after an orchestration error', async () => {
  await db()`alter table accounts rename to test_hidden_accounts`;
  let result: Awaited<ReturnType<typeof runSync>> | undefined;
  let failure: unknown;
  try { result = await runSync(); } catch (error) { failure = error; }
  finally { await db()`alter table test_hidden_accounts rename to accounts`; }
  expect(failure).toBeUndefined();
  expect(result?.ok).toBe(false);
  const state = await getState<{phase:string;status:string;gaps:string[]}>('sync');
  expect(state?.phase).toBe('finished');
  expect(state?.status).toBe('failed');
  expect(state?.gaps.join(' ')).toMatch(/unavailable|failed/);
  expect((await db()`select * from leases where name='sync'`)).toHaveLength(0);
});
it.skipIf(!enabled)('gives both accounts concurrent durable full-page mail turns before optional slow feeds', async () => {
  const seen: string[] = [];
  let clock = Date.now();
  vi.spyOn(Date,'now').mockImplementation(() => clock);
  vi.stubGlobal('fetch',providers(seen, ms => { clock += ms; }));
  try {
    const result = await runSync();
    const sources = await db()`select account,extracted from sources order by account`;
    expect(sources).toHaveLength(4);
    expect(sources.map(s => s.account)).toEqual([emails[0],emails[0],emails[1],emails[1]]);
    expect(sources.every(s => s.extracted)).toBe(true);
    const accounts = await db()`select cursor,last_sync_at from accounts order by email`;
    expect(accounts.every(a => a.cursor.mailQueue?.length === 0 && a.cursor.mailComplete && a.last_sync_at)).toBe(true);
    const firstFeed = seen.findIndex(u => !u.includes('googleapis.com') && !u.includes('chat/completions'));
    const modelCalls = seen.map((u,i) => u.includes('chat/completions') ? i : -1).filter(i => i >= 0);
    expect(modelCalls).toHaveLength(4);
    expect(firstFeed).toBeGreaterThan(modelCalls.at(-1)!);
    expect(result.summary).toContain('Processed 4 full email threads');
    expect((await db()`select * from leases where name='sync'`)).toHaveLength(0);
    expect((await getState<{phase:string}>('sync'))?.phase).toBe('finished');
  } finally { vi.restoreAllMocks(); }
});
