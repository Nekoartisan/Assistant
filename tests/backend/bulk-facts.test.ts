import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { db } from '../../lib/db';
import { saveCalendarPage } from '../../lib/bulk-facts';
import type { CalendarEvent } from '../../lib/google';
const enabled=!!process.env.TEST_DATABASE_URL;
if(enabled){const u=new URL(process.env.TEST_DATABASE_URL!);if(!['localhost','127.0.0.1','[::1]'].includes(u.hostname)||!u.pathname.includes('test'))throw new Error('Local disposable test DB required');process.env.DATABASE_URL=process.env.TEST_DATABASE_URL;}
beforeAll(async()=>{if(enabled)await db().unsafe(await readFile('db/001_init.sql','utf8'));});
beforeEach(async()=>{if(enabled)await db()`truncate accounts,sources,news,state,leases cascade`;});
afterAll(async()=>{if(enabled){await db()`truncate accounts,sources,news,state,leases cascade`;await db().end();}});
it.skipIf(!enabled)('preserves manual edits and done status, cancels removed facts, and reinstates provider events',async()=>{
  const account='bulk@example.com', calendar='primary';
  const events=[event('manual'),event('normal'),event('done')];
  await saveCalendarPage(account,calendar,events);
  await db()`update items set manual=true,data=data || '{"title":"My title","dateOnly":"2026-12-20"}'::jsonb where source_id=${account+':calendar:primary:manual'} and fact_key='start'`;
  await db()`update items set data=data || '{"status":"done"}'::jsonb where source_id=${account+':calendar:primary:done'} and fact_key='start'`;
  const revised=events.map(e=>({...e,start:{date:'2026-12-12'}}));
  await saveCalendarPage(account,calendar,revised);
  const manual=(await db()`select data from items where source_id=${account+':calendar:primary:manual'} and fact_key='start'`)[0].data;
  expect(manual).toMatchObject({title:'My title',dateOnly:'2026-12-20',originalDateText:'2026-12-12',evidence:'{"date":"2026-12-12"}'});
  expect(manual.status).toBe('needs_review');
  expect((await db()`select data from items where source_id=${account+':calendar:primary:done'} and fact_key='start'`)[0].data.status).toBe('done');
  await saveCalendarPage(account,calendar,events.map(e=>({id:e.id,status:'cancelled'})));
  expect((await db()`select data from items`)).toSatisfy((rows:{data:{status:string}}[])=>rows.every(r=>r.data.status==='dismissed'));
  await saveCalendarPage(account,calendar,revised);
  expect((await db()`select data from items where source_id=${account+':calendar:primary:normal'} and fact_key='start'`)[0].data.status).toBe('open');
  // Manual cancelled entries stay dismissed exactly as saveFacts; no user intent overwritten.
  expect((await db()`select data from items where source_id=${account+':calendar:primary:manual'} and fact_key='start'`)[0].data).toMatchObject({title:'My title',status:'dismissed'});
});
it.skipIf(!enabled)('rolls back source, facts and cursor together on a database write failure',async()=>{
  const account='bulk@example.com';
  await db()`insert into accounts(email,refresh_token,cursor) values(${account},'unused','{"calendarIndex":0}')`;
  await db().unsafe(`create or replace function test_bulk_reject() returns trigger language plpgsql as $$ begin raise exception 'fixture rejected'; end $$;create trigger test_bulk_reject before insert on items for each statement execute function test_bulk_reject();`);
  try{
    await expect(saveCalendarPage(account,'primary',[event('e')],{calendarIndex:1,calendarComplete:true})).rejects.toThrow('fixture rejected');
    expect(await db()`select id from sources`).toHaveLength(0);
    expect(await db()`select id from items`).toHaveLength(0);
    expect((await db()`select cursor from accounts where email=${account}`)[0].cursor).toEqual({calendarIndex:0});
  }finally{await db().unsafe('drop trigger test_bulk_reject on items;drop function test_bulk_reject()');}
});
it.skipIf(!enabled)('rejects invalid page evidence without writing its valid siblings',async()=>{
  await expect(saveCalendarPage('bulk@example.com','primary',[event('good'),{id:'bad',start:{date:'invalid'}}])).rejects.toThrow('Calendar event bad invalid');
  expect(await db()`select id from sources`).toHaveLength(0);
});
const event=(id:string):CalendarEvent=>({id,summary:'Exam '+id,start:{date:'2026-12-10'},end:{date:'2026-12-11'}});
it.skipIf(!enabled)('persists a complete 100-event page using constant SQL statement writes and skips identical revisions',async()=>{
  await db().unsafe(`create table if not exists test_bulk_statements(name text); create or replace function test_bulk_count() returns trigger language plpgsql as $$ begin insert into test_bulk_statements values(TG_TABLE_NAME); return null; end $$; create trigger test_bulk_sources after update on sources for each statement execute function test_bulk_count(); create trigger test_bulk_items after update on items for each statement execute function test_bulk_count();`);
  try{
    const events=Array.from({length:100},(_,i)=>event('e'+i));
    expect(await saveCalendarPage('bulk@example.com','primary',events)).toBe(100);
    expect(await db()`select id from sources where extracted`).toHaveLength(100);
    expect(await db()`select id from items`).toHaveLength(200);
    const count=(await db()`select count(*)::int as n from test_bulk_statements`)[0].n;
    // UPDATE-only statement triggers count each UPSERT once, plus the reconciliation UPDATE.
    expect(count).toBe(3);
    const before=(await db()`select data from items order by id limit 1`)[0].data;
    expect(await saveCalendarPage('bulk@example.com','primary',events)).toBe(0);
    expect((await db()`select data from items order by id limit 1`)[0].data).toEqual(before);
    console.log(`100 events / 200 facts: ${count} write statements`);
  }finally{await db().unsafe('drop trigger test_bulk_sources on sources;drop trigger test_bulk_items on items;drop function test_bulk_count();drop table test_bulk_statements');}
});
