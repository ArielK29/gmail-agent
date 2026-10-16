// Where the Google consent should return to (issue 32).   node --test supabase/functions/gmail-connect/target.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTarget } from './target.ts';

test('parseTarget: no body, an empty body or an unrelated body means the web page', () => {
  for (const body of [undefined, null, {}, '', 'text', 7, [], { action: 'x' }]) assert.deepEqual(parseTarget(body, true), { ok: true, target: 'web' }, String(body));
});

test('parseTarget: app is allowed only when the server has an app link configured', () => {
  assert.deepEqual(parseTarget({ target: 'app' }, true), { ok: true, target: 'app' });
  assert.deepEqual(parseTarget({ target: 'app' }, false), { ok: false, error: 'app_link_not_configured' });
  assert.deepEqual(parseTarget({ target: 'web' }, false), { ok: true, target: 'web' });
});

test('parseTarget: anything else is refused, never guessed', () => {
  for (const target of ['App', 'mobile', '', 5, null, true, {}]) assert.deepEqual(parseTarget({ target }, true), { ok: false, error: 'bad_target' }, String(target));
});