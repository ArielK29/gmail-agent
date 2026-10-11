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