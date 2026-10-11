import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanText, decodeBytes, parseModelAnswer, isRetryable, backoffMs, remainingBudget, utcDay, callWithRetry, planBatch, classifyTokenResponse, isThrottled, maxHistoryId, stripControls, CATEGORIES, URGENCIES } from './logic.ts';

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