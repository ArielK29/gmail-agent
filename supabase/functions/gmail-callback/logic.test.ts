import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consentOutcome, backUrl, GMAIL_READONLY } from './logic.ts';

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