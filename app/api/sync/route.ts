import { endpoint, json, protect, limit } from "../../../lib/http";
import { runSync } from "../../../lib/sync";
import { readSyncProgress } from "../../../lib/sync-progress";
export const maxDuration = 60;
export const POST = endpoint(async (r) => {
  protect(r, true);
  await limit("sync", 12);
  const result = await runSync();
  return json({ ...result, progress: await readSyncProgress() });
});
