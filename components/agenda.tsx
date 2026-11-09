"use client";
import React from "react";
export interface Deadline {
  id: string;
  title: string;
  kind: "deadline" | "exam" | "event" | "commitment";
  dueAt: string | null;
  dateOnly: string | null;
  timezone: string | null;
  originalDateText: string;
  evidence: string;
  sourceUrl: string;
  sourceAccount: string;
  status: "open" | "done" | "dismissed" | "needs_review";
  confidence: number;
  updatedAt: string;
  notes?: string;
  location?: string;
}
export interface News {
  id: string;
  title: string;
  summary: string;
  url: string;
  publishedAt: string;
  source: string;
  kind: "paper" | "news";
  fetchedAt?: string;
}
export function safeUrl(value: string) {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? value : undefined;
  } catch {
    return undefined;
  }
}
export function formatDate(
  value: string | null,
  dateOnly = false,
  timezone = "Asia/Bangkok",
) {
  if (!value) return "Date needs review";
  const date = new Date(dateOnly ? `${value}T12:00:00Z` : value);
  if (Number.isNaN(date.getTime())) return "Date needs review";
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    ...(dateOnly
      ? { timeZone: "UTC" }
      : { hour: "2-digit", minute: "2-digit", timeZone: timezone }),
  }).format(date);
}
function DateReview({
  item,
  onPatch,
  pending,
}: {
  item: Deadline;
  onPatch: (id: string, patch: Partial<Deadline>) => Promise<void>;
  pending: boolean;
}) {
  const [date, setDate] = React.useState(
    item.dateOnly || item.dueAt?.slice(0, 10) || "",
  );
  const [time, setTime] = React.useState("");
  return (
    <details className="date-review">
      <summary>Review date</summary>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          await onPatch(
            item.id,
            time
              ? {
                  dueAt: new Date(`${date}T${time}`).toISOString(),
                  dateOnly: null,
                  status: "open",
                }
              : { dateOnly: date, dueAt: null, status: "open" },
          );
        }}
      >
        <p className="muted">
          Confirm against the original source. Saving changes your desk only,
          not the original calendar.
        </p>
        <label htmlFor={`date-${item.id}`}>Confirmed date</label>
        <input
          id={`date-${item.id}`}
          type="date"
          required
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
        <label htmlFor={`time-${item.id}`}>
          Time (optional, your browser timezone)
        </label>
        <input
          id={`time-${item.id}`}
          type="time"
          value={time}
          onChange={(e) => setTime(e.target.value)}
        />
        <p className="muted">
          Leave time blank to keep a date-only item. No midnight deadline is
          invented.
        </p>
        <button disabled={pending}>Save reviewed date</button>
      </form>
    </details>
  );
}
export function Agenda({
  items,
  onPatch,
  pending,
}: {
  items: Deadline[];
  onPatch: (id: string, patch: Partial<Deadline>) => Promise<void>;
  pending: string | null;
}) {
  if (!items.length)
    return (
      <div className="empty-state">
        <span className="empty-mark" aria-hidden="true">
          —
        </span>
        <h3>A little breathing room.</h3>
        <p>Nothing scheduled in this window.</p>
        <p className="muted">
          Sync your sources or choose a wider date range. This only reflects the
          sources connected to your desk.
        </p>
      </div>
    );
  return (
    <div className="agenda-list">
      {items.map((item) => (
        <article className="agenda-item" key={item.id}>
          <div className="item-date">
            <span>
              {formatDate(
                item.dateOnly || item.dueAt,
                !!item.dateOnly,
                item.timezone || "Asia/Bangkok",
              )}
            </span>
            <small>
              {item.dateOnly
                ? "Date only · no time specified"
                : item.dueAt
                  ? item.timezone || "Timezone unconfirmed"
                  : "Unconfirmed"}
            </small>
          </div>
          <div className="item-content">
            <div className="item-meta">
              <span className={`badge ${item.kind}`}>{item.kind}</span>
              {item.status === "needs_review" && (
                <span className="badge review">Needs review</span>
              )}
            </div>
            <h3>{item.title}</h3>
            {item.location && <p>{item.location}</p>}
            <details className="evidence">
              <summary>Source &amp; evidence</summary>
              <blockquote>
                {item.evidence || "No quoted evidence available."}
              </blockquote>
              <p className="muted">
                Original date: {item.originalDateText || "Not supplied"}
              </p>
              <p className="muted">{item.sourceAccount}</p>
              {safeUrl(item.sourceUrl) && (
                <a
                  href={safeUrl(item.sourceUrl)}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open original ↗
                </a>
              )}
            </details>
            <DateReview
              item={item}
              onPatch={onPatch}
              pending={pending === item.id}
            />
            <div className="item-actions">
              <button
                className="text-button"
                disabled={pending === item.id}
                onClick={() => onPatch(item.id, { status: "done" })}
              >
                Mark done
              </button>
              <button
                className="text-button muted"
                disabled={pending === item.id}
                onClick={() => onPatch(item.id, { status: "dismissed" })}
              >
                Dismiss
              </button>
            </div>
          </div>
        </article>
      ))}
    </div>
  );
}
