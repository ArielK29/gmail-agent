# Gmail Agent: Fixes From the Browser End-to-End Run Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix every fault found by the end-to-end run of 2026-10-11 (Claude in Chrome on the local page, throw-away account), so a customer never sees raw English errors, a silent false success, or a message hidden from view.

**Architecture:** Move the page's pure decisions (error wording, form validation, empty-state text) into `docs/logic.js`, loaded by `index.html` and tested with `node --test`. Wrap login in a real `<form>`, add one visible notice area, and make the two server functions that swallow errors report them. Keep the browser run repeatable with seed and cleanup SQL.

**Tech Stack:** Plain HTML/JS page on GitHub Pages, Supabase Edge Functions (Deno), Postgres, `node --test`.

**Spec:** `docs/TESTING.md` (section "Browser end-to-end run", to be added in Task 6) and the findings table in the 2026-10-11 report. No separate design doc: every task below is a direct fix of one numbered finding.

## Global Constraints

- All text the customer sees is Hebrew (RTL). No raw English error text on the page, ever (CLAUDE.md of DuoFit: "Error messages in Hebrew with English fallback" is the sibling rule; here the fallback is a Hebrew generic message).
- Touch targets at least 48 px high.
- Code, comments and commits in English. Commits end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Never store the email body; never put keys in the repo.
- Emails and model output stay untrusted: shown with `textContent` only.
- Tests that cost money or change real data are NOT run on the owner's real account: use the throw-away account from `supabase/tests/e2e_seed.sql` (Task 6) and delete it afterwards. Ask the owner before any test that spends model quota on real mail.
- Fresh evidence before every success claim (test output, a SQL result, or a DOM reading from the browser).

## Review Focus

1. Supabase returns an error message the table does not know (a new English sentence): the page must show the generic Hebrew message, not English.
2. Login submitted with the Enter key, with only spaces in a field, or with a password manager filling the form: must behave like the button.
3. The `?gmail=cancelled|error|expired|connected` result while the member is signed out: the message must be visible.
4. A database error while loading the digest: the page must say it could not load, not "Gmail is not connected".
5. `gmail-disconnect` when one of the two deletes fails: the member must be told, and the token must not be dropped while summaries remain.

---

## File Structure

| File | Responsibility |
|---|---|
| `docs/logic.js` (create) | Pure functions: `authMessage`, `validateCredentials`, `problemMessage`, `emptyStateText`. Works in the browser (`window.AgentLogic`) and in Node. |
| `docs/logic.test.js` (create) | `node --test` tests for all of the above. |
| `docs/index.html` (modify) | Use `logic.js`; real `<form>`; one `#notice` area; 48 px footer links; load-error handling. |
| `supabase/functions/gmail-disconnect/index.ts` (modify) | Check both deletes, return `delete_failed`. |
| `supabase/functions/gmail-sync/index.ts` (modify) | Report failed usage/position writes instead of ignoring them. |
| `supabase/tests/e2e_seed.sql` (create) | Create and remove the throw-away test account and its rows. |
| `docs/TESTING.md` (modify) | Add the repeatable browser run and the rule "ask before touching real data or spending quota". |

Run page tests with: `node --test docs/logic.test.js` (repo root `C:\Users\Korman\Новая папка\nCode-Exercises\gmail-agent`).

---

### Task 1: Hebrew messages and form validation (findings 1, 4, 5)

**Files:** Create `docs/logic.js`, `docs/logic.test.js`.

**Interfaces:**
- Produces: `authMessage(error: {code?: string, message?: string} | null): string`, `validateCredentials(email: string, password: string): string | null`, `problemMessage(text: string): string`, `emptyStateText(state: {connected: boolean, expired: boolean}): string`.

- [ ] **Step 1: Write the failing tests** (create `docs/logic.test.js`)

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { authMessage, validateCredentials, problemMessage, emptyStateText } = require('./logic.js');

test('authMessage maps the Supabase errors seen in the browser run', () => {
  assert.equal(authMessage({ message: 'Invalid login credentials' }), 'האימייל או הסיסמה שגויים.');
  assert.equal(authMessage({ message: 'missing email or phone' }), 'יש למלא אימייל וסיסמה.');
  assert.equal(authMessage({ message: 'Anonymous sign-ins are disabled' }), 'יש למלא אימייל וסיסמה.');
  assert.equal(authMessage({ message: 'Email not confirmed' }), 'צריך לאשר את כתובת האימייל. בדוק את תיבת הדואר.');
  assert.equal(authMessage({ message: 'User already registered' }), 'כבר קיים חשבון עם האימייל הזה. נסה להתחבר.');
  assert.equal(authMessage({ message: 'Password should be at least 6 characters.' }), 'הסיסמה קצרה מדי (לפחות 6 תווים).');
  assert.equal(authMessage({ code: 'over_email_send_rate_limit', message: 'email rate limit exceeded' }), 'נשלחו יותר מדי ניסיונות. נסה שוב בעוד כמה דקות.');
  assert.equal(authMessage({ message: 'Failed to fetch' }), 'אין חיבור לאינטרנט. נסה שוב.');
});

test('authMessage never shows English, even for an error it does not know', () => {
  for (const error of [{ message: 'Some brand new English sentence' }, {}, null, undefined, { code: 'weird_code' }]) {
    assert.doesNotMatch(authMessage(error), /[A-Za-z]/);
  }
});

test('validateCredentials checks the form before the server is asked', () => {
  assert.equal(validateCredentials('', ''), 'יש להכניס אימייל.');
  assert.equal(validateCredentials('   ', 'x'), 'יש להכניס אימייל.');
  assert.equal(validateCredentials('not-an-email', 'x'), 'כתובת האימייל לא תקינה.');
  assert.equal(validateCredentials('a@b.co', ''), 'יש להכניס סיסמה.');
  assert.equal(validateCredentials(' a@b.co ', 'secret'), null);
});

test('problemMessage translates what the sync function reports', () => {
  assert.equal(problemMessage('access was revoked or expired: connect Gmail again'), 'החיבור ל-Gmail פג. חבר את Gmail מחדש.');
  assert.match(problemMessage('Gemini: quota exceeded'), /שירות הסיכום/);
  assert.match(problemMessage('Gmail: Backend Error'), /Gmail לא ענה/);
  assert.match(problemMessage('Google token: server_error'), /Google/);
  assert.equal(problemMessage('could not save'), 'לא הצלחנו לשמור את הסיכומים. ננסה שוב אוטומטית.');
  assert.doesNotMatch(problemMessage('something nobody planned for'), /[A-Za-z]/);
});

test('emptyStateText follows the real connection state', () => {
  assert.equal(emptyStateText({ connected: false, expired: false }), 'חבר את Gmail כדי להתחיל לקבל סיכומים.');
  assert.equal(emptyStateText({ connected: true, expired: true }), 'החיבור פג. חבר שוב כדי להמשיך.');
  assert.equal(emptyStateText({ connected: true, expired: false }), 'עוד אין מיילים. לחץ "בדוק מיילים חדשים עכשיו".');
});
```

- [ ] **Step 2: Run to verify it fails.** Run: `node --test docs/logic.test.js`. Expected: FAIL (`Cannot find module './logic.js'`).

- [ ] **Step 3: Write the implementation** (create `docs/logic.js`)

```js
// Pure UI decisions of the Gmail agent page. Loaded by index.html (window.AgentLogic) and tested with `node --test`.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AgentLogic = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const GENERIC = 'משהו השתבש. נסה שוב בעוד רגע.';

  // First match wins. The text is lower-cased code + message of the Supabase auth error.
  const AUTH_RULES = [
    [/invalid login credentials/, 'האימייל או הסיסמה שגויים.'],
    [/missing email|anonymous sign-ins are disabled/, 'יש למלא אימייל וסיסמה.'],
    [/email not confirmed/, 'צריך לאשר את כתובת האימייל. בדוק את תיבת הדואר.'],
    [/already registered|already been registered/, 'כבר קיים חשבון עם האימייל הזה. נסה להתחבר.'],
    [/password should be at least/, 'הסיסמה קצרה מדי (לפחות 6 תווים).'],
    [/unable to validate email|invalid email/, 'כתובת האימייל לא תקינה.'],
    [/rate limit|too many requests/, 'נשלחו יותר מדי ניסיונות. נסה שוב בעוד כמה דקות.'],
    [/failed to fetch|networkerror|load failed/, 'אין חיבור לאינטרנט. נסה שוב.'],
  ];

  function authMessage(error) {
    const text = ((error && error.code) || '') + ' ' + ((error && error.message) || '');
    const lower = text.toLowerCase();
    for (const [pattern, message] of AUTH_RULES) if (pattern.test(lower)) return message;
    return GENERIC;
  }

  function validateCredentials(email, password) {
    const e = String(email || '').trim();
    if (!e) return 'יש להכניס אימייל.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return 'כתובת האימייל לא תקינה.';
    if (!password) return 'יש להכניס סיסמה.';
    return null;
  }

  // The sync function reports short English reasons (useful in logs); the page shows Hebrew.
  function problemMessage(text) {
    const t = String(text || '');
    if (t.startsWith('access was revoked')) return 'החיבור ל-Gmail פג. חבר את Gmail מחדש.';
    if (t.startsWith('Gemini:')) return 'שירות הסיכום לא זמין כרגע או הגיע למכסה. ננסה שוב אוטומטית.';
    if (t.startsWith('Gmail:')) return 'Gmail לא ענה כרגע. ננסה שוב אוטומטית.';
    if (t.startsWith('Google token')) return 'לא הצלחנו להתחבר ל-Google כרגע. ננסה שוב אוטומטית.';
    if (t.startsWith('could not save')) return 'לא הצלחנו לשמור את הסיכומים. ננסה שוב אוטומטית.';
    return GENERIC;
  }

  function emptyStateText(state) {
    if (!state.connected) return 'חבר את Gmail כדי להתחיל לקבל סיכומים.';
    if (state.expired) return 'החיבור פג. חבר שוב כדי להמשיך.';
    return 'עוד אין מיילים. לחץ "בדוק מיילים חדשים עכשיו".';
  }

  return { authMessage, validateCredentials, problemMessage, emptyStateText };
});
```

- [ ] **Step 4: Run to verify it passes.** Run: `node --test docs/logic.test.js`. Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add docs/logic.js docs/logic.test.js
git commit -m "feat: Hebrew messages and form validation for the page, tested in Node"
```

---

### Task 2: Wire the page: real form, one visible notice, 48 px links (findings 1-8)

**Files:** Modify `docs/index.html`.

**Interfaces:** Consumes `window.AgentLogic` from Task 1.

- [ ] **Step 1: Load the module.** In `docs/index.html`, add `<script src="logic.js"></script>` immediately before the inline `<script>` that starts with `const { supabaseUrl, supabaseKey } = window.APP_CONFIG;`.

- [ ] **Step 2: Make login a real form.** Replace the login card's inputs and buttons so the card is:

```html
<section id="login" class="card">
  <form id="loginForm" novalidate>
    <label for="email">אימייל</label>
    <input id="email" type="email" autocomplete="username" />
    <label for="password">סיסמה</label>
    <input id="password" type="password" autocomplete="current-password" />
    <div class="row">
      <button id="signIn" type="submit">התחברות</button>
      <button id="signUp" type="button" class="secondary">יצירת חשבון</button>
    </div>
  </form>
  <div class="divider"><span>או</span></div>
  <button id="google" class="google" type="button"> ...existing Google button content... </button>
  <div id="loginStatus" class="status" role="alert"></div>
</section>
```

- [ ] **Step 3: Add one notice area** that exists in both states, directly under `<h1>`/`<p class="sub">`: `<div id="notice" class="status" role="status"></div>`. Add a helper in the script: `const notify = (text) => { $('notice').textContent = text; };` and replace every write to `$('status').textContent` with `notify(...)`. Keep `$('connection')` for the connection banner.

- [ ] **Step 4: Use the Hebrew helpers.** In `authAction(kind)` start with:

```js
const problem = window.AgentLogic.validateCredentials($('email').value, $('password').value);
if (problem) { $('loginStatus').textContent = problem; return; }
```
and replace `'לא הצלחנו: ' + error.message` with `window.AgentLogic.authMessage(error)` (also in the Google button handler). In the check-now handler replace `'הבדיקה נכשלה: ' + result.problems.join(' | ')` with `result.problems.map(window.AgentLogic.problemMessage).join(' ')` and in the `catch (e)` blocks use `window.AgentLogic.problemMessage('')` for the generic text. Wire the form: `$('loginForm').addEventListener('submit', (event) => { event.preventDefault(); authAction('in'); });` and remove the old `$('signIn').onclick`.

- [ ] **Step 5: Empty state and load errors.** In `renderDigest` replace the hard-coded empty-state sentence with `window.AgentLogic.emptyStateText(connectionState)`, where `connectionState = { connected, expired }` is stored in a module-level `let` by `refresh()`. In `refresh()` check `error` of both selects: on error call `notify('לא הצלחנו לטעון את הנתונים. רענן את הדף.')` and return, without touching the connection banner.

- [ ] **Step 6: Touch targets.** Add to the page CSS: `footer a, .footer a { display: inline-block; padding: 14px 10px; min-height: 48px; box-sizing: border-box; }` and give the footer paragraph a class `footer`.

- [ ] **Step 7: Verify.**
  - `node --test docs/logic.test.js` passes; extract the inline script and run `node --check` on it.
  - Browser run (Task 6 procedure) on the local page as the throw-away user: empty sign-in shows "יש להכניס אימייל."; wrong password shows "האימייל או הסיסמה שגויים."; pressing Enter in the password field signs in (dispatch a real `keydown` Enter); `?gmail=cancelled` while signed out shows "החיבור בוטל." in `#notice` and `#notice.offsetParent` is not null; footer links report `height >= 48`.

- [ ] **Step 8: Commit and push.**

```bash
git add docs/index.html
git commit -m "fix: real login form, Hebrew errors, visible notice, 48px links, honest load errors"
git push
```

---

### Task 3: Server writes that must not fail silently (finding 7)

**Files:** Modify `supabase/functions/gmail-disconnect/index.ts`, `supabase/functions/gmail-sync/index.ts`, `docs/index.html`.

- [ ] **Step 1: gmail-disconnect.** Replace the two unchecked deletes with:

```ts
  const digest = await admin.from('gmail_digest').delete().eq('user_id', userId);
  if (digest.error) return reply(500, { error: 'delete_failed' }); // keep the token: the member can try again
  const connectionDelete = await admin.from('gmail_connections').delete().eq('user_id', userId);
  if (connectionDelete.error) return reply(500, { error: 'delete_failed' });
  return reply(200, { ok: true, revoked });
```

- [ ] **Step 2: Page.** In the disconnect handler's `catch` use `notify('לא הצלחנו למחוק. נסה שוב.')`; in `callFunction` keep returning the server's `error` string, so the catch shows the Hebrew text above for `delete_failed`.

- [ ] **Step 3: gmail-sync.** After the usage upsert and the position/last-checked update, capture `.error`; when the usage upsert fails `console.error('usage write failed')` and return `{ saved: rows.length, error: 'could not save usage' }`; when the position update fails return `{ saved: rows.length, error: 'could not save' }`. (Never log email text.)

- [ ] **Step 4: Verify with the throw-away account.** Seed (Task 6), then in SQL temporarily make the delete fail: `alter table public.gmail_connections add constraint e2e_block_delete check (false) not valid;` is not enough for DELETE, so use a trigger instead:

```sql
create function public.e2e_block_delete() returns trigger language plpgsql as $$ begin raise exception 'e2e: blocked'; end $$;
create trigger e2e_block before delete on public.gmail_digest for each row execute function public.e2e_block_delete();
```
Click "נתק" as the throw-away user: expect the Hebrew failure message and the connection row still present. Then drop the trigger and the function and repeat: expect success and both rows gone. Record both results in `docs/TESTING.md`.

- [ ] **Step 5: Deploy** `gmail-disconnect` and `gmail-sync` (both files for sync: `index.ts` and `logic.ts`) with the MCP `deploy_edge_function`, keeping `verify_jwt` as today. **Commit and push.**

```bash
git add supabase/functions docs/index.html
git commit -m "fix: report failed deletes and writes instead of silent success"
git push
```

---

### Task 4: Hebrew generic message for unknown server answers (finding 4, Review Focus 1)

Already covered by `authMessage` and `problemMessage` returning the generic Hebrew text. This task only adds the guard test for the page wiring.

- [ ] **Step 1:** Add to `docs/logic.test.js`:

```js
test('every message the page can show is Hebrew only', () => {
  const samples = ['', 'x', 'Gemini: ???', 'Gmail: 500', 'Google token: boom', 'could not save usage', 'delete_failed'];
  for (const sample of samples) assert.doesNotMatch(problemMessage(sample), /[A-Za-z]/);
});
```
- [ ] **Step 2:** Run `node --test docs/logic.test.js`: PASS (6 tests). **Commit:** `git commit -am "test: guard that no English reaches the customer"`.

---

### Task 5: Known gaps recorded with a decision, not fixed now

- [ ] Add to `TODO.md` under a new section "ידוע, לא תוקן" with one line each and the reason:
  - Race between "disconnect" and a sync running at the same moment (summaries can reappear for seconds). Low impact; fix by a per-member lock if customers report it.
  - The Google token is not revoked when an auth user is deleted from Supabase. There is no in-app account deletion for the agent yet; add it together with the first real customer (revoke first, then delete).
  - Rare foreign-script characters inside a Hebrew summary (a Thai letter was seen once). Model glitch; add a script filter only if it repeats.
  - The sign-up flow (account creation and confirmation e-mail) was not exercised: it needs custom SMTP (DuoFit issue #86).
- [ ] **Commit:** `git commit -am "docs: record known gaps with reasons"`.

---

### Task 6: Make the browser run repeatable and safe

**Files:** Create `supabase/tests/e2e_seed.sql`; modify `docs/TESTING.md`.

- [ ] **Step 1: Create `supabase/tests/e2e_seed.sql`** with three blocks, each run on its own through the MCP `execute_sql`:

```sql
-- 1. SEED: throw-away member, a fake connection and three digest rows. Replace <PASSWORD> with a fresh random one.
with u as (
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change)
  values ('00000000-0000-4000-8000-0000000000bb', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'e2e-browser-test@invalid.example', extensions.crypt('<PASSWORD>', extensions.gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', '')
  returning id)
insert into auth.identities (id, user_id, identity_data, provider, provider_id, created_at, updated_at, last_sign_in_at)
select gen_random_uuid(), id, json_build_object('sub', id::text, 'email', 'e2e-browser-test@invalid.example', 'email_verified', true)::jsonb, 'email', id::text, now(), now(), now() from u;
insert into public.gmail_connections (user_id, google_email, refresh_token, status, last_checked_at, history_id)
values ('00000000-0000-4000-8000-0000000000bb', 'e2e-browser-test@invalid.example', 'bogus-refresh-token-for-e2e-test', 'active', now() - interval '1 hour', '1');
insert into public.gmail_digest (user_id, gmail_message_id, from_name, subject, category, summary, urgency, suggested_action, received_at) values
 ('00000000-0000-4000-8000-0000000000bb', 'e2e-1', 'בנק בדיקה <bank@example.com>', 'חיוב חריג', 'finance', 'חיוב חריג בכרטיס האשראי.', 'high', 'בדוק את החיוב', now()),
 ('00000000-0000-4000-8000-0000000000bb', 'e2e-2', 'חנות <promo@example.com>', 'מבצע', 'promotion', 'מבצע על מוצרים.', 'low', null, now() - interval '1 hour'),
 ('00000000-0000-4000-8000-0000000000bb', 'e2e-3', 'חבר <friend@example.com>', 'נפגשים?', 'personal', 'חבר שואל אם נפגשים.', null, null, now() - interval '2 hours');

-- 2. CLEANUP (always run at the end; cascades to the connection, digest and usage rows)
delete from auth.users where id = '00000000-0000-4000-8000-0000000000bb' and email = 'e2e-browser-test@invalid.example';

-- 3. CHECK that nothing is left. Expected: 1 user (the owner), 1 connection, and the owner's digest rows unchanged
select (select count(*) from auth.users) as users, (select count(*) from public.gmail_connections) as connections;
```

- [ ] **Step 2: Add to `docs/TESTING.md`** a section "Browser end-to-end run" with: start `node dev-server.js` (port 5174), sign in on `http://localhost:5174` only (never type a password on the live site), use `form_input` for the fields when the tab is in the background, click through `.click()` for buttons, read results from the DOM as plain text (the tool blocks fields named like secrets), always run the cleanup block and stop the server. Add the **safety rule**: "Ask the owner before any test that spends model quota on real mail or changes the owner's real rows; prefer the throw-away member." List what was run on 2026-10-11 and its result (empty and wrong login, Google button message, connect URL check, cooldown, expired access banner, disconnect, callback redirects, unauthenticated calls, 375 px layout).

- [ ] **Step 3: Verify:** run block 1, sign in on the local page with the new password, see 3 rows, run block 2, run block 3. Expected output of block 3: `users = 1`, `connections = 1`.

- [ ] **Step 4: Commit:** `git add supabase/tests/e2e_seed.sql docs/TESTING.md && git commit -m "test: repeatable throw-away account for browser runs, with the safety rule" && git push`.

---

## Relationship to the other open work

Issues of this plan (repo `ArielK29/gmail-agent`): [#1](https://github.com/ArielK29/gmail-agent/issues/1) Task 1, [#2](https://github.com/ArielK29/gmail-agent/issues/2) Task 2, [#3](https://github.com/ArielK29/gmail-agent/issues/3) Task 3, [#4](https://github.com/ArielK29/gmail-agent/issues/4) Task 4, [#5](https://github.com/ArielK29/gmail-agent/issues/5) Task 5, [#6](https://github.com/ArielK29/gmail-agent/issues/6) Task 6.

| Open issue (repo `ArielK29/DuoFit`) | How it is connected to this plan |
|---|---|
| [#86](https://github.com/ArielK29/DuoFit/issues/86) Custom SMTP (needs a domain) | The sign-up flow (account creation and confirmation e-mail) of the Gmail agent could not be exercised and depends on it (Task 5, known gap). The same domain also serves the points below, so buy it once. |
| [#12](https://github.com/ArielK29/DuoFit/issues/12) Release readiness | Needs a public privacy-policy URL: the agent's `privacy.html` is the template. The "no silent failure in write paths" check of Task 3 is also a release check. The custom domain of Vercel and the Google OAuth verification (home page and privacy page on a verified domain) need the same domain as #86. |
| [#11](https://github.com/ArielK29/DuoFit/issues/11) Cross-device, RTL and dark-mode bug bash | Reuse Task 6's browser run on the DuoFit web build with a throw-away DuoFit member: raw English errors (DuoFit already has `lib/authErrors.ts`, the model for Task 1), silent false success in the 16 write calls of `lib/remote*.ts` and `hooks/useAuth.ts`, 48 px targets, 375 px layout, dead buttons. The part that needs a real iPhone stays in #11. |
| [#25](https://github.com/ArielK29/DuoFit/issues/25) PostHog Session Replay | Not connected (needs a Development Build). Listed so nobody looks for a link. |

Owner steps still open from the previous plan (Google provider secret in Supabase, customers' addresses for Audience, paid Gemini decision) are not in this plan; the privacy page already warns customers about the free tier.
## Self-Review

**Spec coverage:** findings 1 (English errors), 2 (not a form), 3 (empty-state text), 4 (English server messages), 5 (message hidden when signed out), 6 (48 px links), 7 (silent writes and ignored load errors) each map to Tasks 1, 2, 3 and 4; the known gaps are Task 5; repeatability and the safety rule are Task 6. No finding is left without a task.

**Placeholder scan:** no TBD/TODO; every code step shows code. The only substituted value is `<PASSWORD>` in the seed, which must be generated fresh by the person running it.

**Type consistency:** `authMessage`, `validateCredentials`, `problemMessage`, `emptyStateText` have the same names and signatures in the tests, the module and the page wiring. The seed uses the same fixed throw-away id and e-mail as the cleanup block.

**Review Focus:** 1 and 5 are covered by Task 1/4 tests and the Task 3 trigger test; 2 and 3 by the Task 2 browser checks; 4 by Task 2 Step 5 (verified by temporarily revoking `select` on `gmail_digest` for `authenticated` in a throw-away transaction is not possible through the page, so it is verified by reading the code path and recorded as such in `docs/TESTING.md`).

