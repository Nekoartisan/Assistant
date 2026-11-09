import { endpoint, json, missingConfiguration } from "../../../lib/http";
import { authenticated } from "../../../lib/security";
import { db, getState } from "../../../lib/db";
export const dynamic = "force-dynamic";
export const GET = endpoint(async (r) => {
  const auth = authenticated(r),
    missing = missingConfiguration();
  const base = {
    authenticated: auth,
    configured: !missing.length,
    missing: auth ? missing : missing.length ? ["Server setup incomplete"] : [],
    timezone: "Asia/Bangkok",
    accounts: [] as { email: string; lastSyncAt: string | null }[],
    lastSyncAt: null as string | null,
    gaps: [] as string[],
  };
  if (!auth) return json(base);
  if (!process.env.DATABASE_URL) return json(base);
  try {
    const rows =
      await db()`select email,last_sync_at,gap from accounts order by email`;
    base.accounts = rows.map((a) => ({
      email: a.email,
      lastSyncAt: a.last_sync_at?.toISOString() || null,
    }));
    const s = await getState<{ gaps: string[]; lastSyncAt: string }>("sync");
    base.lastSyncAt = s?.lastSyncAt || null;
    base.gaps = s?.gaps || [];
  } catch {
    base.configured = false;
    base.gaps.push("Database unavailable or migration not applied.");
  }
  return json(base);
});
