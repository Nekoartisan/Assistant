# Backend verification ledger

Incremental cycles were executed with Node 22 + the installed Vitest runner; this is a concise record, not synthesized test output.

| Slice | Observed RED | Observed GREEN |
|---|---|---|
| Owner security | missing `lib/security` module | 3 tests passed |
| Source extraction | missing `lib/extraction` module | 4 tests passed |
| Durable Postgres | missing `lib/db`; then SQL syntax error at reserved `window` identifier | real PostgreSQL lease/rate/fact-update/cancellation/delivery test passed after renaming `window_start` |
| Model adapter | missing `lib/llm` module | 3 tests passed with simulated HTTP; configured URL/model and source validation exercised |
| Google adapter | missing `lib/google` module | 2 tests passed; readonly scopes / PKCE / allowlist / calendar boundaries |
| News parsing | missing `lib/news` module | 2 tests passed |
| Bounded sync | missing `lib/sync` module | real-DB saved queue and second-request continuation passed with simulated Google/model responses |
| Protected routes | missing status route module | 4 tests passed, including actual database login + dashboard |
| Grounded empty chat | missing `lib/chat` module | real-DB honest empty state passed |
| Reminder windows | missing `lib/reminders` module | date-only + exact offset tests passed |
| Poll dispatch | authorized poll returned 503 because it only called sync | poll routed through durable reminder workflow, test passed |
| Ambiguous dates | invented year/exact timezone-free time retained | both independently demoted; 2 tests passed |
| Migration CLI | missing `scripts/migrate.mjs` | real migration and repeatable second run passed |
| Stale source suppression | stale item remained `open` after malformed model JSON | changed-source item became `needs_review`; saved cursor retained |
| Human review | confirmed review retained model confidence 0.4 | explicit open confirmation promoted confidence to 1 and persisted manual override |
| Bounded official feed | parser returned 150 entries instead of cap 100 | cap test passed |
| Reminder fairness | first 8 reserved candidates starved the 9th | simulated provider acknowledged the 9th; durable real-DB dedupe test passed |
| Exclusive calendar ends | exclusive end appeared as an extra day-of reminder | excluded from offset/day-of reminder selection |

Latest final backend run with disposable PostgreSQL **and live public feeds enabled: 32 tests passed, 16 files; 7.78 seconds**. TypeScript `tsc --noEmit` exited 0. Without the live-feed opt-in, 31 tests pass and 1 is skipped. The optional live-feed test was also separately enabled and **passed** against real unauthenticated arXiv/OpenAI/Google DeepMind feeds. All three endpoint probes returned HTTP 200 and valid XML; the app parser accepted real entries from each. No private Google OAuth, paid model call, Telegram send, Resend send, production database, or deployment was exercised.

The disposable PostgreSQL URL was provided for local verification and supplied only in command environments. It was not written into application env files. No host secrets were read or imported. Tests use clearly simulated external HTTP payloads, never presented as live inbox data.
