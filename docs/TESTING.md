# How the Gmail agent is tested (and how to repeat it)

Last full run: **2026-10-11**, gmail-sync v10. Every line says what was run and what came out.

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
- A real Gemini `429` (it cannot be triggered on demand): only the fake-model test covers the retry loop.
- 30+ new emails in one run against real Gmail (the per-run limit is covered by `planBatch` tests only).
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