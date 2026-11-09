import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { db, setState } from "../../lib/db";
import { readSyncProgress } from "../../lib/sync-progress";
const enabled = !!process.env.TEST_DATABASE_URL;
if (enabled) {
  const url = new URL(process.env.TEST_DATABASE_URL!);
  if (!["localhost", "127.0.0.1"].includes(url.hostname) || !url.pathname.endsWith("_test")) throw new Error("Disposable local test database required");
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}
beforeAll(async () => { if (enabled) await db().unsafe(await readFile("db/001_init.sql", "utf8")); });
beforeEach(async () => { if (enabled) { await db()`delete from items`; await db()`delete from sources`; await db()`delete from accounts`; await db()`delete from state where key='sync'`; } });
afterAll(async () => { if (enabled) await db().end(); });
it.skipIf(!enabled)("counts persisted extracted mail, distinct pending retries, and calendar index, not extracted facts", async () => {
  await db()`insert into accounts(email,refresh_token,cursor) values('owner@example.com','test',${db().json({mailQueue:['a','a','b'],mailRetries:{b:{nextRetryAt:'2099-01-01',reason:'Provider unavailable'},c:{nextRetryAt:'2099-01-01',reason:'Timeout'}},mailPage:'next',calendars:[{id:'one'},{id:'two'}],calendarIndex:1})})`;
  await db()`insert into sources(id,account,kind,body,url,extracted) values('one','owner@example.com','mail','','',true),('two','owner@example.com','mail','','',false),('cal','owner@example.com','calendar','','',true)`;
  await setState('sync',{madeProgress:true,status:'partial'});
  expect(await readSyncProgress()).toMatchObject({scopeDays:90,totalProcessedThreads:1,totalPendingThreads:3,totalFailedThreads:2,hasMore:true,canContinue:true,madeProgress:true,accounts:[{email:'owner@example.com',processedThreads:1,pendingThreads:3,failedThreads:2,hasMoreMailPages:true,mailComplete:false,calendarsDone:1,calendarsTotal:2,calendarComplete:false}]});
});
it.skipIf(!enabled)("stops future-only retries and explicit blocked no-progress passes without losing incomplete coverage", async () => {
  await db()`insert into accounts(email,refresh_token,cursor) values('owner@example.com','test',${db().json({mailListingDone:true,mailRetries:{a:{nextRetryAt:'2099-01-01',reason:'Retry backoff'}},calendarComplete:true})})`;
  await setState('sync',{madeProgress:false,status:'partial',gaps:['Retry backoff']});
  const result = await readSyncProgress();
  expect(result).toMatchObject({hasMore:true,canContinue:false,totalFailedThreads:1});
  expect(result.blockedReasons.join(' ')).toContain('Retry backoff');
});
it.skipIf(!enabled)("stops hard provider errors even when another source made progress", async () => {
  await db()`insert into accounts(email,refresh_token,cursor,gap) values('owner@example.com','test','{}','Model request failed (401)')`;
  await setState('sync',{madeProgress:true,status:'partial'});
  expect(await readSyncProgress()).toMatchObject({hasMore:true,canContinue:false,madeProgress:true});
});
it.skipIf(!enabled)("continues eligible calendar/backfill work beside delayed retries and stops when only optional gaps remain", async () => {
  await db()`insert into accounts(email,refresh_token,cursor) values('owner@example.com','test',${db().json({mailListingDone:true,mailRetries:{a:{nextRetryAt:'2099-01-01',reason:'Retry pending'}},calendarComplete:false})})`;
  await setState('sync',{madeProgress:true,status:'partial',gaps:['Optional feed unavailable']});
  expect(await readSyncProgress()).toMatchObject({canContinue:true,hasMore:true,totalFailedThreads:1});
  await db()`update accounts set cursor=${db().json({mailListingDone:true,mailComplete:true,calendarComplete:true,calendars:[{id:'a'},{id:'b'}],calendarIndex:2})}`;
  expect(await readSyncProgress()).toMatchObject({canContinue:false,hasMore:false,totalFailedThreads:0,accounts:[{mailComplete:true,calendarComplete:true,calendarsDone:2,calendarsTotal:2}]});
});
it.skipIf(!enabled)("handles legacy cursors and no accounts conservatively", async () => {
  expect(await readSyncProgress()).toMatchObject({accounts:[],hasMore:false,canContinue:false});
  await db()`insert into accounts(email,refresh_token,cursor) values('legacy@example.com','test','{}')`;
  expect(await readSyncProgress()).toMatchObject({hasMore:true,canContinue:true,accounts:[{processedThreads:0,pendingThreads:0,calendarsDone:0,calendarsTotal:0}]});
});
