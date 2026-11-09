import { endpoint, json, protect, limit } from "../../../lib/http";
import { runSync } from "../../../lib/sync";
export const maxDuration = 60;
export const POST = endpoint(async (r) => {
  protect(r, true);
  await limit("sync", 6);
  return json(await runSync());
});
