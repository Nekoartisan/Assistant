import { endpoint, json, protect, limit, weeks } from "../../../lib/http";
import { dashboard } from "../../../lib/db";
export const dynamic = "force-dynamic";
export const GET = endpoint(async (r) => {
  protect(r);
  await limit("dashboard", 120);
  return json(
    await dashboard(weeks(new URL(r.url).searchParams.get("weeks") ?? 1)),
  );
});
