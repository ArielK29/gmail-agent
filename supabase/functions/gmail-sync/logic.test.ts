import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanText, decodeBytes, parseModelAnswer, isRetryable, backoffMs, remainingBudget, utcDay } from './logic.ts';

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
