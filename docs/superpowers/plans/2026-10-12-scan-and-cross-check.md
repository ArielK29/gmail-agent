# On-demand scan and cross-check (issue #15) Implementation Plan

> Same steps as the rest of the agent: plan, edge cases and current docs, corrections, decisions, checkpoints, tests first, chaos, deploy, browser check, deep review.

**Goal:** the member picks a period (for example January), types a Gmail search and/or a list of things to look for, ticks an explicit consent, presses "scan". The agent finds the matching mails, reads them, and reports per item "found in mail X" / "not found".

**Architecture:** a job table `gmail_scans` (+ `gmail_scan_hits`). The function `gmail-scan` starts a job (`start`), advances it one slice of at most 30 mails per call (`step`, driven by the page and by the scheduler so a closed page does not stop it) and cancels (`cancel`). Gmail does the searching (`messages.list` with `q`), the model only matches and summarizes. Everything pure lives in `logic.ts` (tested in Node); the job logic lives in `scan.ts` (tested with a fake database and fake Google / Gemini, including a chaos run).

**Tech:** Supabase Edge Functions, Postgres + RLS, Gmail API (read-only scope, unchanged), Gemini, plain JS page.

## Decisions (defaults the owner accepted by saying "finish this part")
1. Interface: a **button** on the page (no chat).
2. Scope: **period + Gmail search text + a list of items**, at most **200 mails per scan**, 30 per slice, 10 per model call.
3. Result: shown on the page, kept **30 days**, deleted with "disconnect and delete", deletable by the member any time.
4. Privacy: a **warning and an explicit consent tick** on the button (free Gemini tier: Google may use the content to improve products). The server refuses a scan without `consent: true` and stamps `consent_at`.
5. Cost: shares the **daily 300 mails budget** with the normal sync; at most **3 scans a day** and **one active scan** per member.

## Edge cases and corrections found before writing code
| # | Edge case | Decision |
|---|---|---|
| 1 | Two slices of one scan running at once (page + scheduler) | An atomic claim (`claimed_until`, 60 s) in one conditional update; the loser does nothing |
| 2 | Gmail busy for a mail (429/5xx) | Same rule as the sync: not skipped; the slice stops before moving on and is retried |
| 3 | Mail deleted meanwhile (404) | Counted as processed, no hit |
| 4 | Daily budget used up in the middle | Status `paused`; the scheduler continues the next day |
| 5 | Access revoked in the middle | Status `failed`, error `needs_reconnect`; the page offers to reconnect |
| 6 | Hostile search text (operators, parentheses, quotes, 5000 characters, control and bidi characters) | Sanitized and cut; parentheses and braces removed; unbalanced quotes removed |
| 7 | Dates: month ends, leap day, year end, end before start, more than 366 days, the future, before 2000 | Validated as real calendar dates; the Gmail `before:` is the day after the end |
| 8 | Items: empty, duplicates (any letter case), 500 entries, 5000 characters, control characters | Cleaned, deduplicated, at most 100 items of 120 characters |
| 9 | The model invents ids or item numbers | Only asked ids and item numbers inside the list are accepted |
| 10 | A scan with neither text nor items would read the whole period | Refused (`nothing_to_search`) |
| 11 | The page is closed | The scheduler advances running scans (cron every 2 minutes) |
| 12 | Results must not outlive the connection | `gmail-disconnect` deletes scans and hits; `expires_at` 30 days; the scheduler deletes expired scans |
| 13 | A member opens a scan of another member | RLS: own rows only; no insert, update or any internal column from the browser |

## Checkpoints
- **CP1** pure logic + its tests (random and hostile inputs). **CP2** migration + permission test (two members and a stranger). **CP3** `scan.ts` + tests with fakes, chaos and concurrency, mutation check. **CP4** function deployed, outside-in probes. **CP5** page + browser check with hostile data at 375 px. **CP6** privacy and terms updated, `docs/TESTING.md`, issue closed with evidence.