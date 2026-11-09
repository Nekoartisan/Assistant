"use client";
import React, { useEffect, useRef, useState } from "react";
import Assistant from "./assistant";
import {
  ArrowUpRight,
  BookOpen,
  CalendarDays,
  LockKeyhole,
  RefreshCw,
  Settings2,
} from "lucide-react";
import {
  Agenda,
  formatDate,
  safeUrl,
  type Deadline,
  type News,
} from "./agenda";
interface DeskStatus {
  authenticated: boolean;
  configured: boolean;
  missing: string[];
  timezone: string;
  accounts: { email: string; lastSyncAt: string | null }[];
  lastSyncAt: string | null;
  gaps: string[];
  syncInProgress?: boolean;
  syncLeaseExpiresAt?: string | null;
}
interface Dashboard {
  items: Deadline[];
  news: News[];
  gaps: string[];
  lastSyncAt: string | null;
}
async function api<T>(
  url: string,
  body?: unknown,
  method = "POST",
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(
    url,
    body === undefined
      ? { cache: "no-store", signal }
      : {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal,
        },
  );
  const data = await response.json().catch(() => {
    throw new Error(
      "The server returned an unreadable response. Please try again.",
    );
  });
  if (!response.ok)
    throw Object.assign(
      new Error(
        typeof data.error === "string"
          ? data.error
          : "The request could not be completed. Please try again.",
      ),
      { status: response.status },
    );
  return data;
}
type View = "This week" | "Next weeks" | "Review" | "Research";
export default function Desk() {
  const [status, setStatus] = useState<DeskStatus | null>(null);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [error, setError] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [weeks, setWeeks] = useState(1);
  const [view, setView] = useState<View>("This week");
  const [kind, setKind] = useState("all");
  const [loading, setLoading] = useState(false);
  const [settings, setSettings] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [awaitingSync, setAwaitingSync] = useState(false);
  const [pollingStopped, setPollingStopped] = useState(false);
  const mounted = useRef(true);
  const session = useRef(0);
  const statusGeneration = useRef(0);
  const pollController = useRef<AbortController | null>(null);
  const currentWeeks = useRef(weeks);
  currentWeeks.current = weeks;
  const serverSyncing = !!status?.syncInProgress;
  function invalidateSession() {
    ++session.current;
    ++statusGeneration.current;
    ++generation.current;
    pollController.current?.abort();
    setAwaitingSync(false);
    setSyncing(false);
    setLoading(false);
  }
  function reportError(error: unknown) {
    if (!mounted.current) return;
    if ((error as { status?: number }).status === 401) {
      invalidateSession();
      setDashboard(null);
      setSettings(false);
      setSyncGaps([]);
      setSyncMessage("");
      setStatus((old) =>
        old
          ? {
              ...old,
              authenticated: false,
              accounts: [],
              syncInProgress: false,
              syncLeaseExpiresAt: null,
            }
          : old,
      );
    }
    setError(
      error instanceof Error
        ? error.message
        : "The request failed. Please try again.",
    );
  }
  async function logout() {
    invalidateSession();
    setBusy(true);
    setError("");
    try {
      await api("/api/auth/logout", {});
      setStatus((old) =>
        old
          ? {
              ...old,
              authenticated: false,
              accounts: [],
              syncInProgress: false,
              syncLeaseExpiresAt: null,
            }
          : old,
      );
      setDashboard(null);
      setSettings(false);
      setSyncMessage("");
      setSyncGaps([]);
      await loadStatus();
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(false);
    }
  }
  const [syncMessage, setSyncMessage] = useState("");
  const [syncGaps, setSyncGaps] = useState<string[]>([]);
  async function sync() {
    if (syncing || serverSyncing) return;
    const owner = session.current;
    setSyncing(true);
    setPollingStopped(false);
    setError("");
    setSyncMessage("");
    try {
      const result = await api<{
        ok: boolean;
        summary: string;
        gaps: string[];
      }>("/api/sync", {});
      if (!mounted.current || owner !== session.current) return;
      setSyncGaps(result.gaps || []);
      setAwaitingSync(!result.ok);
      setSyncMessage(result.summary);
      await loadStatus(undefined, !result.ok);
    } catch (e) {
      if (owner === session.current) {
        setPollingStopped(true);
        reportError(e);
      }
    } finally {
      if (mounted.current && owner === session.current) setSyncing(false);
    }
  }
  const generation = useRef(0);
  async function loadDashboard(
    window: number,
    signal?: AbortSignal,
    background = false,
  ) {
    const request = ++generation.current;
    if (!background) {
      setLoading(true);
      setDashboard(null);
    }
    try {
      const data = await api<Dashboard>(
        `/api/dashboard?weeks=${window}`,
        undefined,
        "GET",
        signal,
      );
      if (mounted.current && !signal?.aborted && request === generation.current)
        setDashboard(data);
    } finally {
      if (mounted.current && !signal?.aborted && request === generation.current)
        setLoading(false);
    }
  }
  async function retry() {
    setError("");
    try {
      await loadStatus();
      if (mounted.current) setPollingStopped(false);
    } catch (e) {
      reportError(e);
    }
  }
  async function loadStatus(signal?: AbortSignal, background = false) {
    const request = ++statusGeneration.current;
    const owner = session.current;
    const next = await api<DeskStatus>("/api/status", undefined, "GET", signal);
    const current = () =>
      mounted.current &&
      !signal?.aborted &&
      owner === session.current &&
      request === statusGeneration.current;
    if (!current()) return;
    try {
      if (next.authenticated)
        await loadDashboard(currentWeeks.current, signal, background);
    } finally {
      // Lease observations remain useful even if the agenda GET fails.
      if (current()) {
        setStatus(next);
        if (!next.authenticated) {
          setDashboard(null);
          setAwaitingSync(false);
        } else if (
          !next.syncInProgress &&
          (background || awaitingSync || next.syncLeaseExpiresAt)
        ) {
          setAwaitingSync(false);
          setSyncMessage(
            next.lastSyncAt
              ? "Sync is no longer active. Review source coverage and retry if needed."
              : "No completed sync was recorded. Please retry Sync sources.",
          );
        }
      }
    }
    if (!current()) return;
    return next;
  }
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    loadStatus(controller.signal).catch((e) => {
      if (!controller.signal.aborted) reportError(e);
    });
    return () => {
      mounted.current = false;
      ++session.current;
      ++generation.current;
      ++statusGeneration.current;
      controller.abort();
      pollController.current?.abort();
    };
  }, []); // Initial session check; no inbox request before authentication.
  useEffect(() => {
    if (
      !status?.authenticated ||
      !status.configured ||
      (!serverSyncing && !awaitingSync) ||
      pollingStopped ||
      syncing
    )
      return;
    const controller = new AbortController();
    pollController.current = controller;
    let timer: ReturnType<typeof setTimeout>;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    async function refresh() {
      if (controller.signal.aborted) return;
      timeout = setTimeout(() => {
        if (controller.signal.aborted) return;
        controller.abort();
        setPollingStopped(true);
        setError(
          "Automatic refresh timed out. Refresh status to check the sync again.",
        );
      }, 10000);
      try {
        const next = await loadStatus(controller.signal, true);
        if (controller.signal.aborted || !next?.authenticated) return;
        if (next.syncInProgress) {
          if (++attempts >= 60) {
            setPollingStopped(true);
            setError(
              "Automatic refresh paused. Refresh status to check the sync again.",
            );
          } else timer = setTimeout(refresh, 3000);
        }
      } catch (e) {
        if (!controller.signal.aborted) {
          setPollingStopped(true);
          reportError(e);
        }
      } finally {
        clearTimeout(timeout);
      }
    }
    timer = setTimeout(refresh, 3000);
    return () => {
      clearTimeout(timer);
      clearTimeout(timeout);
      controller.abort();
      if (pollController.current === controller) pollController.current = null;
    };
  }, [
    status?.authenticated,
    status?.configured,
    serverSyncing,
    awaitingSync,
    pollingStopped,
    syncing,
    weeks,
  ]);
  useEffect(() => {
    if (!serverSyncing || !status?.syncLeaseExpiresAt) return;
    const remaining = Date.parse(status.syncLeaseExpiresAt) - Date.now();
    if (!Number.isFinite(remaining)) return;
    const timer = setTimeout(
      () => {
        setStatus((old) => (old ? { ...old, syncInProgress: false } : old));
        setAwaitingSync(false);
        setSyncMessage(
          "The sync lease expired. Completion is unconfirmed; please refresh status or retry Sync sources.",
        );
      },
      Math.max(0, remaining),
    );
    return () => clearTimeout(timer);
  }, [serverSyncing, status?.syncLeaseExpiresAt]);
  async function patchItem(id: string, patch: Partial<Deadline>) {
    setPending(id);
    setError("");
    try {
      await api("/api/items/" + encodeURIComponent(id), patch, "PATCH");
      setDashboard((old) =>
        old
          ? {
              ...old,
              items: old.items.map((i) =>
                i.id === id ? { ...i, ...patch } : i,
              ),
            }
          : old,
      );
    } catch (e) {
      reportError(e);
    } finally {
      setPending(null);
    }
  }
  async function login(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/api/auth/login", { password });
      setPassword("");
      await loadStatus();
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(false);
    }
  }
  function changeWindow(value: number) {
    setWeeks(value);
    setError("");
    loadDashboard(value).catch(reportError);
  }
  function changeView(next: View) {
    setView(next);
    if (next === "This week" && weeks !== 1) changeWindow(1);
    if (next === "Next weeks" && weeks === 1) changeWindow(2);
  }
  const items = (dashboard?.items || [])
    .filter((i) => !["done", "dismissed"].includes(i.status))
    .filter(
      (i) =>
        view !== "Review" ||
        i.status === "needs_review" ||
        (!i.dateOnly && !i.dueAt),
    )
    .filter(
      (i) =>
        kind === "all" ||
        (kind === "deadlines"
          ? i.kind === "deadline" || i.kind === "commitment"
          : i.kind === kind),
    )
    .sort((a, b) =>
      (a.dateOnly || a.dueAt || "9999").localeCompare(
        b.dateOnly || b.dueAt || "9999",
      ),
    );
  const gaps = Array.from(
    new Set([...(status?.gaps || []), ...(dashboard?.gaps || []), ...syncGaps]),
  );
  return (
    <div className="desk-shell">
      <a href="#main" className="skip-link">
        Skip to desk
      </a>
      <header className="masthead">
        <a className="brand" href="/" aria-label="Bao home">
          <span className="brand-mark">b.</span>
          <span>
            Bao<span className="brand-sub">PERSONAL DESK</span>
          </span>
        </a>
        <div className="header-note">
          <span className="status-dot" />
          Private by design
          <span className="header-timezone">Bangkok · UTC+07</span>
          {status?.authenticated && (
            <button
              className="secondary"
              aria-expanded={settings}
              onClick={() => setSettings(!settings)}
            >
              <Settings2 size={15} />
              Settings
            </button>
          )}
        </div>
      </header>
      <main id="main">
        {error && (
          <div className="alert" role="alert">
            <strong>Something needs attention.</strong>
            <p>{error}</p>
            {(!status || status.authenticated) && (
              <button className="secondary" onClick={retry}>
                {status ? "Refresh status" : "Retry connection"}
              </button>
            )}
          </div>
        )}
        {!status ? (
          <section className="gate">
            <p className="eyebrow">PERSONAL DESK</p>
            <h1>
              {error
                ? "Your desk is temporarily unavailable."
                : "Opening your private desk…"}
            </h1>
            {!error && (
              <p role="status">
                Checking your session and server configuration.
              </p>
            )}
          </section>
        ) : !status.configured ? (
          <section className="gate">
            <div className="gate-icon">
              <Settings2 size={24} />
            </div>
            <p className="eyebrow">SETUP REQUIRED</p>
            <h1>
              A private desk, <br />
              ready when you are.
            </h1>
            <p className="gate-description">
              Your deadlines, commitments, and research. One quiet place to keep
              track of what matters.
            </p>
            <div className="setup-box">
              <h2>Connect the foundations</h2>
              <p>
                No inbox data has been loaded. Configure the server to get
                started.
              </p>
              {status.missing.length > 0 ? (
                <ul className="config-list">
                  {status.missing.map((name) => (
                    <li key={name}>
                      <code>{name}</code>
                      <span>Not configured</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>
                  Server configuration is incomplete. Review the deployment
                  setup.
                </p>
              )}
              {status.gaps.map((gap) => (
                <p className="chat-gap" key={gap}>
                  {gap}
                </p>
              ))}
              <p className="muted">
                Set these environment variables in your deployment. Never paste
                secret values here.
              </p>
            </div>
            <p className="privacy-note">
              <LockKeyhole size={14} />
              Your inbox is never public. No sample data is shown.
            </p>
          </section>
        ) : !status.authenticated ? (
          <section className="gate login-gate">
            <div className="gate-icon">
              <LockKeyhole size={24} />
            </div>
            <p className="eyebrow">FOR YOUR EYES ONLY</p>
            <h1>
              Welcome back
              <br />
              to your desk.
            </h1>
            <p className="gate-description">
              Your mail, calendar, and research stay private.
            </p>
            <form className="login-form" onSubmit={login}>
              <label htmlFor="password">Owner password</label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <button className="primary" disabled={busy}>
                {busy ? "Unlocking…" : "Unlock desk"}
                <ArrowUpRight size={16} />
              </button>
            </form>
            <p className="privacy-note">
              <LockKeyhole size={14} />
              Single-owner access · Secure session
            </p>
          </section>
        ) : (
          <>
            {settings && (
              <section className="settings-panel">
                <div className="settings-title">
                  <div>
                    <p className="eyebrow">YOUR SOURCES</p>
                    <h2>Connected accounts</h2>
                  </div>
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={logout}
                  >
                    Lock desk
                  </button>
                </div>
                <p className="muted">
                  Google Mail and Calendar are read-only. Your desk never sends
                  mail or edits your calendar.
                </p>
                {status.accounts.length ? (
                  <ul className="account-list">
                    {status.accounts.map((account) => (
                      <li key={account.email}>
                        <strong>{account.email}</strong>
                        <span>
                          {account.lastSyncAt
                            ? `Last sync ${formatDate(account.lastSyncAt)}`
                            : "Not yet synced"}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>No Google accounts connected yet.</p>
                )}
                <a className="button-link" href="/api/google/connect">
                  Connect Google account ↗
                </a>
                <p className="muted">
                  Only owner accounts allowed by the server can be connected.
                  Credentials are never displayed here.
                </p>
              </section>
            )}
            <div className="desk-heading">
              <div>
                <p className="eyebrow">YOUR PERSONAL DESK</p>
                <h1>Your agenda</h1>
                <p className="muted">
                  A clear view of what’s ahead. Grounded in your sources.
                </p>
              </div>
              <div className="desk-tools">
                <label className="window-label">
                  Time window
                  <select
                    aria-label="Time window"
                    value={weeks}
                    onChange={(e) => changeWindow(Number(e.target.value))}
                  >
                    {[1, 2, 4, 8].map((w) => (
                      <option key={w} value={w}>
                        {w} {w === 1 ? "week" : "weeks"}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  className="primary"
                  disabled={syncing || serverSyncing || awaitingSync || loading}
                  onClick={sync}
                >
                  <RefreshCw
                    size={15}
                    className={
                      syncing || serverSyncing || awaitingSync ? "spin" : ""
                    }
                  />
                  {syncing || serverSyncing || awaitingSync
                    ? "Syncing…"
                    : "Sync sources"}
                </button>
              </div>
            </div>
            <div className="sync-status">
              <span>
                Last sync:{" "}
                {dashboard?.lastSyncAt
                  ? formatDate(dashboard.lastSyncAt)
                  : "Not yet synced"}
              </span>
              {serverSyncing || awaitingSync ? (
                <p role="status">
                  {serverSyncing
                    ? "Sync in progress."
                    : "Waiting for sync status."}{" "}
                  {pollingStopped
                    ? "Automatic refresh is paused; refresh status to check progress."
                    : "Checking for updated sources every few seconds."}{" "}
                  Completion has not been confirmed.
                </p>
              ) : (
                syncMessage && <p role="status">{syncMessage}</p>
              )}
            </div>
            <div className="workspace">
              <section className="monitor" aria-label="Agenda monitor">
                <nav className="view-tabs" aria-label="Desk view">
                  {(
                    ["This week", "Next weeks", "Review", "Research"] as View[]
                  ).map((tab) => (
                    <button
                      key={tab}
                      aria-pressed={view === tab}
                      onClick={() => changeView(tab)}
                    >
                      {tab}
                    </button>
                  ))}
                </nav>
                <div className="section-toolbar">
                  <span className="section-label">
                    {view === "Research" ? (
                      <BookOpen size={16} />
                    ) : (
                      <CalendarDays size={16} />
                    )}{" "}
                    {view === "Research"
                      ? "Reading room"
                      : view === "Review"
                        ? "Needs your attention"
                        : "On the horizon"}
                  </span>
                  {view !== "Research" && (
                    <select
                      aria-label="Item type"
                      value={kind}
                      onChange={(e) => setKind(e.target.value)}
                    >
                      <option value="all">All items</option>
                      <option value="exam">Exams</option>
                      <option value="deadlines">Deadlines & commitments</option>
                      <option value="event">Events</option>
                    </select>
                  )}
                </div>
                {gaps.length > 0 && (
                  <details className="coverage" open>
                    <summary>Source coverage is incomplete</summary>
                    {gaps.map((gap) => (
                      <p key={gap}>{gap}</p>
                    ))}
                  </details>
                )}
                {loading ? (
                  <div className="loading-state" role="status">
                    <RefreshCw size={18} className="spin" />
                    Loading your sources…
                  </div>
                ) : !dashboard ? (
                  <div className="empty-state">
                    <h3>Agenda unavailable</h3>
                    <p>
                      Could not load your sources. Reload the page to retry.
                    </p>
                  </div>
                ) : view === "Research" ? (
                  <div className="research-list">
                    {dashboard.news.length ? (
                      dashboard.news.map((news) => (
                        <article className="research-item" key={news.id}>
                          <p className="eyebrow">
                            {news.kind} · {news.source}
                          </p>
                          <h3>
                            {safeUrl(news.url) ? (
                              <a
                                href={safeUrl(news.url)}
                                target="_blank"
                                rel="noreferrer"
                              >
                                {news.title} ↗
                              </a>
                            ) : (
                              news.title
                            )}
                          </h3>
                          <p>{news.summary}</p>
                          <p className="muted">
                            Published {formatDate(news.publishedAt)}
                            {news.fetchedAt &&
                              ` · Retrieved ${formatDate(news.fetchedAt)}`}
                          </p>
                        </article>
                      ))
                    ) : (
                      <div className="empty-state">
                        <BookOpen size={28} />
                        <h3>No research in this window.</h3>
                        <p className="muted">
                          Try a wider range or sync sources. Source failures are
                          listed separately above.
                        </p>
                      </div>
                    )}
                  </div>
                ) : (
                  <Agenda items={items} onPatch={patchItem} pending={pending} />
                )}
                <footer className="monitor-footer">
                  <LockKeyhole size={13} />
                  <span>
                    Source-backed, not assumed. Dates without a time stay
                    date-only.
                  </span>
                </footer>
              </section>
              <Assistant weeks={weeks} />
            </div>
          </>
        )}
      </main>
      <footer className="page-footer">
        <span>Bao / A little more clarity.</span>
        <span>Private workspace · Asia/Bangkok</span>
      </footer>
    </div>
  );
}
