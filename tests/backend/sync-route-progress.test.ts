import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('../../lib/sync', () => ({runSync:vi.fn()}));
vi.mock('../../lib/sync-progress', () => ({readSyncProgress:vi.fn()}));
vi.mock('../../lib/http', async (original) => ({...await original<typeof import('../../lib/http')>(),protect:vi.fn(),limit:vi.fn()}));
import { POST } from '../../app/api/sync/route';
import { runSync } from '../../lib/sync';
import { readSyncProgress } from '../../lib/sync-progress';
import { limit, protect, HttpError } from '../../lib/http';
beforeEach(() => { vi.mocked(protect).mockReset(); vi.mocked(runSync).mockReset(); vi.mocked(readSyncProgress).mockReset(); });
it('attaches authoritative progress after the batch and permits the paced twelve requests per minute', async () => {
  vi.mocked(runSync).mockResolvedValue({ok:true,summary:'Read threads',gaps:[]});
  const progress = {accounts:[],totalProcessedThreads:4,totalPendingThreads:2,totalFailedThreads:0,hasMore:true,canContinue:true,madeProgress:true,scopeDays:90,blockedReasons:[]} as const;
  vi.mocked(readSyncProgress).mockImplementation(async () => { expect(runSync).toHaveBeenCalledTimes(1); return {...progress,accounts:[],blockedReasons:[]}; });
  const response = await POST(new Request('http://localhost/api/sync',{method:'POST'}));
  expect(await response.json()).toMatchObject({ok:true,progress});
  expect(limit).toHaveBeenCalledWith('sync',12);
});
it('never reads private progress or starts work when protection fails', async () => {
  vi.mocked(protect).mockImplementation(() => {throw new HttpError(401,'Sign in required');});
  const response = await POST(new Request('http://localhost/api/sync',{method:'POST'}));
  expect(response.status).toBe(401);
  expect(runSync).not.toHaveBeenCalled();
  expect(readSyncProgress).not.toHaveBeenCalled();
});
