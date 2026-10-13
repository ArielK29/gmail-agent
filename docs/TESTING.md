# How the Gmail agent is tested (and how to repeat it)

Last full run: **2026-10-12**, gmail-sync v12. Every line says what was run and what came out.

## 1. Unit tests (no network, seconds)
```bash
node --test supabase/functions/gmail-sync/logic.test.ts
```
**Result: 18 of 18 pass.** They cover text cleaning, charset decoding, parsing the model's answer, the retry loop (with a fake model and a fake clock: 429 then 200, 429 forever, 400), the daily budget (`planBatch`: budget left / exhausted / cut in the middle) and the Google token answer (`classifyTokenResponse`: only `400 invalid_grant` means "revoked").

## 2. End-to-end tests against the real project (`ppkbuyiatkxpfeqmvwzb`)
Force a run exactly like the scheduler does, from SQL (the secret never leaves the database), then read the answer:
```sql
select net.http_post(url := 'https://ppkbuyiatkxpfeqmvwzb.supabase.co/functions/v1/gmail-sync',
  headers := jsonb_build_object('Authorization', 'Bearer ' || (select value from public.agent_secrets where name = 'cron'), 'Content-Type', 'application/json'),
  body := '{}'::jsonb, timeout_milliseconds := 60000) as request_id;
-- then: select status_code, content from net._http_response where id = <request_id>;
```
| Scenario | How it was set up | Result |
|---|---|---|
| Normal rescan | Delete the latest summaries, reset `history_id` | Same emails saved again, position saved, `problems: []` |
| Daily budget exhausted | `gmail_usage` = 300 for today, delete 2 summaries, reset position | `saved: 0`, no error, the 2 emails stayed missing, position stayed empty (nothing lost) |
| Budget back | Remove the usage row, run again | `saved: 2`, position saved |
| Expired or revoked access (`invalid_grant`) | Throw-away auth user with a fake refresh token | Connection kept and marked `needs_reconnect`; the real member stayed `active`; the throw-away user was deleted afterwards |

## 3. Security checks
- `supabase/tests/rls_gmail_agent_test.sql` (anonymous and other members see nothing, the token column and `agent_secrets` / `gmail_usage` are closed). All blocks rolled back; results matched.
- Supabase advisors (security): only INFO "RLS enabled, no policy" on the service-role tables and the known WARNs (`pg_net` in `public`, leaked-password protection needs Pro).
- `snyk code test`: 2 MEDIUM, both in `dev-server.js` (a local helper, not deployed).

## 4. Page checks (live site, injected test rows)
Five rows including one with HTML in the sender and subject: HTML shown as plain text (no `<img>` or `<b>` created), 1 "urgent" and 1 "not urgent" badge, 2 suggested actions. Filters: urgency, category, search, no-match message, and "normal" includes unrated rows. Counter "X of Y" correct each time.

## 5. Debug loop used (what to do when something looks wrong)
1. Reproduce with section 2 (never guess).
2. Read `net._http_response` for the answer, then the logs: `query_logs` with `source = 'function_edge_logs'` and the key `response.status_code` (the key is NOT `status_code`).
3. Fix, run the unit tests, deploy both files of the function (`index.ts` and `logic.ts`).
4. Repeat the scenario and compare with the table above.

## Not verified
- A real Gemini `429` and 30+ new emails against a REAL mailbox: they cannot be triggered on demand. Since 2026-10-12 the real `syncOne` code runs against a fake database and fake Google / Gemini answers (section "Sync integration tests"), so the logic is covered; the real services are not.
- The "Sign in with Google" flow end to end: the provider is not enabled in Supabase yet.

## Fix runs after the browser end-to-end report (2026-10-11)

### Issue #3: server writes must not fail silently (gmail-disconnect v5, gmail-sync v11)
Run with a throw-away member (seeded and deleted afterwards), a visible browser pane and a trigger that makes deletes on `gmail_digest` fail on purpose.

| Step | Result |
|---|---|
| Disconnect while the delete is blocked | The page says "לא הצלחנו לנתק ולמחוק. נסה שוב." The connection, the token and the 3 summaries are all still in the database (checked with SQL). Nothing was revoked at Google. |
| Remove the trigger, disconnect again | Success: the page is empty and says "חבר את Gmail", the member's rows and connection are gone, the message honestly says Google did not confirm the revoke (the token was fake). The owner's 56 rows and connection were unchanged. |
| Cleanup | Trigger and function dropped, throw-away member deleted: 1 user, 1 connection, 56 rows. |
| gmail-sync v11 in production | A forced run: `200`, `problems: []`, position and last-checked written. |

Not exercised: a failing write to `gmail_usage` or to the position in gmail-sync (it needs a member with a valid Gmail token; the owner's real mailbox is not used for this). Those two branches are covered by reading the code and the bundle check only.

### Issue #4: nothing English reaches the customer
`node --test docs/logic.test.js`: 7 of 7 pass. The guard test was checked the other way too: when `problemMessage` was changed on purpose to return an English sentence, the guard FAILED (red), and after restoring it passed (green).

### Run all tests
```bash
node --test docs/logic.test.js supabase/functions/gmail-sync/logic.test.ts
```
Expected: 25 of 25 pass.

## Browser end-to-end run (repeatable, safe)
Used on 2026-10-11 with Claude in Chrome and with the visible browser pane of the Claude app.

**Safety rules (learned from the lesson: the agent stops before anything that costs money or writes to production):**
1. Ask the owner before any test that spends model quota on real mail or changes the owner's real rows. Prefer the throw-away member.
2. Type a password only on `http://localhost:5174` (local dev page of this app), never on the live site. Use a fresh random password for every run and never commit it.
3. Always run the cleanup block and stop the local server.

**Steps**
1. `supabase/tests/e2e_seed.sql` block 1 (replace `<PASSWORD>`): creates the member, a fake connection and 3 summaries.
2. `node dev-server.js` (port 5174). Open the page in the visible pane. Scroll to the top first (a page left scrolled down makes clicks land on the footer links).
3. Sign in with the email and password; check the banner, 3 rows, 1 "urgent" badge, 1 suggested action.
4. Run the scenarios (empty and wrong login, Enter key, notice messages with `?gmail=cancelled`, simulated load error, cooldown, expired access, disconnect, and the optional blocked-delete trigger).
5. Cleanup: block 2, stop the server, block 3. Expected: `users = 1`, `connections = 1`, the owner's digest rows unchanged, no leftover trigger or function.

**Tool notes:** the Chrome extension tab runs in the background (its `visibilityState` is hidden), so typing and screenshots fail there: use `form_input` and `.click()`, or use the visible pane. Return plain strings from page scripts (the tool blocks objects with secret-like field names).

**Result of the verification of this procedure (2026-10-11):** seed returned member=1, identity=1, connection=1, digest_rows=3; sign-in with Enter worked; 3 rows, counter "מוצגים 3 מתוך 3", 1 urgent badge; cleanup and check returned users=1, connections=1, digest_rows=56, no leftovers.

## Daily summary card (2026-10-12)
A "סיכום יומי" card at the top of the page: how many mails arrived in the last 24 hours, the urgent ones (up to 5, newest first, with the suggested action), and a count per category. It is computed in the browser from the saved digest (`dailySummary` in `docs/logic.js`): **no model call, no new secret, no cost**. It is a card on the page, not a message that is pushed to the member (see TODO.md, "Daily summary push").

- Unit tests: `node --test docs/logic.test.js supabase/functions/gmail-sync/logic.test.ts` -> **32 of 32 pass** (7 new: 24 h window, urgent list and "and N more", categories and actions, broken input, "list may be cut off" warning, Hebrew number forms, Hebrew-only guard). Checked red/green: with the window changed on purpose to 48 h, 2 tests failed; restored, all pass.
- Browser run (throw-away member, local page): 4 seeded mails, one of them 30 hours old and urgent. The card said "3 מיילים חדשים ב-24 השעות האחרונות", "מייל דחוף אחד" (the old urgent mail was correctly left out), the suggested action, and "כספים: 1 · אישי: 1 · פרסומת: 1". Cleanup: 1 user, 1 connection, no leftover trigger.
- Not verified: a member with more than 200 mails a day (the "may be incomplete" note is covered by the unit test only), and the card on the live site (it goes live with the push to `main`).
## Sync integration tests (2026-10-12)
The work for one member moved from `index.ts` into `sync.ts` (same code, only moved, `index.ts` keeps the HTTP entry point). `sync.test.ts` runs the REAL `syncOne` in Node with a fake database (tables in memory, any write can be made to fail) and fake Google / Gemini answers (a fake `fetch`, a fake clock). No network, no real mailbox, no cost.
```bash
node --test supabase/functions/gmail-sync/sync.test.ts
node --test docs/logic.test.js supabase/functions/gmail-sync/logic.test.ts supabase/functions/gmail-sync/sync.test.ts
```
**Result: 14 of 14 pass; all together 46 of 46.**

| Scenario | What the test checks |
|---|---|
| 45 new mails | 30 saved in 3 model calls of 10, position NOT moved, usage = 30; next run saves the other 15 (none twice), position moves, usage = 45 |
| Exactly 30 new mails | Not "behind": position moves |
| Gemini 429 forever | 4 attempts, pauses 500 / 1000 / 2000 ms, run fails with the model reason, nothing written, connection stays active |
| Gemini 429, 429, then 200 | Recovers in the same run |
| Gemini 400 | Not retried |
| Digest write fails | `could not save`, budget not charged, position stays |
| Usage write fails | Mails kept, `could not save usage` reported |
| Position write fails | Mails kept, `could not save` reported; next run skips them (no second model call) and moves the position |
| Daily budget used up / partly left | 0 summarized and position stays / only the remaining number summarized |
| `invalid_grant` / other token error | `needs_reconnect` and row kept / throws, connection untouched |
| History 404 | Starts again from the last 2 days |

**Mutation check (each change made on purpose, tests must go red, then restored):** per-run limit 30 to 100 (2 failed), position always moves (3), usage failure ignored (1), digest failure ignored (1), position failure ignored (1), known mails not skipped (2), chunk 10 to 30 (2). After restoring: 14 of 14 pass.

**Deployed:** gmail-sync v12 (3 files: `index.ts`, `sync.ts`, `logic.ts`). A forced run like the scheduler's: `200`, `{"saved":0,"connected":true,"problems":[]}` (no new mail at that moment).
Still not covered: the real Gmail and Gemini services themselves.

## Deep bug hunt (2026-10-12): everything found in one pass
Method: read every file (page, 3 pages of text, 5 functions, 6 migrations, tests), run the page in a real browser with hostile data (very long words, HTML in subjects, bidi override characters, missing sender, 200 mails), probe the deployed functions from outside, run permission tests as two members and a stranger, and add tests of a kind that normal checks do not cover: random inputs by the thousand, a chaos simulation, metamorphic checks and time edges.

| # | Found | Severity | Fix | Proof |
|---|---|---|---|---|
| 1 | A long word without spaces (a long sender, subject or link-like text) stretched the whole page to 3482 px; the "check now" button was pushed off screen | High | `overflow-wrap:anywhere`, `min-width:0`, no horizontal scroll | Browser at 375 px: `scrollWidth` = viewport, button visible |
| 2 | **Mail lost** when Gmail answered 429/5xx for one mail: it was dropped and the history position moved on | High | A mail is skipped only on 404 (deleted); any other failure holds the position and is retried | 3 deterministic tests + chaos run; mutation checked |
| 3 | **Mail lost** when more than 500 mails (5 history pages) piled up: the position jumped to the mailbox head and the unread pages were never read | High | The position moves only to the last history record that was really read | Test with 7 pages; mutation checked |
| 4 | Connecting while un-ticking the Gmail permission on Google's screen stored a connection that failed on every run | Medium | The callback checks the granted scope, revokes the grant and shows a Hebrew message | `gmail-callback/logic.test.ts`; message verified in the page |
| 5 | The "check now" cooldown did not hold while the model kept failing (every press = up to 4 model calls) | Medium | Every attempt is stamped (`last_attempt_at`, migration 006); the cooldown uses it; the scheduled run also orders by it | `isThrottled` tests; stamp verified in the live database |
| 6 | Text written by other people could reorder what the member reads (right-to-left override in a subject) | Medium | Bidi, zero-width and control characters are removed when saved and again when shown | Property tests (3000 strings), browser check |
| 7 | After sign-out the previous member's mails stayed in the page's memory and DOM; stale notices stayed on the login screen | Medium | Everything of the member is wiped on sign-out | Browser check after sign-out |
| 8 | The page could break for up to 10 minutes after a deploy (cached old `logic.js` without the new functions); a thrown error in loading left the page silently half empty | Medium | Version in the script address, feature check with one automatic reload, `try/catch` with a Hebrew message, an older answer never overwrites a newer one | Code review, browser check |
| 9 | `cleanText` could return text ending with a space after the length cut | Low | Cut, then trim | Found by the random test |
| 10 | The privacy page said revoked access deletes the connection automatically (it marks it as expired) and did not list urgency and suggested action as stored | Medium (a legal statement that was untrue) | Text corrected on privacy, terms and about | Read against the code |
| 11 | The callback crashed on an unreachable or non-JSON Google answer; two accounts could mix if wiping the old summaries failed | Low | Both handled | Review; endpoint probes |
| 12 | Sign-in could be submitted twice; no favicon (a 404 on every page load) | Low | Buttons disabled while waiting; icon added | Browser |

### New kinds of tests
- **Chaos simulation** (`sync.test.ts`): 60 random worlds. Google, Gemini and the database fail at random in every step for 6 runs, then everything heals. Always true: the position never passes an unsaved mail, a saved mail is never sent to the model again, the usage counter never exceeds the saved mails, and after healing exactly the mails that still exist are saved. Mutation checked with 6 deliberate breakages (all caught).
- **Two runs at the same time** (the scheduler and the button): no duplicates, nothing lost.
- **Random inputs** (seeded, replayable): `cleanText` 3000, `parseModelAnswer` 4000 hostile answers, `planBatch` 3000 plans, `callWithRetry` 1500 answer sequences, `classifyTokenResponse` 2000, `dailySummary` 2000 mailboxes including broken rows and clock-skewed dates.
- **Metamorphic checks**: the daily summary does not depend on the order of the rows; cleaning text twice equals cleaning once.
- **Time edges**: exactly 24 hours, 23:59:59.999, a leap day, year end, daylight-saving dates, +02:00 and -05:00 inputs; a 100000-mail mailbox in under 2 seconds.
- **Outside-in probes** of the deployed functions: no token, garbage token, the publishable key as a token, wrong method, forged and oversized `state`, evil redirect parameters (ignored): every answer was the expected one.
- **Permission test as two members and a stranger** (`supabase/tests/rls_gmail_agent_hardening_test.sql`): 26 lines, all good (the token, `history_id` and `last_attempt_at` columns are unreadable, `select *` is denied, no write is possible from the browser, one member cannot touch the other's rows, account deletion removes everything of the member and nothing of the other).

### Result
`node --test docs/logic.test.js supabase/functions/gmail-sync/logic.test.ts supabase/functions/gmail-sync/sync.test.ts supabase/functions/gmail-callback/logic.test.ts`
Deployed: gmail-sync v13, gmail-callback v5, migration 006. Snyk Code: the only findings left are the two known ones in `dev-server.js` (a local helper). Supabase advisors: unchanged (`pg_net` in `public`, leaked-password protection: Pro plan).
Not covered: the real Gmail and Gemini services, the real Google consent screen (needs #7), the sign-up e-mail.
## On-demand scan and cross-check (issue #15, 2026-10-12)
What it is: the member picks a period, an optional Gmail search text and an optional list of things to look for (one per line), ticks an explicit consent next to a warning, and presses "סרוק". The agent finds the mails with Gmail's own search (at most 200), reads them (read-only), and for every mail records which items it mentions plus one Hebrew sentence. The result shows per item "found in N mails" or "not found", with the mails behind it. Plan: `docs/superpowers/plans/2026-10-12-scan-and-cross-check.md`.

Deployed: gmail-sync v14 (scan actions `scan_start`, `scan_step`, `scan_cancel`, `scan_tick`), gmail-disconnect v6 (also deletes scan results), migrations 007 to 009, a second scheduler job every 2 minutes (`gmail-scan-tick-every-2-min`) that continues scans nobody is driving and deletes results older than 30 days.

| Layer | Test | Result |
|---|---|---|
| Pure logic (`logic.ts`) | validation of the request, search text cleaning, items, Gmail query (month end, leap day, year end), model answer parsing, local matching; 3000 random bodies, 3000 hostile model answers, 2000 random texts | all pass |
| Job logic (`scan.ts`, `scan.test.ts`) | start refusals (consent, not connected, expired, active scan, 3 per day), full run of 75 mails in slices, 200-mail cap, no result, invalid query, busy mail holds the counter, deleted mail, daily budget (pause and next day), revoked access, two slices at once, a stale claim, saved results not sent twice, cancel (also during a running slice), the scheduler, expiry | 16 tests pass |
| Chaos | 50 random worlds; Google, Gemini and the database fail at random; two slices at once; the clock jumps a day. Always true: the counter never passes a mail that is neither saved nor deleted, no mail is sent to the model after it was saved, hits are unique, usage never exceeds saved results or the cap; after healing the scan ends with exactly the mails that still exist | pass |
| Mutation check | 9 deliberate breakages (busy mail passed, no claim, saved mails resent, budget ignored, cancel without owner check, step without owner check, expiry removed, counter off by one, daily cap removed) | every one made tests fail; restored all pass |
| Page logic (`docs/logic.js`) | messages, items text, form validation (same rules as the server), progress text, per-item roll-up (1000 random results), last full month in every kind of month | all pass |
| Permissions | `supabase/tests/rls_gmail_scans_test.sql`: two members and a stranger; internal columns unreadable, no write from the browser, `select *` denied, the database refuses a second active scan, 366-day gap, 101 items, no consent stamp, unknown status; deleting a scan or a member removes the hits | 26 lines, all good |
| Outside-in | scheduler token cannot start a scan, a garbage token cannot tick or start, an unknown action is refused | all as designed |
| Browser (real function, throw-away member, 375 px) | form messages for 6 wrong inputs; a real start: the member's text was cleaned ("invoice (x) {y}" became "invoice x y"), duplicates removed, the server stamped the consent, the fake Google token ended the scan as "החיבור ל-Gmail פג" and marked the connection; seeded results with HTML, a bidi override, very long words and a missing sender render as plain text with no horizontal scroll; delete removes scan and hits; sign-out wipes the card; disconnect removes the scans | pass |

Bugs found by these tests while building it (all fixed before deploy): a cancel that arrives while a slice is running was overwritten by that slice and reported as "done"; two starts at the same moment could create two scans (now a unique index plus the normal answer); the counter was a count instead of a prefix of the slice, so a busy mail in the middle could be skipped when other mails of the slice were already saved.

Not covered: the real Gmail search syntax for unusual queries, the real Gemini matching quality, and the real Google consent screen (needs #7).

## Morning briefing (issue #16, 2026-10-12)
What it is: a card at the top of the page: greeting, how many mails are new since the last visit, "upcoming deadlines" (a date the mail asks the owner to act by, from 30 days ago to 7 days ahead) and "maybe needs an answer" (a mail from a person, in a category that needs answers, whose thread has no later message of mine for at least 12 hours, within 14 days). Plan: `docs/superpowers/plans/2026-10-12-morning-briefing.md`.

Deployed: gmail-sync v15 (the model also returns a deadline; after each sync up to 20 recent threads are asked about with `format=metadata`, headers and labels only), migration 010 (`thread_id`, `due_date`, `needs_reply`, `reply_checked_at`, two partial indexes). A forced scheduler run on the deployed version returned `{saved:0, connected:true, problems:[]}`.

| Layer | Test | Result |
|---|---|---|
| Pure logic (`logic.test.ts`) | deadline accepted only as a real day within -60..+400 days, robot senders, who wrote last in a thread (drafts, trash, spam ignored, missing date, alias answers via the SENT label), reply-worthy rules, candidate picking (window, 6 h recheck, unique threads, limit 0) | all pass |
| Reply check (`reply.test.ts`) | flag set / cleared by the thread, deadline saved from the model, a failing thread API never changes the sync result, 404 clears the flag, a newsletter in the same thread is not flagged, 40 chaos worlds | 9 tests pass |
| Page logic (`docs/logic.test.js`) | briefing lists (ranges, order, max 5 with "and N more"), greeting by hour, local day, since-last-visit | all pass |
| Mutation check | 7 deliberate breakages (reply logic inverted, deadline range removed, 6 h recheck removed, duplicate threads allowed, robots allowed, flag applied to every mail of the user, a busy thread treated as answered) | every one made tests fail; restored all pass |
| Whole suite | `node --test` on all six test files | 132 pass, 0 fail |
| Browser (throw-away member, 375 px) | briefing with seeded rows incl. hostile text and bidi characters: plain text, no horizontal scroll; empty state; sign-out wipes the card | pass |

Bugs found by these tests while building it (all fixed before deploy): `pickReplyCandidates` with limit 0 returned a thread; a "waiting for answer" flag of one thread was also applied to mails in it that are not reply-worthy; the cleaned text could end with a space after the length cut.

Not covered: the real quality of the model's deadline guess on real mails, the real Gmail thread answers, and delivery as a push message (issue #14, needs a channel). Marking an item "done" is not built.
### "Handled" button (agent 1, v2, 2026-10-12)
A button "סימנתי כטופל" on every item of the briefing. The member sets `handled_at` on their own mail; the item leaves the briefing (the mail stays in the list below and still counts as new since the last visit). Migration 011: column-level `update (handled_at)` grant plus an own-row update policy, nothing else is writable from the browser.

| Layer | Test | Result |
|---|---|---|
| Permissions | `supabase/tests/rls_gmail_handled_test.sql`: marks own mail, unmarks, cannot mark another member's mail (0 rows), cannot edit summary / needs_reply / due_date / user_id, cannot insert, anon denied, other member untouched | 11 lines, all good |
| Page logic | handled rows leave both lists but count as new; all-handled gives the empty state | 37 page tests pass |
| Mutation check | the filter removed (all, only replies, only deadlines) | each made a test fail; restored |
| Browser (throw-away member, localhost) | 3 seeded items; pressing the button removed only that item, the database row got `handled_at`, a reload kept it hidden, no horizontal scroll; member deleted afterwards (1 user, 1 connection left) | pass |
| Whole suite | `node --test` on all six files | 133 pass |
Security advisors: unchanged (the known `pg_net` and leaked-password items; the four "no policy" notices are server-only tables on purpose).

## Calendar and tasks in the briefing (issue #20, 2026-10-12)
What it is: two new sections in the briefing card: "today and tomorrow in the calendar" (events of the primary calendar that have not ended) and "tasks waiting" (open tasks due from 30 days ago to 7 days ahead). Read-only, optional: the member can untick the calendar or tasks permission on Google's screen. Members who already connected see a button "add calendar and tasks" that reopens Google's consent screen.

Deployed: gmail-sync v16, gmail-callback v6 (records which optional permissions were granted, wipes the rows of a permission that was not), gmail-connect v4 (asks for the two extra read-only scopes), gmail-disconnect v7 (also deletes the agenda), migration 012 (`gmail_agenda`, flags `has_calendar` / `has_tasks`). A forced scheduler run on v16 returned `{saved:0, connected:true, problems:[]}`. The consent URL the page really received contains the three scopes.

| Layer | Test | Result |
|---|---|---|
| Parsing (`agenda.test.ts`) | cancelled, declined, working-location and duplicate events, all-day vs timed, links and bidi characters in titles, missing titles, tasks without a due day, completed/deleted/hidden tasks, caps of 30 and 50, 3000 random Google answers (every row satisfies the database rules) | pass |
| Permission detection | 401 and "insufficient scope" mean the permission is gone; "API not enabled in the project" (even when the text also says insufficient) and rate limits do not | pass |
| Refresh logic (real `refreshAgenda` and `syncOne`, fake Google and database) | nothing asked without the permission, at most every 10 minutes, stale rows removed, changed rows updated not duplicated, another member's rows with identical ids untouched, Google busy or unreachable keeps the saved day and never switches a permission off, a failed list changes nothing, a failed write deletes nothing, an empty calendar clears the day, a failing calendar never fails the sync | 21 tests pass |
| Chaos | 40 random worlds: Google and the database fail at random, the clock jumps back and forward; other members are never touched; after healing the saved day equals Google's exactly | pass |
| Mutation check | 10 deliberate breakages (cancelled kept, declined kept, completed tasks kept, API-disabled treated as missing permission, no throttle (two ways), unscoped stale delete, failed write unnoticed, failed list skipped silently, failed events treated as an empty calendar) | every one made tests fail; two needed a stronger test first (written, then caught); restored all pass |
| Callback | exact scopes only (look-alike, wider calendar and read-write tasks scopes do not count), garbage tokens | 4 tests pass |
| Page logic | today/tomorrow, sorted, all-day first, running event says "now", ended events gone, tasks 30 days back to 7 ahead, midnight boundary, garbage | 42 page tests pass |
| Permissions | `supabase/tests/rls_gmail_agenda_test.sql`: own rows only, no write from the browser (insert, update, flags), delete own only, anon denied, database refuses a task without a day, a timed event without a start, an unknown kind, a 201-character title, a duplicate; deleting a member removes the rows | 18 lines, all good |
| Browser (throw-away member, 375 px, localhost) | events and tasks render; hostile title (bidi override, `<b>` tags, a 120-letter word) is plain text, no horizontal scroll; the hint and the "add" button show for a member without tasks; the button reached Google's real sign-in page with the three scopes in the address; member deleted afterwards (1 user, 1 connection, 0 agenda rows) | pass |
| Whole suite | `node --test` on all seven files | 160 pass, 0 fail |

Bug found by these tests while building it: the chaos test first failed because the test itself forgot to install its fake Google (a test bug, fixed; the code was right).

Google Cloud (project gmail-agent): the Calendar API and the Tasks API are enabled and both scopes are saved in Data Access. Not verified: the real Google Calendar and Tasks answers (needs a member who connects again with the new permissions: the "add calendar and tasks" button). Everything above uses fakes shaped like Google's documented answers.

## Morning briefing by e-mail (issue #14, 2026-10-12)
What it is: a switch on the page, "send me the briefing by e-mail every morning". When it is on, the scheduled run sends ONE mail per local day, between 07:00 and 12:00 in the member's own time zone (taken from the browser, checked on the server), only if the briefing has something in it, and only to the member's own connected Google address. The mail has the same four lists as the page. Sending uses Resend (secret `RESEND_API_KEY`, optional `EMAIL_FROM`); without the secret nothing is sent and nothing is counted as a failure.

Deployed: gmail-sync v17 (`briefing.ts`, `digest.ts`, scheduled run calls `sendDigests` at the end), migrations 013 (switch and bookkeeping columns, the member may write only `digest_email` and `digest_tz`) and 014 (switching off and on resets the failure counter, done by the database). A forced scheduler run on v17 returned `{saved:0, connected:true, problems:[], digests:{sent:0, empty:0, failed:0, notConfigured:0}}`.

| Layer | Test | Result |
|---|---|---|
| Time zones and window | invalid or hostile zone names become the default; local day and hour across the date line and the Israeli clock change (23:30 UTC on 24.10 is 01:30 local); window 07:00 to 11:59 | pass |
| Same lists as the page | 400 random worlds: the mail's deadlines, replies, events and tasks equal the page's (`docs/logic.js`) in the machine's zone | pass |
| The message | empty briefing sends nothing; subject has numbers only (no mail text, no line break); script tags, attribute tricks, bidi characters, `&amp;` tricks and 400-letter words are escaped or cut; 2000 random garbage worlds never throw | pass |
| Delivery (`digest.test.ts`, real `sendDigests`, fake database and sender) | once per local day, again the next day; three overlapping runs send once; empty day stays claimed; not configured gives the day back and counts nothing; temporary failure gives the day back, permanent refusals count and stop after three, a success resets; only opted-in, alive members in their own morning; each mail goes to its owner; a failing read or a crash never leaves a day claimed without a mail | pass |
| Real sender function | without a key it never calls out; with a key the request has one recipient, an idempotency key per member and day, 4xx is permanent, 429/5xx/network are temporary | pass |
| Chaos | 40 random worlds, 4 members in different zones, random failures, overlapping runs, a jumping clock: never two mails for the same member and day, never to a stranger, after healing everyone opted in gets exactly one | pass |
| Mutation check | 12 deliberate breakages (no claim condition, claim result ignored, day not given back when not configured, permanent failures not counted, wrong recipient, empty day given back, no end of the morning window, failure cap removed, escaping removed, address check removed, member zone ignored, handled mails mentioned) | every one made tests fail; restored all pass |
| Permissions | `rls_gmail_digest_email_test.sql` (16 lines) and `rls_gmail_digest_email_trigger_test.sql` (3 lines): own row only; no write to the token, the recipient address, the last-sent day, the failure counter, status or flags; a bad or 65-character zone is refused by the database; no insert or delete; anon denied; the reset trigger works and cannot be called directly | all good |
| Browser (throw-away member, localhost) | the switch appears for a connected member, ticking it saved `digest_email` and the browser's zone, reset a failure counter of 3 to 0, survived a reload, no horizontal scroll; member deleted afterwards | pass |

Bugs found by these tests while building it: the supabase-js query builder has no `.catch`, so a cleanup written with `.catch()` would have thrown inside the error path (fixed with try/catch); the briefing builder threw on a NaN clock (now falls back to the real time); two of my own test expectations were wrong (the clock-change hour, and mails too old in the healing phase).

Not verified: a real e-mail leaving through Resend. That needs a Resend account and its API key set as the Supabase secret `RESEND_API_KEY` (owner), and for customers other than the owner a verified sending domain (#88).
### "Send me a test e-mail now" (issue #14, 2026-10-13)
A button next to the e-mail switch. It sends the real briefing (marked as a test), or a short note when the briefing is empty, to the member's own Google address at any hour, at most once per 10 minutes (claimed with one conditional update). It exists so the e-mail can be checked as soon as the sending service is connected, without waiting for the next morning. Deployed: gmail-sync v18, migration 015 (`digest_test_at`, written only by the function).

| Layer | Test | Result |
|---|---|---|
| `digest.test.ts` (22 tests now) | goes to the member's own address; empty briefing still gets a note; two clicks at once send once; allowed again after 10 minutes; not configured, a failed send, a failed read and a crash all give the time back and answer with the reason; not connected, needs reconnect and a bad address are refused before anything is sent; another member's cooldown untouched | pass |
| Mutation check | cooldown condition removed, no give-back after a failure, wrong recipient, address check removed | each made a test fail; restored |
| Outside-in on the deployed function | the scheduler token is refused for this action (400 member_required), a garbage token gets 401 | as designed |
| Whole suite | `node --test` on all eight files | 182 pass |

Not verified: a real mail leaving through Resend (needs the account and `RESEND_API_KEY`, owner).

## Subscriptions with Polar (issue #22, 2026-10-13)
What it is: Free and Pro plans for the Gmail agent, payments through Polar.sh (Merchant of Record). Owner decisions: the first stage after launch is the TESTERS phase, so everything is free at first: a server switch `app_settings.billing_enforced` (default `false`) gives every member every feature; the owner turns payments on with one SQL line. Free = automatic summaries, daily summary and the briefing card; Pro = scan and cross-check, calendar and tasks, e-mail briefing (and its test button). Polar talks to the Sandbox by default (`POLAR_SERVER` must be set to `production` on purpose); the page says "test payment, no real charge" while the environment is not production.

Deployed: `polar-webhook` v1 (no login; the proof is Polar's signature), `polar-billing` v1 (the member's session: checkout and customer portal), gmail-sync v19 (Pro checks in the scan, calendar and tasks, e-mail and test mail), migrations 016 (`subscriptions`, `polar_events`), 017 (`app_settings`), 018 (`polar_environment`), page version 20261013a. The owner has a permanent manual Pro grant (`source = manual`, never overwritten by a webhook).

| Layer | Test | Result |
|---|---|---|
| Pro rule (`entitlement.ts`) | live statuses until the period end plus 3 days, past_due only inside the grace, canceled/unpaid/unknown never, manual grant never expires; the three copies of the file are identical (a test fails if they differ); the page's copy equals the server rule on 3000 random rows | pass |
| Signature | valid with both readings of the secret; tampered body, wrong secret, wrong id or timestamp, v2 signature, replay older than 5 minutes, message from the future, bad header formats, missing secret all fail; several signatures in one header (key rotation) pass | pass |
| Events | a subscription event becomes our row for the member whose id we gave Polar (external id, metadata as fallback); anything else is ignored, never an exception; 3000 random payloads | pass |
| Handler (`webhook.test.ts`, fake database) | applied once; forged/unsigned/expired/unconfigured change nothing and leave no trace; the same message twice or three at once applies once; an old message never undoes a newer one; the owner's manual grant is never overwritten; a failed save gives the webhook id back and answers 500 so Polar retries; deleted member and foreign subscription are acknowledged; old ids are cleaned; chaos 40 worlds with random order, repeats, forged messages and failures: the stored state equals the newest valid message | 20 tests pass |
| Billing function | one product chosen by us, tagged with the member's own id; the member cannot pick plan, product, price or someone else's id; not configured asks nothing from Polar; an active subscriber cannot buy twice; Polar refusing or answering oddly never gives a made-up address; the portal opens only the member's own customer and refuses manual grants; sandbox unless production is chosen on purpose | 7 tests pass |
| Enforcement (`access.test.ts`) | scan 402 for Free, calendar and tasks not fetched and removed for Free, e-mail not sent to Free, test mail 402; everything open while billing is not enforced; a failing read is "cannot decide" (503 / skipped, nothing deleted or granted); chaos 60 worlds: a Free member never reaches a Pro feature, a Pro member always does | 7 tests pass |
| Mutation check | 20 deliberate breakages (signature always accepted, no replay window, any signature version, member id unchecked, duplicates applied twice, old events undo newer, manual grant overwritten, claim not given back, plan not allowlisted, double subscription, production by default, manual grant opens a portal, failed read grants Pro, a missing setting enforces billing, scan/e-mail/calendar not gated, active or past_due forever, null setting enforces) | every one made tests fail (one needed a stronger test first); restored all pass |
| Permissions | `rls_subscriptions_test.sql`: a member reads only their own row and only the safe columns (no Polar ids, no `select *`), cannot upgrade, insert, delete, or touch webhook ids or the billing switch; anon denied; an unknown member, an unknown status and a shared Polar subscription are refused; deleting a member removes the subscription | 21 lines, all good |
| Outside-in | webhook without a signature or with a forged one: 503 "not configured" (no secret yet, so nothing is trusted); the billing function with a garbage token: 401; a scheduled run after the deploy: normal, saved 1 new mail | as designed |
| Browser (real deployed functions, throw-away member, billing switched on for a minute) | Free: plan card "המסלול החינמי", upgrade button, sandbox note, scan locked, calendar/tasks and e-mail switch hidden, the upgrade button answered "payment not available yet"; Pro: "מנוי Pro פעיל, מתחדש ב-11.11.2026", manage button, scan open, calendar visible, manage answered the same message; no horizontal scroll; the switch was set back to false and the member deleted (the owner's data untouched: connection active, 70 summaries) | pass |

Not verified: anything that needs a real Polar account: creating a checkout, paying with the sandbox test card, receiving a real signed webhook, the customer portal. Everything up to Polar's door is tested with fakes shaped like Polar's documented answers.

## Two deep review passes over the work of 2026-10-12 and 13 (done alone, while the owner was away)
Method: read every changed file again line by line, ask "what happens in the real world when this fails halfway, arrives twice, arrives late, or is used by the wrong person", write the failing test first, fix, run all tests, run deliberate-breakage checks, deploy, probe the live functions, confirm the owner's account is untouched.

| # | Finding (pass) | Risk | Fix | Test |
|---|---|---|---|---|
| 1 | The webhook recorded the message id BEFORE saving, so a crash between the two would turn Polar's retry into a "duplicate" and a payment would be lost (1) | high | only finished messages are recorded; save is retried by Polar | failed-save and unfinished-message tests |
| 2 | Two webhook messages arriving at the same moment could leave the OLDER one on top (2) | medium | order-safe write: one conditional update (`modified_at <= incoming`), insert-then-update on a race | race test in both orders, with and without an existing row |
| 3 | A late "ended" message of an OLD subscription could switch off a NEWER live one (2) | medium | ignored while another live subscription is held | two tests |
| 4 | A member whose payment was being retried (`past_due`) or trialing could buy a second subscription (1) | medium | any live status blocks a new checkout | test |
| 5 | A scan that was already running kept going after the subscription ended (1) | low | the scan stops with "pro_required" (and waits when the access cannot be read) | test |
| 6 | Free members were still asked for calendar and tasks permissions they cannot use (1) | privacy | `gmail-connect` asks for Gmail only unless the member may use the rest | scope tests |
| 7 | With more than 50 opted-in members the morning e-mail could always pick the same 50 (1) | low | ordered by "mailed longest ago"; the fake database now sorts nulls like Postgres | order test |
| 8 | An all-day event lasting several days showed only on its first day; an overnight event disappeared after midnight (1) | medium (wrong briefing) | one row per relevant day; running events always count (server and page) | parse tests, page tests, 400 random worlds page = e-mail |
| 9 | Oversized webhook bodies were read before the signature check (1) | low | 413 above 256 KB, checked on the header and on the text | test |
| 10 | The payment page address from the server was only checked for https (2) | low | only `polar.sh` and its sub-domains are followed (server and page) | look-alike address tests |
| 11 | A failed read of the billing switch made the page show "beta" although the server might enforce (2) | UI honesty | the plan card is hidden and nothing is locked when the switch cannot be read | by design, browser-checked earlier |
| 12 | The page stayed stuck on "opening..." after coming back from Polar with the back button (2) | UX | `pageshow` re-enables the buttons | by reading |
| 13 | The e-mail sender name was Hebrew (some mail services refuse non-ASCII display names) (2) | delivery | ASCII default `Gmail Agent <onboarding@resend.dev>` | by reading |
| 14 | Resend's sandbox sender may only mail the address of the Resend account itself (2) | would look like a bug | written in `docs/BILLING.md` and the deferred list | n/a |
| 15 | Deleting a member does not cancel the Polar subscription (2) | money | written as a known gap with the exact decision needed (`docs/BILLING.md`) | n/a |
| 16 | Test bugs found on the way: a fixture shared between two tests, a fake database that ordered nulls wrongly, a lost template literal and a stray control character from my own shell commands (all caught by tests or by a control-character scan of the repository) | none | fixed | scan is clean |

Results after both passes: 232 unit tests pass; 11 more deliberate breakages (no duplicate shortcut, old subscription switches off the new one, no size limit, failed save recorded as done, past_due can buy twice, running scan not stopped, Free asked for calendar permission, digest order removed, all-day events saved for all days, overnight events dropped on the server and on the page) every one made tests fail; deployed gmail-sync v20, polar-webhook v2, polar-billing v2, gmail-connect v5; live probes: scheduled run 200 with the digests block, unsigned webhook 503 (no secret yet, so nothing is trusted), garbage tokens 401; the owner's connection stayed active, 70 summaries intact, billing still off, manual Pro grant in place.
## First sandbox payment attempt (2026-10-12): what was found
| Step | Result |
|---|---|
| Throw-away member on localhost, free plan | plan card shows "שדרג ל-Pro", scan locked (`billing_enforced=true` only during the test, set back to `false`) |
| Press "upgrade" | first answer 502 `checkout_failed`; the function swallowed Polar's reason |
| Fix 1 | logs now say why (Polar's error text or the SHAPE of the token, never a character of it); deployed as polar-billing v8 |
| Cause found | the Supabase secret held pasted text that was not the token (the copy button of the embedded browser pane did not fill the clipboard; the paste held an older text). Visible in the log as `token length 323, 237 unusual characters, starts like a Polar token: false` |
| Fix 2 | values are trimmed (a pasted newline/space makes `fetch` throw); 2 new tests; mutation check: removing the trim turns exactly those tests red (234 tests pass) |
| After pasting the real token (selected by triple-click, copied with Ctrl+C) | checkout answered 200 with a `sandbox.polar.sh` address; the page opened Polar's checkout (Gmail Agent Pro, 19 ILS / month) |
| Not done (deferred by the owner) | paying with the Polar test card, webhook delivery, Pro state, portal, cancellation |
| Cleanup | `billing_enforced=false`, throw-away member deleted (1 user, 1 connection, 1 subscription = the owner's manual grant), no leftover trigger, dev server stopped |
Lesson: with a secret stored in a dashboard, check its SHAPE from a log of the function, not by eye.
## Payment hardening, issue #24 (2026-10-12): tests first, then code
Order followed (test-driven): 1) 16 new tests written first and seen FAILING for the right reason (feature missing); 2) minimal code until green; 3) 12 deliberate breakages, each caught; 4) migration rehearsed inside a rolled-back transaction together with the permission test; 5) deploy; 6) live check; 7) cleanup.
| What | Result |
|---|---|
| Webhook: only OUR product counts (`other_product` / `no_product` ignored; 503 when `POLAR_PRODUCT_ID` is not configured; exact match) | tests + live: unsigned and forged messages answer 403 (so the product id is configured) |
| Webhook outcome log: one row per finished message (outcome, reason, member id, status, period end), never the payload, e-mail, name or secret | tests (whitelist of columns, forbidden strings, printed output) |
| Polar environment tag on every subscription row (`polar_server`); a row of the other environment never grants Pro, never blocks a purchase, and is replaced by the real message even when it looks newer; manual grants count everywhere; only the exact word `production` means production | tests in webhook, billing and access (4 copies of entitlement.ts identical, 2 copies of access.ts identical) |
| `polar-billing` action `info`: environment + price read from Polar (GET, trimmed token, 5 minute cache, failures never cached, hostile answers give no price, answer never contains token/product id) | 5 tests; LIVE: answered `sandbox`, 19.00 ILS per month |
| Page: price line and the "test payment" note follow the SERVER; when the server cannot tell, nothing is guessed and a Free member cannot start a payment | 3 tests + browser: card showed "מנוי Pro: 19 ₪ לחודש" and the note; with a forced failure the upgrade button and note were hidden and the message "פרטי התשלום לא זמינים כרגע" appeared; recovered on the next load; no horizontal scroll |
| Migration 019 (+ 7 permission checks, 28 lines all good/expected), advisors | only the known items (server-only tables INFO, `pg_net`, leaked-password protection) |
| Mutation checks | 12 of 12 caught (no product allowlist, stale row kept, tag not written, payload in the log, liveRow lenient x2, lenient word production, access ignores environment, checkout ignores environment, no price cache, any amount accepted, page claims unknown facts) |
| Whole suite | 251 pass, 0 fail |
| Cleanup | `billing_enforced=false`, throw-away member deleted (1 user, 1 connection, 1 subscription = the owner's manual grant), dev server stopped |
Deployed: polar-webhook v7, polar-billing v11, migration 019, page (logic.js?v=20261013c). **NOT yet deployed (no behaviour change while `POLAR_SERVER=sandbox`; deploy before production):** gmail-sync and gmail-connect (new `access.ts` and `entitlement.ts`). Not verified: Polar's real subscription payload (product id field names) - checked in the sandbox payment window (#25); if the allowlist ignores a real payment the outcome log shows `no_product` or `other_product`.
## Delete my account, issue #26 (2026-10-13): tests first, then code
| What | Result |
|---|---|
| New Edge Function `delete-account` (v1): order = 1) read the subscription row, 2) delete the Polar customer FIRST (`DELETE /v1/customers/{id}?anonymize=true`, scope `customers:write`; Polar then also ends the subscription), 3) Gmail data + subscription row, 4) Google token, 5) the member | 11 tests written first and seen FAILING (stub), then green; 8 deliberate breakages, all caught |
| Failure rules | Polar refuses/unreachable -> 502 and NOTHING deleted; no token but a Polar customer -> 503; failed read -> 500; a failed delete stops before the member is deleted; every step can be retried (Polar 404 = already gone); the owner's manual grant never touches Polar; the customer id is URL-encoded; the token is never printed |
| Page: button "מחק את החשבון שלי" with a confirm text (mentions the subscription for payers), Hebrew error texts, signs out after success; privacy page and terms updated | 2 new tests (53 page tests); page `logic.js?v=20261013d` |
| LIVE check on a throw-away member with a fake Polar customer id | no session -> 401; no confirm -> 400 and nothing deleted; confirm -> 200 `{ok:true, revoked:false}` (the fake Google token cannot be revoked, as expected); all of the member's rows and the member were gone, the owner's account untouched (1 user, manual Pro, his connection and summaries intact). Polar answered the fake customer with "not found", which also proves the token has the scope and the path is right |
| Whole suite | 264 pass, 0 fail |
| Not verified | deleting a REAL sandbox customer with an active subscription (needs the payment window #25): that Polar ends the subscription and anonymizes |