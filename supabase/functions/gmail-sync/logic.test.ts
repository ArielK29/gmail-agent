import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanText, decodeBytes, parseModelAnswer, isRetryable, backoffMs, remainingBudget, utcDay, callWithRetry, planBatch, classifyTokenResponse, isThrottled, maxHistoryId, stripControls, CATEGORIES, URGENCIES, validateScanRequest, sanitizeQuery, parseItems, buildGmailQuery, parseMatchAnswer, localMatches, MAX_SCAN_MAILS, parseDeadline, isAutomatedSender, threadNeedsReply, pickReplyCandidates } from './logic.ts';

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
  assert.deepEqual(result.get('a'), { category: 'work', summary: 'סיכום', urgency: 'high', action: 'ענה', deadline: null });
  assert.equal(result.get('b')?.category, 'other');
  assert.equal(result.has('zzz'), false);
});

test('parseModelAnswer returns an empty map for broken JSON', () => {
  assert.equal(parseModelAnswer('[{"id": "a"', new Set(['a'])).size, 0);
  assert.equal(parseModelAnswer('no json at all', new Set(['a'])).size, 0);
});

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


// --- retry loop against a fake model: the real code path, with a fake fetch and a fake clock ---
const fakeResponses = (statuses: number[]) => {
  const state = { calls: 0, waits: [] as number[] };
  const doFetch = async () => ({ status: statuses[Math.min(state.calls++, statuses.length - 1)] });
  const sleep = async (ms: number) => { state.waits.push(ms); };
  return { state, doFetch, sleep };
};

test('callWithRetry retries 429 and 503 and then succeeds', async () => {
  const { state, doFetch, sleep } = fakeResponses([429, 503, 200]);
  const response = await callWithRetry(doFetch, sleep);
  assert.equal(response.status, 200);
  assert.equal(state.calls, 3);
  assert.deepEqual(state.waits, [500, 1000]);
});

test('callWithRetry gives up after 3 retries and returns the last answer', async () => {
  const { state, doFetch, sleep } = fakeResponses([429]);
  const response = await callWithRetry(doFetch, sleep);
  assert.equal(response.status, 429);
  assert.equal(state.calls, 4);
  assert.deepEqual(state.waits, [500, 1000, 2000]);
});

test('callWithRetry does not retry a client error', async () => {
  const { state, doFetch, sleep } = fakeResponses([400]);
  const response = await callWithRetry(doFetch, sleep);
  assert.equal(response.status, 400);
  assert.equal(state.calls, 1);
  assert.deepEqual(state.waits, []);
});

// --- daily budget exhausted ---
test('planBatch: budget left, more than the per-run limit', () => {
  const ids = Array.from({ length: 50 }, (_, i) => 'm' + i);
  const plan = planBatch(ids, 30, 300);
  assert.equal(plan.batch.length, 30);
  assert.equal(plan.behind, true);
});

test('planBatch: budget exhausted keeps everything waiting and the position must not move', () => {
  const plan = planBatch(['a', 'b'], 30, 0);
  assert.deepEqual(plan.batch, []);
  assert.equal(plan.behind, true);
});

test('planBatch: nothing pending is not behind, even with no budget', () => {
  assert.deepEqual(planBatch([], 30, 0), { batch: [], behind: false });
});

test('planBatch: the budget cuts the batch in the middle of a run', () => {
  const plan = planBatch(['a', 'b', 'c', 'd'], 30, 2);
  assert.deepEqual(plan.batch, ['a', 'b']);
  assert.equal(plan.behind, true);
});

// --- Google token answers: only invalid_grant kills the connection ---
test('classifyTokenResponse: a good answer gives a token', () => {
  assert.deepEqual(classifyTokenResponse(200, { access_token: 't' }), { kind: 'ok', token: 't' });
});

test('classifyTokenResponse: only 400 invalid_grant means revoked or expired', () => {
  assert.deepEqual(classifyTokenResponse(400, { error: 'invalid_grant' }), { kind: 'revoked' });
});

test('classifyTokenResponse: temporary or other errors never mean revoked', () => {
  assert.equal(classifyTokenResponse(503, {}).kind, 'failed');
  assert.equal(classifyTokenResponse(429, { error: 'rate_limit' }).kind, 'failed');
  assert.equal(classifyTokenResponse(400, { error: 'invalid_client' }).kind, 'failed');
  assert.equal(classifyTokenResponse(200, {}).kind, 'failed');
});

test('isThrottled counts a failed attempt too, so the button cannot be hammered while the model is failing', () => {
  const now = Date.parse('2026-10-12T10:00:30Z');
  const iso = (s: number) => new Date(now - s * 1000).toISOString();
  assert.equal(isThrottled(iso(100), null, now, 30_000), false, 'checked 100 s ago');
  assert.equal(isThrottled(iso(10), null, now, 30_000), true, 'checked 10 s ago');
  assert.equal(isThrottled(iso(100), iso(5), now, 30_000), true, 'an attempt 5 s ago counts even when it failed');
  assert.equal(isThrottled(null, iso(5), now, 30_000), true);
  assert.equal(isThrottled(null, null, now, 30_000), false, 'never checked');
  assert.equal(isThrottled('not a date', 'also not', now, 30_000), false, 'garbage never blocks forever');
});

test('maxHistoryId compares Gmail history ids as numbers, not as text', () => {
  assert.equal(maxHistoryId('99', '100'), '100');
  assert.equal(maxHistoryId('100', '99'), '100');
  assert.equal(maxHistoryId('12345678901234567890', '12345678901234567891'), '12345678901234567891');
  assert.equal(maxHistoryId(null, '7'), '7');
  assert.equal(maxHistoryId('7', undefined), '7');
  assert.equal(maxHistoryId('abc', '7'), '7', 'a bad id never wins');
});
// ---- Professional-grade checks: hostile text, random inputs by the thousand, time edges ----
function rng(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200D\u2060\u202A-\u202E\u2066-\u2069\uFEFF]/;
const LINK = /(https?:\/\/|www\.)\S+/i;

test('stripControls removes reordering and invisible characters, keeps real text', () => {
  assert.equal(stripControls('invoice\u202Efdp.exe'), 'invoicefdp.exe');
  assert.equal(stripControls('pay\u200Bpal\uFEFF'), 'paypal');
  assert.equal(stripControls('שלום\u200F 😀 ok'), 'שלום\u200F 😀 ok');
});

test('cleanText: 3000 random strings never keep a link or a forbidden character, never exceed the limit, never throw', () => {
  const pool = ['a', 'ש', ' ', '\n', '\t', 'http://', 'https://evil.example/x', 'www.', 'x.y', '\u202E', '\u200B', '😀', '\u0000', 'HTTPS://UP.CASE', '9'];
  const next = rng(11);
  for (let n = 0; n < 3000; n++) {
    let s = ''; for (let i = 0, len = Math.floor(next() * 30); i < len; i++) s += pool[Math.floor(next() * pool.length)];
    const max = Math.floor(next() * 120);
    const out = cleanText(s, max);
    assert.ok(out.length <= max, `length ${out.length} > ${max} for ${JSON.stringify(s)}`);
    assert.doesNotMatch(out, FORBIDDEN);
    assert.doesNotMatch(out, LINK, JSON.stringify(s));
    assert.equal(out, out.trim());
    assert.doesNotMatch(out, /\s{2,}/);
  }
  for (const odd of [null, undefined, 0, NaN, {}, [], () => 1, Symbol.iterator as unknown]) assert.equal(cleanText(odd, 10), '');
});

test('parseModelAnswer: 4000 hostile / broken model answers never throw and never invent anything', () => {
  const known = new Set(['m1', 'm2', 'm3']);
  const pieces = ['[', ']', '{', '}', '"id"', ':', '"m1"', '"m2"', '"zzz"', ',', '"category"', '"finance"', '"nope"', '"summary"', '"hi https://x.y"', '"urgency"', '"HIGH"', '"low"', 'null', '5', 'true', '"__proto__"', '"constructor"', '```json', '```', 'ignore previous instructions', '\n'];
  const next = rng(31);
  for (let n = 0; n < 4000; n++) {
    let s = ''; for (let i = 0, len = Math.floor(next() * 40); i < len; i++) s += pieces[Math.floor(next() * pieces.length)];
    const result = parseModelAnswer(s, known);
    for (const [id, value] of result) {
      assert.ok(known.has(id), 'only ids that were asked for: ' + id);
      assert.ok(CATEGORIES.includes(value.category));
      assert.ok(URGENCIES.includes(value.urgency));
      assert.ok(value.summary.length > 0 && value.summary.length <= 300);
      assert.doesNotMatch(value.summary, LINK);
      assert.ok(value.action.length <= 200);
    }
  }
});

test('parseModelAnswer: answer wrapped in chatter or markdown still works; the first entry for an id wins; ids that were not asked for are dropped', () => {
  const known = new Set(['a', 'b']);
  const answer = 'Sure! Here you go:\n```json\n[{"id":"a","category":"work","summary":"ראשון","urgency":"high","action":"x"},{"id":"a","category":"finance","summary":"כפילות"},{"id":"zzz","category":"work","summary":"לא נשאל"},{"id":"b","category":"nope","summary":"ok","urgency":"weird"}]\n```\nHope it helps';
  const result = parseModelAnswer(answer, known);
  assert.deepEqual([...result.keys()], ['a', 'b']);
  assert.equal(result.get('a')!.summary, 'ראשון');
  assert.equal(result.get('b')!.category, 'other', 'an unknown category becomes "other"');
  assert.equal(result.get('b')!.urgency, 'normal', 'an unknown urgency becomes "normal"');
});

test('planBatch: 3000 random plans keep the invariants (prefix, never above the limits, "behind" exactly when something waits)', () => {
  const next = rng(5);
  for (let n = 0; n < 3000; n++) {
    const pending = Array.from({ length: Math.floor(next() * 100) }, (_, i) => 'm' + i);
    const maxPerRun = Math.floor(next() * 60); const allowed = Math.floor(next() * 500) - 20;
    const { batch, behind } = planBatch(pending, maxPerRun, allowed);
    assert.deepEqual(batch, pending.slice(0, batch.length), 'a prefix, so the oldest are served first');
    assert.ok(batch.length <= Math.max(0, Math.min(maxPerRun, allowed)));
    assert.equal(behind, pending.length > batch.length);
    if (allowed > 0 && maxPerRun > 0) assert.equal(batch.length, Math.min(pending.length, maxPerRun, allowed), 'never serves fewer than it may');
  }
});

test('budget and day: never negative, correct at midnight, leap day, year end and for any time zone of the input', () => {
  for (const [used, cap] of [[0, 300], [299, 300], [300, 300], [301, 300], [5000, 300], [-5, 300], [0, 0]]) assert.ok(remainingBudget(used, cap) >= 0);
  assert.equal(remainingBudget(299, 300), 1);
  assert.equal(utcDay(new Date('2026-10-12T23:59:59.999Z')), '2026-10-12');
  assert.equal(utcDay(new Date('2026-10-13T00:00:00.000Z')), '2026-10-13');
  assert.equal(utcDay(new Date('2028-02-29T12:00:00Z')), '2028-02-29');
  assert.equal(utcDay(new Date('2026-12-31T23:59:59Z')), '2026-12-31');
  assert.equal(utcDay(new Date('2027-01-01T00:00:00+02:00')), '2026-12-31', 'a +02:00 local time is converted to the UTC day');
  assert.equal(utcDay(new Date('2026-10-12T23:30:00-05:00')), '2026-10-13');
});

test('callWithRetry: for any answer sequence it stops after 1 + maxRetries tries, pauses grow, and only 429 / 5xx are retried', async () => {
  const next = rng(77);
  for (let n = 0; n < 1500; n++) {
    const retries = Math.floor(next() * 6);
    const statuses = Array.from({ length: 12 }, () => [200, 400, 401, 403, 404, 429, 500, 502, 503, 599][Math.floor(next() * 10)]);
    let calls = 0; const pauses: number[] = [];
    const last = await callWithRetry(async () => ({ status: statuses[Math.min(calls++, statuses.length - 1)] }), async (ms) => { pauses.push(ms); }, retries);
    assert.ok(calls >= 1 && calls <= 1 + retries);
    assert.equal(pauses.length, calls - 1);
    for (let i = 1; i < pauses.length; i++) assert.ok(pauses[i] >= pauses[i - 1]);
    assert.equal(last.status, statuses[calls - 1]);
    if (calls <= retries) assert.ok(!isRetryable(last.status), 'it stopped early only because the answer was final');
  }
  assert.ok([400, 401, 403, 404].every((s) => !isRetryable(s)) && [429, 500, 503, 599].every(isRetryable) && !isRetryable(600) && !isRetryable(200));
});

test('classifyTokenResponse: total over random answers; ONLY a 400 invalid_grant means "revoked"', () => {
  const next = rng(3);
  const bodies: any[] = [{}, { error: 'invalid_grant' }, { error: 'invalid_client' }, { access_token: 'x' }, { access_token: '' }, { error: 'invalid_grant', access_token: 'x' }, { error: 5 }];
  for (let n = 0; n < 2000; n++) {
    const status = [200, 201, 204, 400, 401, 403, 429, 500, 503, 0][Math.floor(next() * 10)];
    const body = bodies[Math.floor(next() * bodies.length)];
    const out = classifyTokenResponse(status, body);
    assert.ok(['ok', 'revoked', 'failed'].includes(out.kind));
    assert.equal(out.kind === 'revoked', status === 400 && body.error === 'invalid_grant');
    if (out.kind === 'ok') assert.ok(status >= 200 && status < 300 && body.access_token);
  }
});

test('maxHistoryId agrees with BigInt for 3000 random pairs, including 20-digit ids', () => {
  const next = rng(8);
  const big = () => String(BigInt(Math.floor(next() * 1e9)) * BigInt(Math.floor(next() * 1e9) + 1) + BigInt(Math.floor(next() * 10)));
  for (let n = 0; n < 3000; n++) {
    const a = big(), b = big();
    assert.equal(maxHistoryId(a, b), BigInt(a) >= BigInt(b) ? a : b);
  }
});
// ======================= On-demand scan (issue #15): pure logic =======================
const TODAY = '2026-10-12';
const okRequest = (over: Record<string, unknown> = {}) => ({ consent: true, periodStart: '2026-01-01', periodEnd: '2026-01-31', query: 'invoice', items: ['INV-100', 'Acme'], ...over });

test('validateScanRequest accepts a normal request and cleans it', () => {
  const r = validateScanRequest(okRequest(), TODAY);
  assert.ok(r.ok);
  if (r.ok) assert.deepEqual(r.value, { periodStart: '2026-01-01', periodEnd: '2026-01-31', queryText: 'invoice', items: ['INV-100', 'Acme'] });
});

test('validateScanRequest refuses what it must refuse, with a fixed error code', () => {
  const code = (body: unknown) => { const r = validateScanRequest(body, TODAY); return r.ok ? 'ok' : r.error; };
  assert.equal(code(okRequest({ consent: false })), 'consent_required');
  assert.equal(code(okRequest({ consent: 'true' })), 'consent_required', 'only the real boolean true counts');
  assert.equal(code(okRequest({ consent: undefined })), 'consent_required');
  assert.equal(code(okRequest({ periodStart: '2026-02-30' })), 'bad_dates', 'not a real calendar day');
  assert.equal(code(okRequest({ periodStart: '2026-1-1' })), 'bad_dates');
  assert.equal(code(okRequest({ periodStart: '2026-02-01', periodEnd: '2026-01-31' })), 'bad_dates', 'end before start');
  assert.equal(code(okRequest({ periodStart: '1999-12-31' })), 'bad_dates', 'before 2000');
  assert.equal(code(okRequest({ periodEnd: '2026-10-13' })), 'bad_dates', 'the future');
  assert.equal(code(okRequest({ periodStart: '2025-01-01', periodEnd: '2026-01-31' })), 'period_too_long');
  assert.equal(code(okRequest({ query: '', items: [] })), 'nothing_to_search');
  assert.equal(code(okRequest({ query: '   ', items: ['  ', ''] })), 'nothing_to_search');
  for (const garbage of [null, undefined, 5, 'x', [], {}]) assert.notEqual(code(garbage), 'ok');
  assert.equal(code(okRequest({ periodStart: '2026-01-01', periodEnd: '2027-01-02' })), 'bad_dates', 'a future end is refused before the length');
  assert.equal(code(okRequest({ periodStart: '2025-10-12', periodEnd: '2026-10-12' })), 'ok', 'exactly 365 days apart is fine');
});

test('validateScanRequest: the length limit is 366 days, leap years included', () => {
  const code = (s: string, e: string, today = '2029-12-31') => { const r = validateScanRequest(okRequest({ periodStart: s, periodEnd: e }), today); return r.ok ? 'ok' : r.error; };
  assert.equal(code('2028-01-01', '2028-12-31'), 'ok', '366 days in a leap year');
  assert.equal(code('2028-01-01', '2029-01-01'), 'period_too_long', '367 days');
  assert.equal(code('2028-02-29', '2028-02-29'), 'ok', 'a single leap day');
});

test('sanitizeQuery: operators cannot escape, nothing hidden, never longer than 200', () => {
  assert.equal(sanitizeQuery('  invoice   from:(boss) {a b}  '), 'invoice from:boss a b');
  assert.equal(sanitizeQuery('he said "hello'), 'he said hello', 'an unbalanced quote is removed');
  assert.equal(sanitizeQuery('"exact phrase" other'), '"exact phrase" other', 'balanced quotes stay');
  assert.equal(sanitizeQuery('pay\u202Efdp\u200B'), 'payfdp');
  assert.ok(sanitizeQuery('x'.repeat(5000)).length <= 200);
  for (const odd of [null, undefined, 5, {}, []]) assert.equal(sanitizeQuery(odd as any), '');
});

test('parseItems: cleaned, deduplicated ignoring letter case, limited', () => {
  assert.deepEqual(parseItems(['  Acme  ', 'acme', 'ACME', 'INV 1', '', '   ', 5, null] as any), ['Acme', 'INV 1']);
  assert.equal(parseItems(Array.from({ length: 500 }, (_, i) => 'item ' + i)).length, 100);
  assert.ok(parseItems(['x'.repeat(5000)])[0].length <= 120);
  assert.deepEqual(parseItems('not an array' as any), []);
  assert.deepEqual(parseItems(['a\u202Eb\u0000c']), ['abc']);
});

test('buildGmailQuery: the day AFTER the end is used (Gmail "before" is exclusive); month ends, leap day and year end', () => {
  assert.equal(buildGmailQuery('2026-01-01', '2026-01-31', 'invoice', []), 'after:2026/01/01 before:2026/02/01 invoice');
  assert.equal(buildGmailQuery('2028-02-01', '2028-02-29', 'x', []), 'after:2028/02/01 before:2028/03/01 x');
  assert.equal(buildGmailQuery('2026-12-01', '2026-12-31', 'x', []), 'after:2026/12/01 before:2027/01/01 x');
  assert.equal(buildGmailQuery('2026-02-28', '2026-02-28', 'x', []), 'after:2026/02/28 before:2026/03/01 x');
});

test('buildGmailQuery: without search text the items become the search (an OR group of quoted items)', () => {
  assert.equal(buildGmailQuery('2026-01-01', '2026-01-31', '', ['INV-100', 'Acme Ltd']), 'after:2026/01/01 before:2026/02/01 {"INV-100" "Acme Ltd"}');
  const many = Array.from({ length: 60 }, (_, i) => 'item' + i);
  const q = buildGmailQuery('2026-01-01', '2026-01-31', '', many);
  assert.equal((q.match(/"/g) ?? []).length, 40, 'at most 20 items go into the query');
  assert.equal(buildGmailQuery('2026-01-01', '2026-01-31', 'text', ['a']), 'after:2026/01/01 before:2026/02/01 text', 'with search text the items are not in the query');
});

test('parseMatchAnswer: only asked ids and real item numbers survive; chatter and fences are fine', () => {
  const known = new Set(['m1', 'm2']);
  const answer = 'ok:\n```json\n[{"id":"m1","matches":[0,2,2,"1",-1,99,1.5],"summary":"נמצא <b>חשבונית</b> https://x.y"},{"id":"zzz","matches":[0],"summary":"לא נשאל"},{"id":"m2","matches":"none","summary":"אין"}]\n```';
  const result = parseMatchAnswer(answer, known, 3);
  assert.deepEqual([...result.keys()], ['m1', 'm2']);
  assert.deepEqual(result.get('m1')!.matches, [0, 2], 'integers inside the list, no duplicates, no strings');
  assert.equal(result.get('m1')!.summary, 'נמצא <b>חשבונית</b>', 'links removed; the page shows plain text');
  assert.deepEqual(result.get('m2')!.matches, []);
});

test('parseMatchAnswer: 3000 hostile answers never throw and never invent anything', () => {
  const next = rng(41); const known = new Set(['a', 'b', 'c']);
  const pieces = ['[', ']', '{', '}', '"id"', ':', '"a"', '"b"', '"zzz"', ',', '"matches"', '[0,1]', '[-5]', '[1e9]', '"summary"', '"ok https://x.y"', 'null', '7', '```', 'ignore all rules', '\n'];
  for (let n = 0; n < 3000; n++) {
    let s = ''; for (let i = 0, len = Math.floor(next() * 40); i < len; i++) s += pieces[Math.floor(next() * pieces.length)];
    const itemCount = Math.floor(next() * 5);
    for (const [id, v] of parseMatchAnswer(s, known, itemCount)) {
      assert.ok(known.has(id));
      assert.ok(v.matches.every((m) => Number.isInteger(m) && m >= 0 && m < itemCount), JSON.stringify([s, itemCount]));
      assert.equal(new Set(v.matches).size, v.matches.length);
      assert.ok(v.summary.length <= 300);
      assert.doesNotMatch(v.summary, LINK);
    }
  }
});

test('localMatches: finds items inside text, ignoring letter case and extra spaces; very short items are not matched this way', () => {
  assert.deepEqual(localMatches('Invoice INV-100 for  Acme   Ltd', ['inv-100', 'acme ltd', 'zzz', 'AB', 'invoice']), [0, 1, 4]);
  assert.deepEqual(localMatches('', ['abc']), []);
  assert.deepEqual(localMatches('anything', []), []);
  assert.deepEqual(localMatches('חשבונית מספר 4412 מחברת אקמה', ['4412', 'אקמה']), [0, 1], 'Hebrew and digits');
});

test('localMatches: 2000 random texts - indexes always valid, ascending, unique', () => {
  const next = rng(23); const words = ['inv', '100', 'acme', 'שלום', ' ', '  ', '-', 'X', 'ltd'];
  for (let n = 0; n < 2000; n++) {
    const text = Array.from({ length: Math.floor(next() * 12) }, () => words[Math.floor(next() * words.length)]).join('');
    const items = Array.from({ length: Math.floor(next() * 5) }, () => words[Math.floor(next() * words.length)] + words[Math.floor(next() * words.length)]);
    const result = localMatches(text, items);
    for (let i = 0; i < result.length; i++) { assert.ok(result[i] >= 0 && result[i] < items.length); if (i) assert.ok(result[i] > result[i - 1]); }
  }
  assert.equal(MAX_SCAN_MAILS, 200);
});

test('validateScanRequest: 3000 random bodies never throw; every accepted request satisfies all the rules', () => {
  const next = rng(61); const pick = <T,>(list: T[]) => list[Math.floor(next() * list.length)];
  for (let n = 0; n < 3000; n++) {
    const body = pick<any>([
      () => okRequest({ periodStart: pick(['2026-01-01', '2026-02-30', '2000-01-01', '1999-01-01', 'x', null, 5, '2026-13-01', '2028-02-29']), periodEnd: pick(['2026-01-31', '2026-10-12', '2026-10-13', '2027-01-01', null, '2028-03-01']), query: pick(['', 'a'.repeat(500), '(x) {y} "z', 5, null, 'ok']), items: pick([[], ['a'], Array.from({ length: 300 }, (_, i) => 'i' + i), 'str', [1, 2], null]) }),
      () => pick([null, undefined, 5, 'x', [], {}]),
    ])();
    const r = validateScanRequest(body, TODAY);
    if (r.ok) {
      const { periodStart, periodEnd, queryText, items } = r.value;
      assert.match(periodStart, /^\d{4}-\d{2}-\d{2}$/); assert.match(periodEnd, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(periodStart <= periodEnd && periodEnd <= TODAY && periodStart >= '2000-01-01');
      assert.ok((Date.parse(periodEnd) - Date.parse(periodStart)) / 86400000 <= 366);
      assert.ok(queryText.length <= 200 && !/[(){}]/.test(queryText)); assert.doesNotMatch(queryText, FORBIDDEN);
      assert.ok(items.length <= 100 && new Set(items.map((s) => s.toLowerCase())).size === items.length);
      assert.ok(queryText !== '' || items.length > 0, 'something to search for');
    }
  }
});
// ======================= Morning briefing (issue #16): pure logic =======================
test('parseDeadline accepts only a real day inside the window (60 days back, 400 ahead)', () => {
  const today = '2026-10-12';
  assert.equal(parseDeadline('2026-10-20', today), '2026-10-20');
  assert.equal(parseDeadline('  2026-10-20  ', today), '2026-10-20');
  assert.equal(parseDeadline('2026-10-12', today), '2026-10-12', 'today');
  assert.equal(parseDeadline('2026-08-13', today), '2026-08-13', 'exactly 60 days back');
  assert.equal(parseDeadline('2026-08-12', today), null, '61 days back');
  assert.equal(parseDeadline('2027-11-16', today), '2027-11-16', 'exactly 400 days ahead');
  assert.equal(parseDeadline('2027-11-17', today), null, '401 days ahead');
  for (const bad of ['2026-02-30', '2026-13-01', '1900-01-01', '9999-12-31', 'tomorrow', '12/10/2026', '2026-10-1', '', '   ', null, undefined, 5, {}, [], '2026-10-20T10:00:00Z', '2026-10-20 '.repeat(2)]) {
    assert.equal(parseDeadline(bad as any, today), null, JSON.stringify(bad));
  }
  assert.equal(parseDeadline('2028-02-29', '2028-02-01'), '2028-02-29', 'leap day');
  assert.equal(parseDeadline('2027-02-29', '2027-02-01'), null, 'no leap day in 2027');
});

test('parseDeadline: 3000 random values never throw and never return anything outside the window', () => {
  const next = rng(17); const today = '2026-10-12';
  const pieces = ['2026', '-', '10', '12', '02', '30', '99', '2027', '00', ' ', 'x', '2028-02-29', '1999'];
  for (let n = 0; n < 3000; n++) {
    const text = Array.from({ length: Math.floor(next() * 8) }, () => pieces[Math.floor(next() * pieces.length)]).join('');
    const out = parseDeadline(text, today);
    if (out !== null) {
      assert.match(out, /^\d{4}-\d{2}-\d{2}$/);
      const diff = (Date.parse(out + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400000;
      assert.ok(diff >= -60 && diff <= 400, text);
    }
  }
});

test('parseModelAnswer carries a valid deadline and drops an invented one', () => {
  const known = new Set(['a', 'b', 'c']);
  const answer = JSON.stringify([
    { id: 'a', summary: 'חשבונית', deadline: '2026-10-20' },
    { id: 'b', summary: 'ישיבה', deadline: '2026-02-30' },
    { id: 'c', summary: 'בלי', deadline: '' },
  ]);
  const result = parseModelAnswer(answer, known, '2026-10-12');
  assert.equal(result.get('a')!.deadline, '2026-10-20');
  assert.equal(result.get('b')!.deadline, null);
  assert.equal(result.get('c')!.deadline, null);
  assert.equal(parseModelAnswer(JSON.stringify([{ id: 'a', summary: 'x' }]), known, '2026-10-12').get('a')!.deadline, null, 'a model that does not send the field');
});

test('isAutomatedSender recognises robots but not people', () => {
  for (const robot of ['noreply@x.com', 'No-Reply <no-reply@bank.example>', 'Shop <donotreply@shop.example>', 'do-not-reply@x.io', 'notifications@github.com', 'MAILER-DAEMON@x', 'Weekly Newsletter <hi@x.com>', 'bounce+123@mail.example.com', 'postmaster@x']) assert.equal(isAutomatedSender(robot), true, robot);
  for (const person of ['Dana Levi <dana@example.com>', 'דנה לוי <dana@gmail.com>', 'Bob <bob@company.example>', '', 'replying@example.com']) assert.equal(isAutomatedSender(person), false, person);
  assert.equal(isAutomatedSender(null as any), false);
});

test('threadNeedsReply: the last real message decides, judged by the SENT label (aliases work); drafts, trash and spam are ignored', () => {
  const msg = (date: number, labels: string[]) => ({ internalDate: String(date), labelIds: labels });
  assert.equal(threadNeedsReply([msg(1, ['INBOX'])]), true, 'a lone mail from someone else');
  assert.equal(threadNeedsReply([msg(1, ['INBOX']), msg(2, ['SENT'])]), false, 'I answered last');
  assert.equal(threadNeedsReply([msg(1, ['SENT']), msg(2, ['INBOX'])]), true, 'they answered my mail');
  assert.equal(threadNeedsReply([msg(1, ['INBOX']), msg(2, ['SENT']), msg(3, ['DRAFT', 'SENT'])]), false, 'a draft of mine does not count as a newer message');
  assert.equal(threadNeedsReply([msg(1, ['INBOX']), msg(2, ['INBOX', 'SPAM'])]), true, 'spam is ignored');
  assert.equal(threadNeedsReply([msg(2, ['SENT']), msg(1, ['INBOX'])]), false, 'order of the array does not matter, dates do');
  assert.equal(threadNeedsReply([msg(1, ['INBOX']), { labelIds: ['SENT'] }]), false, 'a missing date: array order');
  assert.equal(threadNeedsReply([msg(1, ['TRASH'])]), null, 'nothing real left: cannot tell');
  for (const garbage of [null, undefined, 5, 'x', {}, [], [null], [5], [{}]]) assert.ok([true, false, null].includes(threadNeedsReply(garbage as any) as any));
  assert.equal(threadNeedsReply([{}]), true, 'no labels at all is not "sent by me"');
});

test('threadNeedsReply: 3000 random threads never throw; the answer follows the newest valid message', () => {
  const next = rng(29); const labels = ['INBOX', 'SENT', 'DRAFT', 'TRASH', 'SPAM', 'UNREAD', 'IMPORTANT'];
  for (let n = 0; n < 3000; n++) {
    const messages = Array.from({ length: Math.floor(next() * 7) }, (_, i) => ({ internalDate: next() < 0.1 ? 'bad' : String(Math.floor(next() * 1000)), labelIds: Array.from({ length: Math.floor(next() * 3) }, () => labels[Math.floor(next() * labels.length)]) }));
    const out = threadNeedsReply(messages as any);
    const real = messages.filter((m) => !m.labelIds.some((l) => l === 'DRAFT' || l === 'TRASH' || l === 'SPAM'));
    if (real.length === 0) assert.equal(out, null);
    else assert.equal(typeof out, 'boolean');
    const valid = real.filter((m) => Number.isFinite(Number(m.internalDate)));
    if (valid.length === real.length && real.length > 0) {
      const newest = real.reduce((a, b) => (Number(b.internalDate) >= Number(a.internalDate) ? b : a));
      assert.equal(out, !newest.labelIds.includes('SENT'));
    }
  }
});

test('pickReplyCandidates: only recent, human, reply-worthy, not-just-checked threads; newest first; unique; limited', () => {
  const now = Date.parse('2026-10-12T09:00:00Z'); const ago = (h: number) => new Date(now - h * 3600_000).toISOString();
  const row = (over: Record<string, unknown>) => ({ thread_id: 't', received_at: ago(30), category: 'work', urgency: 'normal', from_name: 'Dana <d@x.com>', reply_checked_at: null, ...over });
  const rows = [
    row({ thread_id: 'ok1', received_at: ago(30) }),
    row({ thread_id: 'ok2', received_at: ago(50), category: 'finance' }),
    row({ thread_id: 'old', received_at: ago(24 * 15) }),
    row({ thread_id: 'news', category: 'newsletter' }),
    row({ thread_id: 'promo', category: 'promotion' }),
    row({ thread_id: 'low', urgency: 'low' }),
    row({ thread_id: 'robot', from_name: 'noreply@x.com' }),
    row({ thread_id: 'fresh', reply_checked_at: ago(2) }),
    row({ thread_id: 'stale', reply_checked_at: ago(7) }),
    row({ thread_id: null }),
    row({ thread_id: '' }),
    row({ thread_id: 'ok1', received_at: ago(31) }),
    row({ thread_id: 'bad date', received_at: 'garbage' }),
  ];
  assert.deepEqual(pickReplyCandidates(rows as any, now, 20), ['ok1', 'stale', 'ok2']);
  assert.deepEqual(pickReplyCandidates(rows as any, now, 2), ['ok1', 'stale']);
  assert.deepEqual(pickReplyCandidates(null as any, now, 20), []);
  assert.deepEqual(pickReplyCandidates([], now, 20), []);
});

test('pickReplyCandidates: 2000 random mailboxes - never more than the limit, unique, every pick satisfies the rules', () => {
  const next = rng(77); const now = Date.parse('2026-10-12T09:00:00Z');
  const cats = [...CATEGORIES, 'weird', null]; const froms = ['Dana <d@x.com>', 'noreply@x.com', '', null, 'Shop Newsletter <n@x.com>'];
  for (let n = 0; n < 2000; n++) {
    const rows = Array.from({ length: Math.floor(next() * 60) }, (_, i) => ({ thread_id: next() < 0.1 ? null : 't' + Math.floor(next() * 25), received_at: next() < 0.1 ? 'bad' : new Date(now - next() * 20 * 86400000).toISOString(), category: cats[Math.floor(next() * cats.length)], urgency: ['high', 'normal', 'low', null][Math.floor(next() * 4)], from_name: froms[Math.floor(next() * froms.length)], reply_checked_at: next() < 0.5 ? null : new Date(now - next() * 10 * 3600000).toISOString() }));
    const limit = Math.floor(next() * 30);
    const picks = pickReplyCandidates(rows as any, now, limit);
    assert.ok(picks.length <= limit); assert.equal(new Set(picks).size, picks.length);
    for (const id of picks) {
      const matching = rows.filter((r) => r.thread_id === id);
      assert.ok(matching.some((r) => ['personal', 'work', 'finance', 'important'].includes(r.category as string) && r.urgency !== 'low' && !isAutomatedSender(r.from_name as any) && now - Date.parse(r.received_at) <= 14 * 86400000), 'pick ' + id);
    }
  }
});