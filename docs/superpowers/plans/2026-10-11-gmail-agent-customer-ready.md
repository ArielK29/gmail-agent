# Gmail Agent: Customer-Ready Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Gmail agent safe to hand to real customers: tested logic, no cost runaway, resilient to model rate limits, and clear data-deletion wording.

**Architecture:** Pull the pure decisions of `gmail-sync` (text cleaning, charset decoding, parsing the model answer, retry/backoff and budget math) into one file with no Deno or network code (`logic.ts`), so Node can test it. `index.ts` keeps only I/O (Gmail, Gemini, Supabase). Costs are bounded by a per-member daily counter in a service-role-only table.

**Tech Stack:** Supabase Edge Functions (Deno, TypeScript), Postgres + RLS, Gemini API, plain HTML page on GitHub Pages. Tests: `node --test` (Node 24 runs `.ts` directly).

**Spec:** `docs/superpowers/specs/2026-10-11-gmail-agent-customer-ready-design.md` is not written yet. This plan is derived from `TODO.md` (section "נעשה ב-11.10.2026"), the edge-case table of 2026-10-11 and the mentor's edge-case list (retries on 429/5xx, cost cap per run/day, never re-process finished rows, sanitized logs).

## Global Constraints

- UI text on the page is Hebrew (RTL); code, comments and commits are English.
- Never store the email body. Only sender, subject, category, urgency, summary, suggested action.
- Emails and everything the model returns are untrusted: shown with `textContent`, links stripped.
- Every new table: RLS enabled in the same migration, `revoke all ... from anon, authenticated`, no policy unless the browser needs it.
- Never put keys in the repo. Secrets are set by the owner in Supabase.
- Edge Function deploy keeps `verify_jwt` as it is today (`gmail-sync` false and checks the caller itself).
- Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Any claim of success needs fresh evidence (test output, a cron run, a SQL result).

## Review Focus

1. Model answer with a duplicate id, a lowercase/uppercase `urgency` ("HIGH"), or an `action` that is only a link: expect a normal row (urgency normalized or `normal`, action empty, no link stored).
2. Email part with an unknown charset label (`x-unknown`) or none: expect UTF-8 decoding, never a crash.
3. Daily budget reached in the middle of a run: expect the remaining emails to stay pending, the history position NOT to advance, and no error shown to the member.
4. Gemini answers 429 once then 200: expect one retry and a normal result; 429 on every attempt: expect a readable "Gemini: ..." error and no lost emails.
5. Midnight rollover: the daily counter uses the UTC date, so a run at 23:59 UTC and one at 00:01 UTC use different rows.

---

## File Structure

| File | Responsibility |
|---|---|
| `supabase/functions/gmail-sync/logic.ts` (create) | Pure functions: `cleanText`, `decodeBytes`, `parseModelAnswer`, `isRetryable`, `backoffMs`, `remainingBudget`, `utcDay`. No Deno, no fetch. |
| `supabase/functions/gmail-sync/logic.test.ts` (create) | Node tests for everything in `logic.ts`. |
| `supabase/functions/gmail-sync/index.ts` (modify) | I/O only; imports from `./logic.ts`; adds retry loop and budget check. |
| `supabase/migrations/005_usage_budget.sql` (create) | Table `gmail_usage` (service role only). |
| `supabase/tests/rls_gmail_agent_test.sql` (modify) | Add checks for `gmail_usage`. |
| `docs/index.html` (modify) | Clearer wording for "delete all my data". |
| `TODO.md` (modify) | Record results. |

Run all tests with: `node --test supabase/functions/gmail-sync/logic.test.ts` (from the repo root `C:\Users\Korman\Новая папка\nCode-Exercises\gmail-agent`).

---

### Task 1: Pure logic module with tests

**Files:**
- Create: `supabase/functions/gmail-sync/logic.ts`
- Create: `supabase/functions/gmail-sync/logic.test.ts`
- Modify: `supabase/functions/gmail-sync/index.ts` (use the module)

**Interfaces:**
- Produces:
  - `cleanText(value: unknown, max: number): string`
  - `decodeBytes(bytes: Uint8Array, contentType: string): string`
  - `parseModelAnswer(text: string, knownIds: Set<string>): Map<string, Classified>`
  - `type Classified = { category: string; summary: string; urgency: string; action: string }`
  - `CATEGORIES: string[]`, `URGENCIES: string[]`

- [ ] **Step 1: Write the failing tests**

Create `supabase/functions/gmail-sync/logic.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanText, decodeBytes, parseModelAnswer } from './logic.ts';

test('cleanText removes links and cuts the length', () => {
  assert.equal(cleanText('לחץ https://evil.example/x עכשיו', 100), 'לחץ עכשיו');
  assert.equal(cleanText('www.evil.example', 100), '');
  assert.equal(cleanText('abcdef', 3), 'abc');
  assert.equal(cleanText(42, 10), '');
});

test('decodeBytes honors the charset and falls back to utf-8', () => {
  const win1255 = new Uint8Array([0xf9, 0xec, 0xe5, 0xed]); // "שלום" in windows-1255
  assert.equal(decodeBytes(win1255, 'text/plain; charset="windows-1255"'), 'שלום');
  const utf8 = new TextEncoder().encode('שלום');
  assert.equal(decodeBytes(utf8, 'text/plain'), 'שלום');
  assert.equal(decodeBytes(utf8, 'text/plain; charset=x-unknown'), 'שלום');
});

test('parseModelAnswer validates every field', () => {
  const answer = JSON.stringify([
    { id: 'a', category: 'work', summary: 'סיכום', urgency: 'HIGH', action: 'ענה https://x.example' },
    { id: 'b', category: 'nonsense', summary: 'עוד', urgency: 'low', action: '' },
    { id: 'zzz', category: 'work', summary: 'לא מוכר', urgency: 'low', action: '' },
    { id: 'a', category: 'finance', summary: 'כפילות', urgency: 'low', action: '' },
  ]);
  const result = parseModelAnswer(`noise ${answer} noise`, new Set(['a', 'b']));
  assert.equal(result.size, 2);
  assert.deepEqual(result.get('a'), { category: 'work', summary: 'סיכום', urgency: 'high', action: 'ענה' });
  assert.equal(result.get('b')?.category, 'other');
  assert.equal(result.has('zzz'), false);
});

test('parseModelAnswer returns an empty map for broken JSON', () => {
  assert.equal(parseModelAnswer('[{"id": "a"', new Set(['a'])).size, 0);
  assert.equal(parseModelAnswer('no json at all', new Set(['a'])).size, 0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test supabase/functions/gmail-sync/logic.test.ts`
Expected: FAIL (`Cannot find module './logic.ts'`).

- [ ] **Step 3: Write the minimal implementation**

Create `supabase/functions/gmail-sync/logic.ts`:

```ts
// Pure decisions of the Gmail agent. No Deno, no network: this file is tested with `node --test`.
export const CATEGORIES = ['important', 'personal', 'work', 'finance', 'newsletter', 'promotion', 'notification', 'other'];
export const URGENCIES = ['high', 'normal', 'low'];

export interface Classified {
  category: string;
  summary: string;
  urgency: string;
  action: string;
}

// The model's words come from untrusted email text: links are removed and the length is cut.
export function cleanText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(/(https?:\/\/|www\.)\S+/gi, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

// Old Hebrew emails often use windows-1255 / iso-8859-8: the part's own charset is honored, UTF-8 if unknown.
export function decodeBytes(bytes: Uint8Array, contentType: string): string {
  const charset = /charset="?([^";\s]+)/i.exec(contentType)?.[1] ?? 'utf-8';
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

// Reads the model's JSON answer. Anything that is not valid becomes "missing", never an exception:
// the caller gives missing emails a fallback row so a bad answer cannot block a run.
export function parseModelAnswer(text: string, knownIds: Set<string>): Map<string, Classified> {
  const result = new Map<string, Classified>();
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  let items: unknown = [];
  try {
    if (start >= 0 && end > start) items = JSON.parse(text.slice(start, end + 1));
  } catch {
    return result;
  }
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item.id !== 'string' || !knownIds.has(item.id) || result.has(item.id)) continue;
    const summary = cleanText(item.summary, 300);
    if (!summary) continue;
    const urgency = typeof item.urgency === 'string' && URGENCIES.includes(item.urgency.toLowerCase()) ? item.urgency.toLowerCase() : 'normal';
    result.set(item.id, {
      category: CATEGORIES.includes(item.category) ? item.category : 'other',
      summary,
      urgency,
      action: cleanText(item.action, 200),
    });
  }
  return result;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test supabase/functions/gmail-sync/logic.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Use the module in `index.ts` and deploy**

In `supabase/functions/gmail-sync/index.ts`: delete the local `CATEGORIES`, `URGENCIES`, `Classified`, `cleanText` and the answer-parsing block inside `classify`; add `import { CATEGORIES, URGENCIES, cleanText, decodeBytes, parseModelAnswer, type Classified } from './logic.ts';`. In `decodePart` replace the TextDecoder code with `return decodeBytes(bytes, partHeader(part, 'Content-Type'));`. In `classify` replace everything after `const text: string = ...` with `return parseModelAnswer(text, new Set(emails.map((email) => email.id)));` (keep the `console.error` for `finishReason` before it).

Deploy with the MCP `deploy_edge_function` with `files` = both `index.ts` and `logic.ts`, `entrypoint_path: index.ts`, `verify_jwt: false`.

- [ ] **Step 6: Verify against real data, then commit**

Run a cron cycle (wait for the next `*/10` run) and check: `select status_code, content from net._http_response order by created desc limit 1;` shows `"problems":[]`.

```bash
git add supabase/functions/gmail-sync/logic.ts supabase/functions/gmail-sync/logic.test.ts supabase/functions/gmail-sync/index.ts
git commit -m "refactor: move pure agent logic to a tested module"
```

---

### Task 2: Retry with backoff on Gemini 429/5xx

**Files:**
- Modify: `supabase/functions/gmail-sync/logic.ts`, `logic.test.ts`, `index.ts`

**Interfaces:**
- Consumes: Task 1 module.
- Produces: `isRetryable(status: number): boolean`, `backoffMs(attempt: number): number`, and in `index.ts` `callModel(body: string): Promise<Response>` (retries up to 3 times).

- [ ] **Step 1: Write the failing tests** (append to `logic.test.ts`)

```ts
import { isRetryable, backoffMs } from './logic.ts';

test('isRetryable only for rate limits and server errors', () => {
  assert.equal(isRetryable(429), true);
  assert.equal(isRetryable(503), true);
  assert.equal(isRetryable(400), false);
  assert.equal(isRetryable(401), false);
  assert.equal(isRetryable(200), false);
});

test('backoffMs doubles and is capped at 8 seconds', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(backoffMs), [500, 1000, 2000, 4000, 8000, 8000]);
});
```

- [ ] **Step 2: Run to verify it fails.** Run: `node --test supabase/functions/gmail-sync/logic.test.ts`. Expected: FAIL (`isRetryable` not exported).

- [ ] **Step 3: Implement** (append to `logic.ts`)

```ts
export const isRetryable = (status: number): boolean => status === 429 || (status >= 500 && status <= 599);
export const backoffMs = (attempt: number): number => Math.min(8000, 500 * 2 ** attempt);
```

- [ ] **Step 4: Run to verify it passes.** Expected: PASS, 6 tests.

- [ ] **Step 5: Use it in `index.ts`**

Add near `classify`:

```ts
// Rate limits and server errors of the model are retried a few times with growing pauses. The whole call stays well
// inside the 60 s budget of a scheduled run (0.5 + 1 + 2 seconds of waiting at most).
async function callModel(url: string, init: RequestInit): Promise<Response> {
  let response = await fetch(url, init);
  for (let attempt = 0; attempt < 3 && isRetryable(response.status); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, backoffMs(attempt)));
    response = await fetch(url, init);
  }
  return response;
}
```

and in `classify` replace `await fetch(` with `await callModel(` (same arguments). Import `isRetryable, backoffMs` from `./logic.ts`.

- [ ] **Step 6: Deploy (both files) and commit**

```bash
git add supabase/functions/gmail-sync/logic.ts supabase/functions/gmail-sync/logic.test.ts supabase/functions/gmail-sync/index.ts
git commit -m "feat: retry model calls with backoff on 429 and 5xx"
```

Not testable against the real API on demand: record in `TODO.md` that the retry path was only unit-tested.

---

### Task 3: Per-member daily budget (cost runaway)

**Files:**
- Create: `supabase/migrations/005_usage_budget.sql`
- Modify: `supabase/functions/gmail-sync/logic.ts`, `logic.test.ts`, `index.ts`, `supabase/tests/rls_gmail_agent_test.sql`

**Interfaces:**
- Consumes: Task 1 module.
- Produces: `remainingBudget(used: number, cap: number): number`, `utcDay(date: Date): string`, constant `MAX_EMAILS_PER_DAY = 300` in `index.ts`, table `public.gmail_usage(user_id uuid, day date, emails int)`.

- [ ] **Step 1: Write the failing tests** (append to `logic.test.ts`)

```ts
import { remainingBudget, utcDay } from './logic.ts';

test('remainingBudget never goes below zero', () => {
  assert.equal(remainingBudget(0, 300), 300);
  assert.equal(remainingBudget(250, 300), 50);
  assert.equal(remainingBudget(300, 300), 0);
  assert.equal(remainingBudget(999, 300), 0);
});

test('utcDay uses the UTC date, so midnight UTC starts a new row', () => {
  assert.equal(utcDay(new Date('2026-10-11T23:59:59Z')), '2026-10-11');
  assert.equal(utcDay(new Date('2026-10-12T00:00:01Z')), '2026-10-12');
});
```

- [ ] **Step 2: Run to verify it fails.** Expected: FAIL (`remainingBudget` not exported).

- [ ] **Step 3: Implement** (append to `logic.ts`)

```ts
export const remainingBudget = (used: number, cap: number): number => Math.max(0, cap - used);
export const utcDay = (date: Date): string => date.toISOString().slice(0, 10);
```

- [ ] **Step 4: Run to verify it passes.** Expected: PASS, 8 tests.

- [ ] **Step 5: Migration** (create `supabase/migrations/005_usage_budget.sql`, then apply it with the MCP `apply_migration`, name `usage_budget`)

```sql
-- How many emails the agent summarized for a member today (UTC). Service role only: the browser never touches it.
create table public.gmail_usage (
  user_id uuid not null references auth.users (id) on delete cascade,
  day date not null,
  emails integer not null default 0 check (emails >= 0),
  primary key (user_id, day)
);
alter table public.gmail_usage enable row level security;
revoke all on public.gmail_usage from anon, authenticated;
```

- [ ] **Step 4b: Run the security advisors and extend the RLS test file**

MCP `get_advisors` type `security`: the only new finding must be the expected INFO "RLS enabled, no policy" for `gmail_usage`. Append to `supabase/tests/rls_gmail_agent_test.sql`:

```sql
-- 7. the usage table is service-role only. Expected: ERROR 42501 permission denied for table gmail_usage
begin; set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', '<REAL_USER_ID>', 'role', 'authenticated')::text, true);
select * from public.gmail_usage;
rollback;
```

Run it through the MCP and confirm the error.

- [ ] **Step 5: Use the budget in `index.ts`**

Add `const MAX_EMAILS_PER_DAY = 300;` next to the other constants. In `syncOne`, after `pending` is computed and before `batch`:

```ts
  const day = utcDay(new Date());
  const { data: usage } = await admin.from('gmail_usage').select('emails').eq('user_id', connection.user_id).eq('day', day).maybeSingle();
  const allowed = remainingBudget(usage?.emails ?? 0, MAX_EMAILS_PER_DAY);
  const batch = pending.slice(0, Math.min(MAX_NEW_PER_RUN, allowed));
  const behind = pending.length > batch.length; // budget or per-run limit: the rest waits, the position does not move
```

(remove the old `const batch`/`const behind` lines). After the digest upsert succeeds, when `rows.length > 0`:

```ts
    await admin.from('gmail_usage').upsert({ user_id: connection.user_id, day, emails: (usage?.emails ?? 0) + rows.length }, { onConflict: 'user_id,day' });
```

Import `remainingBudget, utcDay` from `./logic.ts`.

- [ ] **Step 6: Deploy, verify, commit**

Verify with SQL: after a cron run that saved emails, `select * from public.gmail_usage;` (run as the service role through MCP) shows today's row with the saved count. Then:

```bash
git add supabase/migrations/005_usage_budget.sql supabase/functions/gmail-sync supabase/tests/rls_gmail_agent_test.sql
git commit -m "feat: per-member daily budget so a mailbox flood cannot run up the model bill"
```

---

### Task 4: Clear "delete all my data" wording

**Files:**
- Modify: `docs/index.html`

**Interfaces:** none (page text only).

- [ ] **Step 1: Change the button and the confirmation**

In `docs/index.html` change the disconnect button text from `נתק את Gmail` to `נתק את Gmail ומחק את הנתונים שלי`, and the `confirm(...)` text to `לנתק את Gmail ולמחוק את כל הסיכומים השמורים שלך? אי אפשר לשחזר.`

- [ ] **Step 2: Syntax check and verify live**

Run: `node --check` on the extracted page script (see the command used on 2026-10-11 in the session notes: extract the last `<script>` block to a temp file and run `node --check`). Expected: exit 0. After push, `Invoke-WebRequest https://arielk29.github.io/gmail-agent/` content contains `ומחק את הנתונים שלי`.

- [ ] **Step 3: Commit**

```bash
git add docs/index.html
git commit -m "feat: make the disconnect button say it deletes the member's data"
```

---

### Task 5: Owner-gated steps (no code, tracked here so they are not forgotten)

Each line needs the owner. Claude prepares and verifies; the owner pastes secrets and approves account changes.

- [ ] **Google sign-in:** Google Cloud: "Add secret" on `Web client 1`, copy; Supabase project `ppkbuyiatkxpfeqmvwzb`: Authentication > Sign In / Providers > Google: enable, Client IDs `936319620392-24je6ff5f91493ujq7riic77n9orv6qm.apps.googleusercontent.com`, paste the secret, Save. Verify: `GET /auth/v1/settings` returns `external.google: true`.
- [ ] **Paid Gemini tier** (decision): then update the Gemini paragraph in `docs/privacy.html` (the free tier lets human reviewers read content). Verify the live page shows the new text.
- [ ] **Audience:** owner sends the customers' Gmail addresses; Claude adds them as test users in Google Cloud > Audience (Testing mode, up to 100).
- [ ] **Delete the unused `ANTHROPIC_API_KEY`** (Supabase secret and the key in console.anthropic.com).
- [ ] **Domain** and Search Console verification (at the end, per the owner).

---

## Self-Review

**Spec coverage** (spec = `TODO.md` + edge-case table + mentor's list): tested logic (Task 1), retries/backoff on 429/5xx (Task 2), cost cap per day (Task 3), "never re-process finished rows" (already in code: skip rows already saved), sanitized logs (the code logs only `finishReason`, never email text: no task), deletion wording (Task 4), owner-gated items (Task 5). No gap found.

**Placeholder scan:** no TBD/TODO; every code step has code. The "spec" file named in the header does not exist; this is stated in the header, and the plan stands on `TODO.md` and the table.

**Type consistency:** `Classified`, `cleanText`, `decodeBytes`, `parseModelAnswer`, `isRetryable`, `backoffMs`, `remainingBudget`, `utcDay` have the same names and signatures in every task. `MAX_EMAILS_PER_DAY` is defined in Task 3 and used only there.

**Review Focus:** items 1 and 2 are tests in Task 1, item 4 in Task 2 (the pure part; the real 429 path is only unit-tested and recorded as such), item 5 in Task 3. Item 3 (budget hit mid-run) is covered by the `behind` logic and verified by reading the code path; it has no automated test because it needs the database, and the plan says so in Task 3 Step 6 (SQL verification only).
