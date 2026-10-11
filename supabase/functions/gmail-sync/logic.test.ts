import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanText, decodeBytes, parseModelAnswer, isRetryable, backoffMs, remainingBudget, utcDay, callWithRetry, planBatch, classifyTokenResponse } from './logic.ts';

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
