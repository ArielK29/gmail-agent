import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consentOutcome, backUrl, backUrlFor, GMAIL_READONLY, GOOGLE_CALENDAR, GOOGLE_TASKS, optionalScopes } from './logic.ts';

test('consentOutcome: stores a connection only when Google sent a refresh token AND the Gmail permission was granted', () => {
  assert.equal(consentOutcome(true, { refresh_token: 'r', scope: `openid email ${GMAIL_READONLY}` }), 'ok');
  assert.equal(consentOutcome(true, { refresh_token: 'r', scope: `${GMAIL_READONLY}\topenid\n` }), 'ok', 'any whitespace between scopes');
  assert.equal(consentOutcome(true, { refresh_token: 'r', scope: 'openid email' }), 'missing_scope', 'the member unticked the Gmail permission');
  assert.equal(consentOutcome(true, { refresh_token: 'r', scope: '' }), 'missing_scope');
  assert.equal(consentOutcome(true, { refresh_token: 'r' }), 'missing_scope', 'no scope field at all');
  assert.equal(consentOutcome(true, { refresh_token: 'r', scope: GMAIL_READONLY + 'x' }), 'missing_scope', 'a look-alike scope is not the permission');
  assert.equal(consentOutcome(true, { refresh_token: 'r', scope: 'https://www.googleapis.com/auth/gmail.modify' }), 'missing_scope', 'a different (wider) permission is not the one we ask for');
});

test('consentOutcome: every other failure is a plain error, nothing throws', () => {
  for (const [ok, tokens] of [[false, { refresh_token: 'r', scope: GMAIL_READONLY }], [true, {}], [true, null], [true, undefined], [true, { refresh_token: '' }], [true, { refresh_token: 5 }], [true, 'text'], [true, []]] as Array<[boolean, any]>) {
    assert.equal(consentOutcome(ok, tokens), 'error', JSON.stringify([ok, tokens]));
  }
});

test('backUrl: the result is always from the fixed list, the address is built correctly', () => {
  assert.equal(backUrl('https://x.github.io/app/', 'connected'), 'https://x.github.io/app/?gmail=connected');
  assert.equal(backUrl('https://x.github.io/app/?lang=he', 'cancelled'), 'https://x.github.io/app/?lang=he&gmail=cancelled');
  for (const hostile of ['<script>', 'connected&evil=1', '../../x', '', 'CONNECTED', 'https://evil.example']) {
    assert.equal(backUrl('https://x.github.io/app/', hostile), 'https://x.github.io/app/?gmail=error', 'unknown result: ' + hostile);
  }
});

test('optional permissions: only the exact calendar and tasks scopes count, whatever else is ticked', () => {
  assert.deepEqual(optionalScopes({ scope: `${GMAIL_READONLY} ${GOOGLE_CALENDAR} ${GOOGLE_TASKS} openid` }), { calendar: true, tasks: true });
  assert.deepEqual(optionalScopes({ scope: `${GMAIL_READONLY} ${GOOGLE_TASKS}` }), { calendar: false, tasks: true });
  assert.deepEqual(optionalScopes({ scope: `${GMAIL_READONLY}\n${GOOGLE_CALENDAR}` }), { calendar: true, tasks: false });
  assert.deepEqual(optionalScopes({ scope: GMAIL_READONLY }), { calendar: false, tasks: false });
  assert.deepEqual(optionalScopes({ scope: GOOGLE_CALENDAR + 'x ' + 'https://www.googleapis.com/auth/calendar' }), { calendar: false, tasks: false }, 'look-alike and wider scopes are not the permission');
  assert.deepEqual(optionalScopes({ scope: 'https://www.googleapis.com/auth/tasks' }), { calendar: false, tasks: false }, 'the read-write tasks scope is a different permission');
  for (const bad of [null, undefined, {}, 'x', 5, [], { scope: 5 }, { scope: null }]) assert.deepEqual(optionalScopes(bad), { calendar: false, tasks: false });
});
// Issue 32: the app can ask to come back to a deep link instead of the web page. The address comes from the server's own setting,
// never from the request, and only a custom app scheme counts.
test('backUrlFor: the web page is the default and the way back for anything unknown', () => {
  const web = 'https://example.github.io/gmail-agent/';
  assert.equal(backUrlFor('web', web, 'gmailagent://connect', 'connected'), 'https://example.github.io/gmail-agent/?gmail=connected');
  for (const target of [undefined, null, '', 'App', 'x', 5, {}]) assert.equal(backUrlFor(target, web, 'gmailagent://connect', 'error'), 'https://example.github.io/gmail-agent/?gmail=error', String(target));
});

test('backUrlFor: target app goes to the configured deep link with the result', () => {
  assert.equal(backUrlFor('app', 'https://w/', 'gmailagent://connect', 'connected'), 'gmailagent://connect?gmail=connected');
  assert.equal(backUrlFor('app', 'https://w/', 'gmailagent://connect?x=1', 'cancelled'), 'gmailagent://connect?x=1&gmail=cancelled');
  assert.equal(backUrlFor('app', 'https://w/', 'gmailagent://connect', 'weird'), 'gmailagent://connect?gmail=error', 'the result is still one of the fixed list');
});

test('backUrlFor: an app link that is missing or not a custom scheme is never used (no open redirect)', () => {
  const web = 'https://w/';
  for (const link of [undefined, '', 'https://evil.example/', 'http://evil.example/', 'javascript:alert(1)', 'data:text/html,x', '//evil.example', 'gmail agent://x', 'gmailagent:/x', 'file:///etc/passwd']) {
    assert.equal(backUrlFor('app', web, link as any, 'connected'), 'https://w/?gmail=connected', String(link));
  }
});