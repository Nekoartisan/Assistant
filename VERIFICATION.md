# Final verification — November 9, 2026

## Executed checks

- Next.js optimized production build: PASS.
- TypeScript `tsc --noEmit`: PASS.
- Vitest with disposable real PostgreSQL and `LIVE_PUBLIC_FEEDS=1`: **121 passed, 0 skipped** across 29 files.
- Sync regression fixes: email-first fair account turns, deadline-aware provider calls, batched research persistence, bounded lease recovery, and authenticated live-status polling are covered. Chat uses `max_completion_tokens` without unsupported forced sampling; a separate tiny non-private live request returned HTTP 200 with valid JSON.
- Playwright against the production server and a separate empty, migrated disposable PostgreSQL database: **3 passed**. Exercised real session login/logout, anonymous-route denial, cross-origin denial, account settings, weekly/research filters, desktop/mobile layout, and no browser runtime errors. A controlled-response continuation scenario proved sequential automatic batches, minimum spacing and stop-at-caught-up behavior; it does not claim real Google sync. Test-only integration placeholder values were used; no private Google/model integration was called.
- Throughput fixtures: **16 full threads in one cycle** with concurrency capped at four, and **100 calendar events / 200 facts in three source/item write statements**. These are controlled-provider results against real disposable PostgreSQL, not a speed promise for the user's mailbox. Failure-isolation, backoff, resumable discovery, subject-only deadlines, source-change review, and 15-minute fresh-calendar reuse were verified.
- A separate live model test used only a synthetic exam/registration message: two facts were returned with the explicit ICT exam time and date-only registration deadline preserved. No real email was sent to the provider in that diagnostic.
- Explicit migration rerun: PASS, already applied/checksummed.
- Production dependency audit: **0 known vulnerabilities** at verification time; this is not a guarantee against unknown vulnerabilities.
- Local Hermes ledger/collector Python tests: **8 passed**. Existing local morning/evening job schedules/destinations preserved; only prompts and collector script changed.

## Important limits

- The latest source changes are not deployed. No live private Google email/calendar scan, Telegram message, or Resend email was exercised for this patch. Provider-fixture tests are explicitly simulated integration tests, not live mail coverage. A tiny live model connectivity request used no private data; it does not establish successful mailbox extraction or chat against the deployed website.
- Cloud Gmail initial coverage: last 90 days, resumable in batches, not all historical mail. Full plain/HTML mail bodies are read. PDF/image/Office attachments are flagged as unread, not parsed; attachment-only exam instructions still require manual review.
- Stored agenda facts carry exact quotes, original date wording and source links. Missing/ambiguous year/timezone requires review. Source updates are reconciled; automatic reinstatements reopen automatically dismissed facts while explicit owner decisions are retained. Bangkok week-boundary offsets are tested.
- The two shipped cloud cron jobs are daily digests. Frequent poll reminders require deploying the optional frequent scheduler configuration on a compatible plan or using a trusted external scheduler. Date-only facts do not acquire invented midnight deadlines.
- Research data is collected from bounded official feeds and retained in PostgreSQL. Previous weeks are available only to the extent that entries have been fetched; this is not an exhaustive historical archive.
- arXiv original-submission dates and RSS announcement dates are distinguished. RSS is a fallback, not evidence a paper was originally submitted today.
- The local Hermes ledger starts empty until original emails are actually read by a run. It is a separate store from the cloud app, not automatic cloud synchronization.

Do not use the app as the only reminder system for important exams until you have connected the real accounts, reviewed extracted dates, completed backfill, and verified a test notification yourself.
