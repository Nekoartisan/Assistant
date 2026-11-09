# Bao Assistant

Private, single-owner cloud desk for email commitments, exams, calendar events, research, and grounded weekly planning. Next.js App Router / React / TypeScript; durable PostgreSQL. It contains **no demo inbox, fabricated deadlines, or seeded news**.

## Deploy on Vercel

1. Use Node.js 22. Install dependencies (`npm install`), copy `.env.example` to `.env.local` for local development, and configure the equivalent **server-only** environment variables in Vercel Production. Do not commit `.env.local` or use `NEXT_PUBLIC_` for credentials.
2. Provision PostgreSQL (for example, Neon). Set `DATABASE_URL` to the provider's connection string. Remote connections use TLS; only localhost connections disable TLS. Use a dedicated least-privilege database user and database backups.
3. Set `APP_URL` to the exact production HTTPS origin, with **no trailing slash**, e.g. `https://your-project.vercel.app`. Local development can use `http://localhost:3000`.
4. Set a unique `OWNER_PASSWORD` of at least 16 characters, independent `SESSION_SECRET` and `CRON_SECRET` of at least 32 characters, and a base64-encoded 32-byte `TOKEN_ENCRYPTION_KEY`. Generate each independently using a password manager or `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`. Keep the token encryption key backed up; changing it makes stored refresh tokens unreadable until accounts reconnect. Rotating the session secret invalidates all sessions.
5. `OWNER_EMAILS` in `.env.example` is prefilled with your two requested accounts: `baohuynhneko@gmail.com` and `baohkg2410154@usth.edu.vn`. Keep these exact comma-separated addresses, or explicitly replace them with your own one or two owner addresses—no wildcards. An empty or oversized allowlist denies all Google connections.
6. Create a Google Cloud OAuth **Web application** client, enable Gmail API and Google Calendar API, configure the consent screen, and add both owner addresses as test users when in Testing. Add the exact redirect URI `https://your-project.vercel.app/api/google/callback` (and localhost callback separately if needed). Set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.
7. Set an actual provider API key in `OPENAI_API_KEY`, a supported chat-completions model in `OPENAI_MODEL`, and optionally `OPENAI_BASE_URL` (default `https://api.openai.com/v1`). The provider must support `/chat/completions` JSON-object responses. A paid ChatGPT subscription or local Hermes/Google OAuth login is **not** a model API credential. Nothing imports your local Hermes secrets.
8. **Run the explicit migration against your intended database before use:**
   ```sh
   node --env-file=.env.local scripts/migrate.mjs
   # Or with DATABASE_URL already exported / in your deployment pipeline:
   node scripts/migrate.mjs
   ```
   Migrations use a transaction, advisory lock, and recorded checksums. Rerunning is safe; do not edit applied SQL migrations. They are not silently run during requests or builds.
9. Deploy the repository to Vercel. Sign in with the owner password, open Settings, connect each allowlisted Google account separately, then use Sync to run/resume automatic bounded batches until the mail/calendar cursors are caught up. Review failed/unsupported sources separately; repeated Sync does not make unsupported attachments readable. Google and database credentials are configured in Vercel, not in a running laptop process.
10. Optionally configure Telegram and/or Resend (below). Confirm the production deployment has the cron schedules from `vercel.json` and `CRON_SECRET` configured. Preview deployments are not a substitute for production scheduling.

**After deployment, the PC can be off.** Vercel executes requests/cron jobs and cloud PostgreSQL stores state. This still depends on valid cloud credentials, provider availability, the Vercel plan, and deployed cron configuration.

## Google access and privacy

Scopes are only `openid`, `email`, `gmail.readonly`, and `calendar.readonly`. There is no Gmail send/modify capability and no calendar write capability. The callback verifies the Google userinfo email and email verification flag against the exact server allowlist. It uses signed expiring browser-bound state plus PKCE, consumes state once in PostgreSQL, and encrypts refresh tokens with AES-256-GCM before persistence. Access tokens are short-lived and kept in request memory.

`gmail.readonly` is a **restricted Google scope**. Follow Google's consent-screen and verification requirements before wider distribution; this app is intended for a private owner. External OAuth apps in Testing commonly receive refresh tokens expiring after seven days when requesting these scopes; reconnect when access expires. Workspace/admin policies can impose additional restrictions. The app surfaces authorization gaps rather than claiming successful coverage.

Email bodies, extracted evidence, agenda data and account addresses are stored in your database. Full supported mail bodies and previous extracted facts are sent to the configured model provider for extraction; bounded agenda/research context is sent for chat. Review that provider's retention and data-processing policies. Do not configure an untrusted model endpoint. Refresh tokens and API keys are never sent to that endpoint. You control retention/backup/deletion at the database level; no automatic archival purge is implemented.

## What Sync actually covers

- Initial Gmail backfill searches the **last 90 days** (including Spam/Trash), not your entire lifetime inbox. It reads complete threads, Subjects, per-message chronology and MIME bodies with `format=full`, never snippets. Each bounded server cycle attempts up to **eight threads per account**, with two account turns and up to four concurrent mail tasks globally; actual throughput depends on provider latency and thread size. Pressing **Sync sources** starts sequential browser-driven cycles, capped at **20 cycles / 10 minutes** and spaced at least five seconds apart, with Pause/Resume controls. Keep the tab open for this automatic initial scan; closing it stops new browser cycles, though the current server cycle may finish and scheduled cloud jobs remain separate. Explicitly tracked failures retry with backoff rather than blocking unrelated mail or being silently discarded.
- Gmail history IDs capture incremental changes after backfill. Queue state is saved before processing and after each successful thread, so retries do not skip an unprocessed thread. Expired Gmail history restarts the 90-day backfill and explicitly warns that older stored facts may be stale.
- Plain text and HTML body MIME parts are supported; large body MIME attachments are fetched through Gmail's attachment endpoint. PDF/image/office/other attachments are **not OCR'd or parsed**. They produce persistent attachment-not-read coverage gaps; attachment-only timetables need manual review. Oversized full threads are not silently truncated or marked successfully extracted; the cursor pauses with a gap.
- Calendar reads every returned accessible calendar (up to 250) over a rolling **90-day past / 365-day future** window. Recurring instances are expanded, deleted events are included, and complete valid pages are persisted atomically in batches with durable cursors. A completed scan is reused for 15 minutes rather than restarted on each mail backfill cycle; subsequent scans refresh the rolling window. It is not an all-history calendar export. An incomplete scan is disclosed. All-day end dates are explicitly labeled exclusive.
- Structured extraction uses Zod and requires exact evidence and original date text from the full source body. Independent registration, start/end, and submission dates are retained. Missing years/timezones, low confidence, conflicting dates, and uncertain locale formats require review rather than fabricated midnight deadlines. Validation independently demotes missing-year/timezone output; language interpretation is still model-assisted and requires human review for important obligations.
- Stable per-source semantic keys reconcile updates; vanished facts and cancellations are dismissed. Pending changed-source extraction suppresses old open reminders until extraction/review completes. Explicit review edits are retained; chat cannot mutate items or external services.
- arXiv API (cs.AI, cs.LG, cs.CL, cs.CV, stat.ML), with arXiv announcement RSS as an explicit fallback, and official OpenAI/Google DeepMind RSS entries are persisted. Fallback records label their date as an **announcement**, not an original submission date. Publication and fetch timestamps are separate. Queries use stored publication windows (up to eight weeks); feeds are bounded, not a complete historical news archive. Initial sync does not backfill every article from prior weeks. Feed errors differ from a genuinely empty stored week. Research coverage is limited to the fetched feed entries, not the whole AI literature. Thank you to arXiv for use of its open access interoperability.
- `/api/dashboard?weeks=N` includes open/review agenda through the end of the upcoming N-week window, plus overdue and undated review items. News covers the current week and previous N−1 weeks, ending now. Chat contexts are bounded and disclose truncation.

## Reminders and timing

The shipped `vercel.json` uses two daily UTC cron schedules:

| Cron         | Bangkok target         | Task                          |
| ------------ | ---------------------- | ----------------------------- |
| `0 23 * * *` | 06:00 next Bangkok day | Morning digest + bounded sync |
| `0 14 * * *` | 21:00 Bangkok          | Evening digest + bounded sync |

These are legacy Vercel Cron Jobs. **Hobby supports each job at most once per day and execution can occur anywhere within the target hour** (06:00–06:59 / 21:00–21:59), not exact minute delivery. Do not expect 1-hour or 3-hour warning reliability on two daily jobs. Current Vercel Schedules is a separate newer feature with different limits; this repository deliberately uses the supported `crons` configuration.

For frequent checks, merge `vercel.pro.example.json` into the deployed config on a compatible plan, or use a trusted external scheduler calling `GET /api/cron?task=poll`. Authenticate using the `Authorization` header with the `Bearer` scheme and the value of your `CRON_SECRET`. The example polls every 15 minutes. Poll performs bounded sync and checks exact-time **24h / 3h / 1h** reminder windows; date-only reminders fire only on the Bangkok calendar date, never by inventing a midnight deadline. Poll reminders are bounded to eight newly claimed entries per run (reserved candidates do not block later entries). Treat these as best-effort alerts, not a safety-critical scheduler.

Telegram: set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`; initiate the bot chat first. Resend (optional): set `RESEND_API_KEY`, verified `RESEND_FROM`, and `REMINDER_EMAIL_TO` to **one exact allowlisted owner address**. Email uses plain text; Telegram uses no HTML/Markdown parse mode. No real reminder was sent during implementation verification.

PostgreSQL leases prevent concurrent sync/reminder execution. Delivery keys include item/date/version/offset or digest/date/task and channel. They are reserved durably **before** network sends; duplicates are skipped. Resend also gets an idempotency key. A crash/timeout can leave `reserved` or `unknown` delivery rows: they are not automatically resent because Telegram cannot provide exactly-once delivery. Inspect `deliveries` and provider delivery history before manually resetting/deleting a key. `sent` means the provider acknowledged the request (Resend acknowledgement is read back), not that the owner read the message. Failed/uncertain delivery appears in the cron JSON response. Monitor cron logs/provider dashboards; there is no delivery-admin UI yet.

## API/security

All inbox/agenda/chat/review/sync endpoints require the signed, 12-hour, HttpOnly, SameSite=Strict owner cookie. Production HTTPS cookies are Secure. State-changing browser endpoints enforce exact Origin; login has a shared durable database rate limit. Read/chat/sync/review routes also have durable limits. Public status reveals only generic setup/authentication state, never account addresses or inbox gaps. Cron uses an independent bearer secret and does not accept browser sessions. The OAuth callback is authorized by its short-lived signed cookie and single-use state, not by a public arbitrary email parameter.

Database queries are parameterized; only checked-in SQL migration text uses `unsafe`. Outgoing messages are plain text with control characters removed. Feed URLs and model citations are protocol/allowlist validated; chat cannot manufacture a cited source outside supplied database records. Prompt injection in messages is treated as untrusted data, not as tool instructions; the model has no tools. This reduces risk but does not make LLM interpretation infallible.

Status/dashboard failures produce configuration/coverage gaps and generic errors without leaking raw provider errors, tokens, SQL, or body contents. Back up both database and encryption key, restrict deployment logs, and use HTTPS. Owner password authentication is intentionally single-owner, not multi-tenant account management or MFA. The environment password is protected as a server secret, not a database password hash.

## Local development and verification

```sh
npm install
node --env-file=.env.local scripts/migrate.mjs
npm run dev
npm test
npm run typecheck
npm run build
```

On a host with an older default Node, use `npx --yes node@22 node_modules/vitest/vitest.mjs run tests/backend` and analogous Node-22 commands. Real database tests are opt-in:

```sh
# Use a dedicated DISPOSABLE test database, never your production URL.
TEST_DATABASE_URL='postgres://...' npx --yes node@22 node_modules/vitest/vitest.mjs run tests/backend
```

Tests exercise encryption/signatures, expiry/origin denial, exact source evidence, date validation/demotion, MIME bodies, readonly OAuth/allowlist logic, official feed parsing, reminder date/offset rules, protected routes, a repeatable migration CLI, and real PostgreSQL lease/rate-limit/fact-update/cancellation/delivery persistence. Real PostgreSQL sync tests use simulated Google/model HTTP responses to verify bounded durable continuation and failed-extraction suppression; they do **not** claim live Google/model connectivity. Backend was built in incremental failing-test → implementation → passing-test slices. No live Google OAuth, paid model completion, Telegram message, Resend email, or production deployment is asserted until you configure and explicitly exercise them.

## Primary implementation references

- Google Gmail synchronization: https://developers.google.com/workspace/gmail/api/guides/sync
- Google server OAuth: https://developers.google.com/identity/protocols/oauth2/web-server
- Google OAuth token expiration: https://developers.google.com/identity/protocols/oauth2#expiration
- Gmail scopes: https://developers.google.com/workspace/gmail/api/auth/scopes
- Calendar event listing: https://developers.google.com/workspace/calendar/api/v3/reference/events/list
- arXiv API user manual: https://info.arxiv.org/help/api/user-manual.html
- Vercel Cron limits: https://vercel.com/docs/schedules/cron-jobs/usage-and-pricing
- OpenAI chat completions: https://platform.openai.com/docs/api-reference/chat/create
