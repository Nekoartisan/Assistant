import { createHash } from 'node:crypto';
import { db } from './db';
import { calendarFacts, type CalendarEvent } from './google';
import { validateFacts } from './extraction';

/** A page is validated before any writes, then persisted in one atomic transaction.
 * Source revision, evidence reconciliation and optional cursor advance commit together. */
export async function saveCalendarPage(
  account: string,
  calendarId: string,
  events: CalendarEvent[],
  cursor?: unknown,
): Promise<number> {
  const now = new Date().toISOString();
  const seen = new Set<string>();
  const sources = events.map(event => {
    if (!event || typeof event.id !== 'string' || !event.id || seen.has(event.id))
      throw new Error('Calendar event invalid or duplicate ID; saved page requires review.');
    seen.add(event.id);
    const body = JSON.stringify(event);
    let facts;
    try {
      facts = validateFacts({facts:calendarFacts(event)}, body);
      if (!facts.length) throw new Error('missing event dates');
    } catch {
      throw new Error(`Calendar event ${event.id.slice(0,100)} invalid; saved page requires review.`);
    }
    const id = `${account}:calendar:${calendarId}:${event.id}`;
    const url = event.htmlLink?.startsWith('https://calendar.google.com/') ? event.htmlLink : 'https://calendar.google.com/calendar/u/0/r';
    return {id,account,body,url,revision:createHash('sha256').update(body).digest('hex'),facts:facts.map(f => {
      const itemId=createHash('sha256').update(id+'\0'+f.key).digest('hex').slice(0,32);
      return {id:itemId,source_id:id,fact_key:f.key,data:{
        id:itemId,title:f.title,kind:f.kind,dueAt:f.dueAt,dateOnly:f.dateOnly,timezone:f.timezone,
        originalDateText:f.originalDateText,evidence:f.evidence,sourceUrl:url,sourceAccount:account,
        status:f.cancelled?'dismissed':(!f.dueAt&&!f.dateOnly)||f.confidence<0.8?'needs_review':'open',
        confidence:f.confidence,updatedAt:now,notes:f.notes,location:f.location,
      }};
    })};
  });
  return db().begin(async tx => {
    const changed = sources.length ? await tx`
      insert into sources(id,account,kind,body,url,revision,extracted)
      select id,account,'calendar',body,url,revision,true
      from jsonb_to_recordset(${tx.json(sources as never)}) as s(id text,account text,body text,url text,revision text)
      on conflict(id) do update set body=excluded.body,url=excluded.url,revision=excluded.revision,extracted=true,updated_at=now()
      where sources.revision is distinct from excluded.revision or not sources.extracted returning id
    ` : [];
    const changedIds = changed.map(s=>s.id as string);
    if(changedIds.length) {
      const changedSet = new Set(changedIds);
      const facts=sources.filter(s=>changedSet.has(s.id)).flatMap(s=>s.facts);
      const payload=tx.json(facts as never);
      await tx`update items set data=jsonb_set(data,'{status}','"dismissed"')
        where source_id=any(${changedIds}) and not exists (
          select 1 from jsonb_to_recordset(${payload}) as f(source_id text,fact_key text)
          where f.source_id=items.source_id and f.fact_key=items.fact_key
        )`;
      await tx`insert into items(id,source_id,fact_key,data)
        select id,source_id,fact_key,data from jsonb_to_recordset(${payload}) as f(id text,source_id text,fact_key text,data jsonb)
        on conflict(source_id,fact_key) do update set data=case when items.manual then
          items.data || jsonb_build_object('evidence',excluded.data->'evidence','originalDateText',excluded.data->'originalDateText','updatedAt',excluded.data->'updatedAt')
          || case when excluded.data->>'status'='dismissed' then '{"status":"dismissed"}'::jsonb
            when items.data->>'status'='open' then '{"status":"needs_review"}'::jsonb else '{}'::jsonb end
        else excluded.data || case when items.data->>'status'='done' and excluded.data->>'status'<>'dismissed'
          then jsonb_build_object('status',items.data->'status') else '{}'::jsonb end end`;
    }
    if(cursor !== undefined)
      await tx`update accounts set cursor=${tx.json(cursor as never)} where email=${account}`;
    return changedIds.length;
  });
}
