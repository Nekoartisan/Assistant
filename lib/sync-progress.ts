import { db, getState } from "./db";
export interface SyncProgress {
  accounts: { email: string; processedThreads: number; pendingThreads: number; failedThreads: number; hasMoreMailPages: boolean; mailComplete: boolean; calendarsDone: number; calendarsTotal: number; calendarComplete: boolean }[];
  totalProcessedThreads: number;
  totalPendingThreads: number;
  totalFailedThreads: number;
  hasMore: boolean;
  canContinue: boolean;
  madeProgress: boolean;
  scopeDays: 90;
  blockedReasons: string[];
}
// Read only server-side, after the caller has checked owner authentication.
export async function readSyncProgress(): Promise<SyncProgress> {
  const rows = await db()`select a.email,a.cursor,a.gap,count(s.id)::int as processed from accounts a left join sources s on s.account=a.email and s.kind='mail' and s.extracted=true group by a.email order by a.email`;
  const state = await getState<{ madeProgress?: boolean; status?: string; gaps?: string[] }>("sync");
  const blockedReasons: string[] = [];
  let eligible = false;
  const accounts = rows.map((row) => {
    const c = row.cursor && typeof row.cursor === "object" ? row.cursor : {};
    const queue = (Array.isArray(c.mailQueue) ? c.mailQueue : []).filter((id: unknown) => typeof id === "string");
    const retries = c.mailRetries && typeof c.mailRetries === "object" && !Array.isArray(c.mailRetries) ? c.mailRetries : {};
    const retryIds = Object.keys(retries);
    const pending = new Set([...queue, ...retryIds]);
    const hasMoreMailPages = !!c.mailPage || !!c.historyPage || (c.mailListingDone !== true && c.mailComplete !== true);
    const mailComplete = c.mailComplete === true && pending.size === 0 && !hasMoreMailPages;
    const calendarComplete = c.calendarComplete === true;
    const calendarsTotal = Array.isArray(c.calendars) ? c.calendars.length : 0;
    const calendarsDone = Math.min(calendarsTotal, Math.max(0, Number.isFinite(c.calendarIndex) ? Math.floor(c.calendarIndex) : 0));
    const dueRetry = retryIds.some((id) => !Number.isFinite(Date.parse(retries[id]?.nextRetryAt)) || Date.parse(retries[id]?.nextRetryAt) <= Date.now());
    if (queue.some((id: string) => !retryIds.includes(id)) || dueRetry || hasMoreMailPages || !calendarComplete) eligible = true;
    for (const id of retryIds) if (typeof retries[id]?.reason === "string") blockedReasons.push(`${row.email}: ${retries[id].reason}`);
    if (row.gap) blockedReasons.push(...String(row.gap).split('\n'));
    return { email: row.email, processedThreads: Number(row.processed), pendingThreads: pending.size, failedThreads: retryIds.length, hasMoreMailPages, mailComplete, calendarsDone, calendarsTotal, calendarComplete };
  });
  const hasMore = accounts.some((a) => !a.mailComplete || !a.calendarComplete);
  blockedReasons.push(...(state?.gaps || []));
  const hardProviderError = blockedReasons.some(reason => /Model request failed \((?:400|401|403|404|429)\)|Model API (?:configuration|must use|authentication|quota|rejected)|Google authorization unavailable|Integration unavailable; check provider configuration/i.test(reason));
  const blocked = hardProviderError || state?.status === "failed" || (state?.madeProgress === false && blockedReasons.length > 0);
  return { accounts, totalProcessedThreads: accounts.reduce((n,a) => n+a.processedThreads,0), totalPendingThreads: accounts.reduce((n,a) => n+a.pendingThreads,0), totalFailedThreads: accounts.reduce((n,a) => n+a.failedThreads,0), hasMore, canContinue: hasMore && eligible && !blocked, madeProgress: state?.madeProgress === true, scopeDays:90, blockedReasons:[...new Set(blockedReasons.filter(Boolean))] };
}
