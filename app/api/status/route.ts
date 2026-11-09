import { endpoint, json, missingConfiguration } from "../../../lib/http";
import { authenticated } from "../../../lib/security";
import { db, getState } from "../../../lib/db";
import { normalizeCoverageGaps } from "../../../lib/coverage";
import { readSyncProgress, type SyncProgress } from "../../../lib/sync-progress";
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
  const sync = {
    syncInProgress: false,
    syncLeaseExpiresAt: null as string | null,
    progress: undefined as SyncProgress | undefined,
  };
  if (!process.env.DATABASE_URL) return json({ ...base, ...sync });
  try {
    const rows =
      await db()`select email,last_sync_at,gap from accounts order by email`;
    base.accounts = rows.map((a) => ({
      email: a.email,
      lastSyncAt: a.last_sync_at?.toISOString() || null,
    }));
    const s = await getState<{ gaps: string[]; lastSyncAt: string }>("sync");
    base.lastSyncAt = s?.lastSyncAt || null;
    base.gaps = normalizeCoverageGaps(s?.gaps || []);
    const leases =
      await db()`select expires_at, expires_at > now() as active from leases where name='sync'`;
    sync.syncInProgress = leases[0]?.active === true;
    sync.syncLeaseExpiresAt = leases[0]?.expires_at?.toISOString() || null;
    sync.progress = await readSyncProgress();
  } catch {
    base.configured = false;
    base.gaps.push("Database unavailable or migration not applied.");
  }
  return json({ ...base, ...sync });
});
