import { DateTime } from "luxon";
import { createHash } from "node:crypto";
import {
  dashboard,
  claimDelivery,
  finishDelivery,
  claimLease,
  releaseLease,
} from "./db";
import { runSync } from "./sync";
import { allowedEmail } from "./google";
import type { Deadline } from "./types";
export function sanitizeMessage(s: string) {
  return s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}
export function selectReminders(items: Deadline[], nowISO: string) {
  const now = DateTime.fromISO(nowISO).setZone("Asia/Bangkok");
  return items.flatMap((i) => {
    if (
      i.status !== "open" ||
      i.confidence < 0.8 ||
      i.notes === "Calendar all-day end date is exclusive."
    )
      return [];
    if (i.dateOnly) {
      if (i.dateOnly !== now.toISODate()) return [];
      return [
        {
          key: `${i.id}:date:${i.dateOnly}`,
          text: `${i.title.slice(0, 150)} — ${i.dateOnly} (date only; no time specified)`,
          url: i.sourceUrl,
        },
      ];
    }
    if (!i.dueAt) return [];
    const due = DateTime.fromISO(i.dueAt).setZone("Asia/Bangkok");
    const hours = due.diff(now, "hours").hours;
    if (hours < 0 || hours > 24) return [];
    const offset = hours <= 1 ? "1h" : hours <= 3 ? "3h" : "24h";
    return [
      {
        key: `${i.id}:${i.dueAt}:${offset}`,
        text: `${i.title.slice(0, 150)} — ${due.toFormat("dd LLL yyyy HH:mm")} Bangkok (${offset} reminder window)`,
        url: i.sourceUrl,
      },
    ];
  });
}
async function sendTelegram(text: string) {
  const r = await fetch(
    `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: process.env.TELEGRAM_CHAT_ID,
        text: sanitizeMessage(text),
        link_preview_options: { is_disabled: true },
      }),
      signal: AbortSignal.timeout(7000),
    },
  );
  if (!r.ok) throw new Error("Telegram delivery not acknowledged");
  const result = await r.json();
  if (
    result.ok !== true ||
    typeof result.result?.message_id !== "number" ||
    result.result.text !== sanitizeMessage(text)
  )
    throw new Error("Telegram delivery not acknowledged");
}
async function sendEmail(text: string, idempotency: string) {
  const to = (process.env.REMINDER_EMAIL_TO || "").trim();
  if (!allowedEmail(to)) throw new Error("Reminder recipient not allowlisted");
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
      "Idempotency-Key": createHash("sha256").update(idempotency).digest("hex"),
    },
    body: JSON.stringify({
      from: process.env.RESEND_FROM,
      to: [to],
      subject: "Bao — private desk reminder",
      text: sanitizeMessage(text),
    }),
    signal: AbortSignal.timeout(7000),
  });
  if (!r.ok) throw new Error("Email delivery not acknowledged");
  const result = await r.json();
  if (typeof result.id !== "string")
    throw new Error("Email provider id missing");
  const check = await fetch(
    `https://api.resend.com/emails/${encodeURIComponent(result.id)}`,
    {
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
      signal: AbortSignal.timeout(5000),
    },
  );
  if (!check.ok || (await check.json()).id !== result.id)
    throw new Error("Email acknowledgement could not be verified");
}
export async function runReminders(task: "morning" | "evening" | "poll") {
  const lease = await claimLease("reminders", 150);
  if (!lease)
    return { ok: false, summary: "Reminder job already running.", gaps: [] };
  try {
    const sync = await runSync();
    const d = await dashboard(2);
    const now = DateTime.now().setZone("Asia/Bangkok");
    const selected = selectReminders(d.items, now.toISO()!);
    const channels: string[] = [];
    if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID)
      channels.push("telegram");
    if (
      process.env.RESEND_API_KEY &&
      process.env.RESEND_FROM &&
      process.env.REMINDER_EMAIL_TO
    )
      channels.push("email");
    const gaps = [...d.gaps, ...sync.gaps];
    if (!channels.length)
      return {
        ok: false,
        summary: "No reminder channel configured; nothing sent.",
        gaps: [...gaps, "Configure Telegram or optional Resend credentials."],
      };
    let acknowledged = 0;
    for (const channel of channels) {
      const claims: { key: string; text: string }[] = [];
      if (task === "poll") {
        for (const r of selected) {
          if (claims.length >= 8) break;
          if (await claimDelivery(r.key, channel, r.text))
            claims.push({ key: r.key, text: r.text + "\n" + r.url });
        }
      } else {
        const key = `digest:${now.toISODate()}:${task}`;
        const open = d.items.filter(
          (i) => i.status === "open" && i.confidence >= 0.8,
        );
        const lines = open
          .slice(0, 15)
          .map(
            (i) =>
              `${i.title.slice(0, 100)} — ${i.dateOnly ? i.dateOnly + " (date only)" : i.dueAt ? DateTime.fromISO(i.dueAt).setZone("Asia/Bangkok").toFormat("dd LLL HH:mm") + " Bangkok" : "date unconfirmed"}`,
          );
        const text = `Bao — ${task} desk · ${now.toISODate()} Bangkok\n${lines.length ? lines.join("\n") : "No confirmed open dates in stored agenda. This is not proof of complete inbox coverage."}${open.length > 15 ? `\n+${open.length - 15} more in Bao.` : ""}\n${gaps.length ? "Coverage: " + gaps.slice(0, 3).join(" ").slice(0, 500) : "Email coverage: bounded initial 90-day window; attachments may require review."}\n${process.env.APP_URL || ""}`;
        if (await claimDelivery(key, channel, text)) claims.push({ key, text });
      }
      if (!claims.length) continue;
      const text = sanitizeMessage(claims.map((c) => c.text).join("\n\n"));
      try {
        if (channel === "telegram") await sendTelegram(text);
        else await sendEmail(text, claims.map((c) => c.key).join("|"));
        for (const c of claims) await finishDelivery(c.key, channel, "sent");
        acknowledged++;
      } catch {
        for (const c of claims) await finishDelivery(c.key, channel, "unknown");
        gaps.push(
          `${channel}: delivery failed or uncertain; reserved keys are not retried automatically to prevent duplicate messages. Inspect deliveries before manual recovery.`,
        );
      }
    }
    return {
      ok: !gaps.some((g) => g.includes("delivery failed")),
      summary: `${acknowledged} provider acknowledgements. Already-reserved reminders were skipped.`,
      gaps: [...new Set(gaps)],
    };
  } finally {
    await releaseLease("reminders", lease);
  }
}
