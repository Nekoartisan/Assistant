import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { db, getState } from '../../lib/db';
import { encrypt } from '../../lib/security';
import { runSync, syncAccount } from '../../lib/sync';
const enabled = !!process.env.TEST_DATABASE_URL;
if (enabled) {
  const u = new URL(process.env.TEST_DATABASE_URL!);
  if (!['localhost','127.0.0.1','[::1]'].includes(u.hostname) || !u.pathname.includes('test')) throw new Error('Local disposable test DB required');
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}
const emails = ['throughput-a@example.com','throughput-b@example.com'];
beforeAll(async () => { if(enabled) await db().unsafe(await readFile('db/001_init.sql','utf8')); });
beforeEach(async () => {
  if(!enabled) return;
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32,9).toString('base64');
  process.env.OWNER_EMAILS = emails.join(',');
  process.env.OPENAI_API_KEY = 'test'; process.env.OPENAI_MODEL = 'test';
  await db()`truncate accounts,sources,news,state,leases cascade`;
  for(const email of emails) await db()`insert into accounts(email,refresh_token) values(${email},${encrypt(email)})`;
});
afterAll(async () => { vi.unstubAllGlobals(); if(enabled) { await db()`truncate accounts,sources,news,state,leases cascade`; await db().end(); } });
function provider(onThread: (id:string) => Promise<Response>) {
  return async (input:RequestInfo|URL) => {
    const u=String(input);
    if(u.includes('oauth2.googleapis.com')) return Response.json({access_token:'a'});
    if(u.includes('/profile')) return Response.json({historyId:'100'});
    if(u.includes('/threads?')) return Response.json({threads:Array.from({length:10},(_,i)=>({id:'t'+i}))});
    if(u.includes('/threads/')) return onThread(new URL(u).pathname.split('/').at(-1)!);
    if(u.includes('/history?')) return Response.json({historyId:'200',history:[]});
    if(u.includes('chat/completions')) return Response.json({choices:[{message:{content:'{"facts":[]}'}}]});
    if(u.includes('calendarList')) return Response.json({items:[]});
    throw new Error('optional feed');
  };
}
it.skipIf(!enabled)('drains full calendar pages, resumes old queues, and never completes an invalid page', async () => {
  delete process.env.OPENAI_API_KEY;
  const events=Array.from({length:100},(_,i)=>({id:'e'+i,summary:'Meeting',start:{date:'2026-12-10'}}));
  let pages=0;
  const normal=provider(async()=>thread());
  vi.stubGlobal('fetch',async(input:RequestInfo|URL)=>{
    const u=String(input);
    if(u.includes('calendarList'))return Response.json({items:[{id:'empty'},{id:'primary'}]});
    if(u.includes('/empty/events?'))return Response.json({items:[]});
    if(u.includes('/events?')){pages++;return Response.json({items:events});}
    return normal(input);
  });
  let row=(await db()`select * from accounts order by email limit 1`)[0];
  const result=await syncAccount(row as never,8,Date.now()+10000);
  expect(result.calendarProcessed).toBe(100);
  expect(result.madeProgress).toBe(true);
  row=(await db()`select * from accounts where email=${row.email}`)[0];
  expect(row.cursor.calendarComplete).toBe(true);
  expect(row.cursor.calendarIndex).toBe(2);
  expect(pages).toBe(1);
  // A saved old queue must drain without another provider page read.
  row.cursor={calendars:[{id:'primary'}],calendarQueue:events.slice(0,3),calendarNext:null};
  await syncAccount(row as never,8,Date.now()+10000);
  expect(pages).toBe(1);
  row.cursor={calendars:[{id:'primary'}],calendarQueue:[{id:'bad',start:{date:'not-a-date'}}],calendarNext:null};
  const invalid=await syncAccount(row as never,8,Date.now()+10000);
  expect(invalid.gaps.join(' ')).toMatch(/bad.*invalid/);
  const cursor=(await db()`select cursor from accounts where email=${row.email}`)[0].cursor;
  expect(cursor.calendarComplete).not.toBe(true);
  expect(cursor.calendarQueue).toHaveLength(1);
  expect(invalid.madeProgress).toBe(false);
});
const thread = () => Response.json({messages:[{id:'m',payload:{mimeType:'text/plain',body:{data:Buffer.from('No deadlines, complete evidence').toString('base64url')}}}]});
it.skipIf(!enabled)('does not restart a fresh completed calendar scan on every email backfill batch', async () => {
  const reads: string[] = [];
  const normal = provider(async () => thread());
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => { reads.push(String(input)); return normal(input); });
  let row = (await db()`select * from accounts order by email limit 1`)[0];
  row.cursor = {calendarComplete:true,calendarIndex:0,calendars:[],calendarSyncedAt:new Date().toISOString(),mailComplete:true,mailListingDone:true,historyId:'200'};
  const first = await syncAccount(row as never, 0, Date.now()+10000);
  expect(reads.some(url => url.includes('calendarList'))).toBe(false);
  expect(first.madeProgress).toBe(false);
  row = (await db()`select * from accounts where email=${row.email}`)[0];
  row.cursor.calendarSyncedAt = new Date(Date.now()-16*60000).toISOString();
  await syncAccount(row as never,0,Date.now()+10000);
  expect(reads.filter(url => url.includes('calendarList'))).toHaveLength(1);
});
it.skipIf(!enabled)('includes subject-only deadlines and per-message chronological context in full source evidence', async () => {
  const normal=provider(async()=>Response.json({messages:[
    {id:'new',internalDate:'1794182500000',payload:{mimeType:'text/plain',headers:[{name:'Subject',value:'Exam 10 December 2026'},{name:'From',value:'teacher@example.com'},{name:'Date',value:'9 November 2026 10:00 +0700'}],body:{data:Buffer.from('Bring a pencil').toString('base64url')}}},
    {id:'old',internalDate:'1794182400000',payload:{mimeType:'text/plain',body:{data:Buffer.from('Previous full text').toString('base64url')}}},
  ]}));
  vi.stubGlobal('fetch',async(input:RequestInfo|URL)=>{
    if(String(input).includes('chat/completions')) return Response.json({choices:[{message:{content:JSON.stringify({facts:[{key:'exam',title:'Exam',kind:'exam',dueAt:null,dateOnly:'2026-12-10',timezone:null,originalDateText:'10 December 2026',evidence:'Exam 10 December 2026',confidence:1,cancelled:false}]})}}]});
    return normal(input);
  });
  const row=(await db()`select * from accounts order by email limit 1`)[0];
  expect((await syncAccount(row as never,1,Date.now()+10000)).processed).toBe(1);
  const source=(await db()`select body,extracted from sources where account=${row.email}`)[0];
  expect(source.extracted).toBe(true);
  expect(source.body).toContain('Subject: Exam 10 December 2026');
  expect(source.body).toContain('From: teacher@example.com');
  expect(source.body).toContain('Date: 9 November 2026 10:00 +0700');
  expect(source.body.indexOf('Previous full text')).toBeLessThan(source.body.indexOf('Bring a pencil'));
  expect(source.body).toContain('internalDate');
  expect((await db()`select data from items`)[0].data.dateOnly).toBe('2026-12-10');
});
it.skipIf(!enabled)('does not report timestamp-only or unchanged history checks as forward progress while retries back off', async()=>{
  const normal=provider(async()=>thread());
  vi.stubGlobal('fetch',normal);
  const row=(await db()`select * from accounts order by email limit 1`)[0];
  row.cursor={mailQueue:[],mailListingDone:true,mailComplete:false,historyId:'200',historyPage:null,mailRetries:{bad:{attempts:1,nextRetryAt:new Date(Date.now()+60000).toISOString(),reason:'Model returned invalid JSON'}},calendars:[{id:'primary'}],calendarQueue:[{id:'bad-event',start:{date:'invalid'}}]};
  const result=await syncAccount(row as never,8,Date.now()+10000);
  expect(result.madeProgress).toBe(false);
  expect(result.processed).toBe(0);
  expect(result.gaps.join(' ')).toContain('Model returned invalid JSON');
});
it.skipIf(!enabled)('refills pages within the attempt budget without losing pending IDs or changing frozen scope',async()=>{
  const urls:string[]=[];
  const normal=provider(async()=>thread());
  vi.stubGlobal('fetch',async(input:RequestInfo|URL)=>{
    const u=String(input);urls.push(u);
    if(u.includes('/threads?')) {
      if(u.includes('pageToken=p2'))return Response.json({threads:Array.from({length:8},(_,i)=>({id:'t'+(i+2)})),nextPageToken:'p3'});
      return Response.json({threads:[{id:'t0'},{id:'t1'}],nextPageToken:'p2'});
    }
    return normal(input);
  });
  let row=(await db()`select * from accounts order by email limit 1`)[0];
  row.cursor={historyId:'99',lookback:123456789};
  expect((await syncAccount(row as never,8,Date.now()+10000)).processed).toBe(8);
  row=(await db()`select * from accounts where email=${row.email}`)[0];
  expect(row.cursor).toMatchObject({mailQueue:['t8','t9'],mailPage:'p3',mailListingDone:false,mailComplete:false,lookback:123456789,historyId:'99'});
  expect(urls.filter(u=>u.includes('/threads?'))).toHaveLength(2);
  expect(urls.filter(u=>u.includes('/threads?')).every(u=>new URL(u).searchParams.get('q')==='after:123456789')).toBe(true);
  const reads=urls.filter(u=>u.includes('/threads?')).length;
  expect((await syncAccount(row as never,1,Date.now()+10000)).processed).toBe(1);
  expect(urls.filter(u=>u.includes('/threads?'))).toHaveLength(reads);
  expect((await db()`select cursor from accounts where email=${row.email}`)[0].cursor.mailQueue).toEqual(['t9']);
});
it.skipIf(!enabled)('gives model extraction up to twenty seconds rather than the old eight-second cap',async()=>{
  const normal=provider(async()=>thread());
  const timeouts:number[]=[];
  const timeout=AbortSignal.timeout.bind(AbortSignal);
  vi.spyOn(AbortSignal,'timeout').mockImplementation(ms=>{timeouts.push(ms);return timeout(ms);});
  let modelTimeout=0;
  vi.stubGlobal('fetch',async(input:RequestInfo|URL)=>{
    if(String(input).includes('chat/completions'))modelTimeout=timeouts.at(-1)!;
    return normal(input);
  });
  const row=(await db()`select * from accounts order by email limit 1`)[0];
  await syncAccount(row as never,1,Date.now()+30000);
  expect(modelTimeout).toBe(20000);
});
it.skipIf(!enabled)('runs two full threads per account concurrently, four globally, and eight attempts each', async () => {
  let active=0, peak=0;
  vi.stubGlobal('fetch',provider(async()=>{ active++; peak=Math.max(peak,active); await new Promise(r=>setTimeout(r,30)); active--; return thread(); }));
  const result=await runSync();
  expect(peak).toBe(4);
  expect((await db()`select id from sources where kind='mail' and extracted`)).toHaveLength(16);
  const rows=await db()`select cursor from accounts`;
  expect(rows.every(r=>r.cursor.mailQueue.join(',')==='t8,t9')).toBe(true);
  const state=await getState<{processed:number;madeProgress:boolean;calendarProcessed:number}>('sync');
  expect(state).toMatchObject({processed:16,madeProgress:true,calendarProcessed:0});
  expect(result.summary).toContain('Processed 16 full email threads');
});
it.skipIf(!enabled)('isolates a failed head thread in durable backoff while persisting the rest and later retries it', async () => {
  const seen:string[]=[];
  vi.stubGlobal('fetch',provider(async id=>{seen.push(id); return id==='t0'?new Response(null,{status:503}):thread();}));
  let row=(await db()`select * from accounts order by email limit 1`)[0];
  const r=await syncAccount(row as never,8,Date.now()+10000);
  expect(r.processed).toBe(7);
  row=(await db()`select * from accounts where email=${row.email}`)[0];
  expect(row.cursor.mailQueue).toEqual(['t8','t9']);
  expect(row.cursor.mailRetries.t0).toMatchObject({attempts:1});
  expect(Date.parse(row.cursor.mailRetries.t0.nextRetryAt)).toBeGreaterThan(Date.now());
  expect(row.cursor.mailComplete).toBe(false);
  expect(row.gap).toMatch(/t0.*retry|retry.*t0/i);
  seen.length=0;
  await syncAccount(row as never,8,Date.now()+10000);
  expect(seen).not.toContain('t0');
  row=(await db()`select * from accounts where email=${row.email}`)[0];
  // Discovery is exhausted, but failures must not prevent fresh history reads.
  const urls:string[]=[];
  const normal=provider(async id=>{seen.push(id);return thread();});
  vi.stubGlobal('fetch',async (input:RequestInfo|URL)=>{urls.push(String(input));return normal(input);});
  await syncAccount(row as never,8,Date.now()+10000);
  expect(urls.some(u=>u.includes('/history?'))).toBe(true);
  row=(await db()`select * from accounts where email=${row.email}`)[0];
  row.cursor.mailRetries.t0.nextRetryAt=new Date(0).toISOString();
  await db()`update accounts set cursor=${db().json(row.cursor)} where email=${row.email}`;
  await syncAccount(row as never,8,Date.now()+10000);
  row=(await db()`select * from accounts where email=${row.email}`)[0];
  expect(row.cursor.mailRetries).toEqual({});
  expect(row.cursor.mailComplete).toBe(true);
  expect((await db()`select id from sources where account=${row.email} and extracted`)).toHaveLength(10);
});
