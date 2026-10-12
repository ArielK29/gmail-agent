// Which Google permissions are asked for, by plan (issue #22).   node --test supabase/functions/gmail-connect/scopes.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { scopeFor, GMAIL_SCOPE, CALENDAR_SCOPE, TASKS_SCOPE } from './scopes.ts';

test('Pro (or everybody while billing is not enforced) is asked for Gmail, calendar and tasks; everybody else for Gmail only', () => {
  assert.equal(scopeFor(true), [GMAIL_SCOPE, CALENDAR_SCOPE, TASKS_SCOPE, 'openid', 'email'].join(' '));
  for (const notPro of [false, null]) {
    const scope = scopeFor(notPro);
    assert.equal(scope, [GMAIL_SCOPE, 'openid', 'email'].join(' '));
    assert.ok(!scope.includes('calendar') && !scope.includes('tasks'), 'an undecidable access or a Free member is never asked for calendar or tasks');
  }
});

test('only read-only scopes are ever requested, and Gmail is always among them', () => {
  for (const pro of [true, false, null]) {
    const scopes = scopeFor(pro).split(' ');
    assert.ok(scopes.includes(GMAIL_SCOPE));
    for (const scope of scopes.filter((s) => s.startsWith('https://'))) assert.ok(scope.endsWith('.readonly'), scope);
  }
});

test('the copies of entitlement.ts and access.ts in gmail-connect are identical to the ones in gmail-sync', () => {
  for (const file of ['entitlement.ts', 'access.ts']) assert.equal(readFileSync(new URL(`./${file}`, import.meta.url), 'utf8'), readFileSync(new URL(`../gmail-sync/${file}`, import.meta.url), 'utf8'), file);
});