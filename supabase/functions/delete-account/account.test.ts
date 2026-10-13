// "Delete my account" (issue #26): the Polar customer is deleted FIRST (that also ends the subscription, so nobody is billed after
// they are gone), then the Gmail data, then the Google token, then the member. Against a fake database and a fake Polar.
//   node --test supabase/functions/delete-account/account.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, type Row } from '../gmail-sync/testkit.ts';
import { deleteAccount, polarBase } from './account.ts';
import { polarBase as billingBase } from '../polar-billing/billing.ts';

const U = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const TOKEN = ['polar', 'oat', 'test', 'value'].join('_');
const ENV = { token: TOKEN, server: 'sandbox' };
const CUSTOMER = '33333333-3333-4333-8333-333333333333';

function world(over: Record<string, Row[]> = {}, failing: Record<string, any> = {}) {
  return makeDb({
    subscriptions: [{ user_id: U, source: 'polar', status: 'active', polar_customer_id: CUSTOMER }, { user_id: OTHER, source: 'polar', status: 'active', polar_customer_id: 'cus_other' }],
    gmail_connections: [{ user_id: U, refresh_token: 'refresh-token-of-U' }, { user_id: OTHER, refresh_token: 'refresh-token-of-other' }],
    gmail_digest: [{ user_id: U, gmail_message_id: 'm1' }, { user_id: U, gmail_message_id: 'm2' }, { user_id: OTHER, gmail_message_id: 'm3' }],
    gmail_scans: [{ id: 's1', user_id: U }, { id: 's2', user_id: OTHER }],
    gmail_agenda: [{ user_id: U, external_id: 'e1' }, { user_id: OTHER, external_id: 'e2' }],
    ...over,
  }, failing);
}
const counts = (db: any, user = U) => ['subscriptions', 'gmail_connections', 'gmail_digest', 'gmail_scans', 'gmail_agenda'].map((t) => db.tables[t].filter((r: Row) => r.user_id === user).length);

// Everything that happens, in order, so the ORDER can be tested.
function harness(opts: { polar?: { status?: number; throws?: boolean }; deleteUserError?: boolean; googleOk?: boolean } = {}) {
  const log: string[] = [];
  const polarCalls: Array<{ url: string; init: any }> = [];
  const fetchFn = (async (url: any, init: any) => {
    log.push('polar'); polarCalls.push({ url: String(url), init });
    if (opts.polar?.throws) throw new Error('boom ' + init.headers.Authorization);
    return new Response(opts.polar?.status === 204 || opts.polar?.status === undefined ? null : JSON.stringify({ detail: 'x ' + TOKEN }), { status: opts.polar?.status ?? 204 });
  }) as typeof fetch;
  const deps = {
    fetchFn,
    deleteUser: async (id: string) => { log.push('deleteUser:' + id); return { error: opts.deleteUserError ? { message: 'no' } : null }; },
    revokeGoogle: async (token: string) => { log.push('google:' + token); return opts.googleOk !== false; },
  };
  return { log, polarCalls, deps };
}
const OK = { confirm: true };

test('a deletion needs an explicit confirm: anything else is a 400 and touches nothing', async () => {
  for (const body of [undefined, null, {}, { confirm: false }, { confirm: 'true' }, { confirm: 1 }, 'x', []]) {
    const db = world(); const h = harness();
    assert.deepEqual(await deleteAccount(db as any, { id: U }, body, ENV, h.deps), { status: 400, body: { error: 'confirm_required' } }, JSON.stringify(body));
    assert.deepEqual(h.log, []);
    assert.deepEqual(counts(db), [1, 1, 2, 1, 1]);
  }
});

test('a member without a Polar customer: the Gmail data, the connection and the Google token go, then the member; nobody else is touched; Polar is not called', async () => {
  const db = world({ subscriptions: [{ user_id: OTHER, source: 'polar', status: 'active', polar_customer_id: 'cus_other' }] }); const h = harness();
  assert.deepEqual(await deleteAccount(db as any, { id: U }, OK, ENV, h.deps), { status: 200, body: { ok: true, revoked: true } });
  assert.deepEqual(h.log, ['google:refresh-token-of-U', 'deleteUser:' + U]);
  assert.deepEqual(counts(db), [0, 0, 0, 0, 0]);
  assert.deepEqual(counts(db, OTHER), [1, 1, 1, 1, 1], 'another member is untouched');
});

test('a member with a Polar customer: the customer is deleted FIRST (anonymized, with the trimmed token), before any data is deleted and before the member', async () => {
  const db = world(); const h = harness();
  const answer = await deleteAccount(db as any, { id: U }, OK, { token: TOKEN + '\n', server: 'sandbox' }, h.deps);
  assert.equal(answer.status, 200);
  assert.equal(h.polarCalls.length, 1);
  assert.equal(h.polarCalls[0].url, `https://sandbox-api.polar.sh/v1/customers/${CUSTOMER}?anonymize=true`);
  assert.equal(h.polarCalls[0].init.method, 'DELETE');
  assert.equal(h.polarCalls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(h.log, ['polar', 'google:refresh-token-of-U', 'deleteUser:' + U], 'Polar before the Google token before the member');
  const prod = harness(); await deleteAccount(world() as any, { id: U }, OK, { token: TOKEN, server: 'production' }, prod.deps);
  assert.ok(prod.polarCalls[0].url.startsWith('https://api.polar.sh/v1/customers/'));
  for (const odd of [undefined, '', 'Production', 'production\n']) { const x = harness(); await deleteAccount(world() as any, { id: U }, OK, { token: TOKEN, server: odd }, x.deps); assert.ok(x.polarCalls[0].url.startsWith('https://sandbox-api.polar.sh/'), String(JSON.stringify(odd))); }
});

test('Polar answering 200, 204 or 404 (the customer is already gone) lets the deletion go on; the customer id is placed in the address safely', async () => {
  for (const status of [200, 204, 404]) {
    const db = world(); const h = harness({ polar: { status } });
    assert.equal((await deleteAccount(db as any, { id: U }, OK, ENV, h.deps)).status, 200, String(status));
    assert.deepEqual(counts(db), [0, 0, 0, 0, 0]);
  }
  const hostile = world({ subscriptions: [{ user_id: U, source: 'polar', status: 'active', polar_customer_id: '../../products?x=1#' }] }); const h = harness();
  await deleteAccount(hostile as any, { id: U }, OK, ENV, h.deps);
  assert.equal(h.polarCalls[0].url, 'https://sandbox-api.polar.sh/v1/customers/..%2F..%2Fproducts%3Fx%3D1%23?anonymize=true');
});

test('when Polar cannot delete the customer (error, refusal, no network) NOTHING is deleted, the member is told, and the token is never printed', async () => {
  const lines: string[] = []; const keep = console.error; console.error = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
  try {
    for (const polar of [{ status: 500 }, { status: 401 }, { status: 403 }, { status: 422 }, { throws: true }]) {
      const db = world(); const h = harness({ polar });
      assert.deepEqual(await deleteAccount(db as any, { id: U }, OK, ENV, h.deps), { status: 502, body: { error: 'customer_delete_failed' } }, JSON.stringify(polar));
      assert.deepEqual(counts(db), [1, 1, 2, 1, 1], 'nothing was deleted');
      assert.deepEqual(h.log, ['polar'], 'no Google revoke, no member deletion');
    }
  } finally { console.error = keep; }
  assert.ok(!lines.join('\n').includes(TOKEN), 'the token is never printed');
});

test('a Polar customer but no token configured: 503 and nothing is deleted; no Polar customer and no token: the deletion goes on', async () => {
  for (const token of [undefined, '', '  \n']) {
    const db = world(); const h = harness();
    assert.deepEqual(await deleteAccount(db as any, { id: U }, OK, { token, server: 'sandbox' }, h.deps), { status: 503, body: { error: 'not_configured' } });
    assert.deepEqual([counts(db), h.log], [[1, 1, 2, 1, 1], []]);
  }
  const noCustomer = world({ subscriptions: [] }); const h = harness();
  assert.equal((await deleteAccount(noCustomer as any, { id: U }, { confirm: true }, { token: undefined }, h.deps)).status, 200);
});

test('the owner\'s manual grant has no Polar customer: Polar is not called', async () => {
  const db = world({ subscriptions: [{ user_id: U, source: 'manual', status: 'active', polar_customer_id: null }] }); const h = harness();
  assert.equal((await deleteAccount(db as any, { id: U }, OK, ENV, h.deps)).status, 200);
  assert.deepEqual(h.polarCalls, []);
  const odd = world({ subscriptions: [{ user_id: U, source: 'manual', status: 'active', polar_customer_id: CUSTOMER }] }); const h2 = harness();
  await deleteAccount(odd as any, { id: U }, OK, ENV, h2.deps);
  assert.deepEqual(h2.polarCalls, [], 'a manual grant never touches Polar, whatever the row says');
});

test('a failed read of the subscription stops everything (we cannot tell whether somebody is being billed)', async () => {
  const db = world({}, { 'subscriptions.select': true }); const h = harness();
  assert.deepEqual(await deleteAccount(db as any, { id: U }, OK, ENV, h.deps), { status: 500, body: { error: 'read_failed' } });
  assert.deepEqual([counts(db, U).slice(1), h.log], [[1, 2, 1, 1], []]);
});

test('a failed delete of any Gmail table stops before the member is deleted; trying again after Polar already did its part finishes the job', async () => {
  for (const table of ['gmail_digest', 'gmail_scans', 'gmail_agenda', 'gmail_connections']) {
    const db = world({}, { [`${table}.delete`]: true }); const h = harness();
    assert.deepEqual(await deleteAccount(db as any, { id: U }, OK, ENV, h.deps), { status: 500, body: { error: 'delete_failed' } }, table);
    assert.ok(!h.log.some((l) => l.startsWith('deleteUser')), 'the member is kept so the deletion can be retried: ' + table);
    delete db.failing[`${table}.delete`];
    const retry = harness({ polar: { status: 404 } }); // Polar: the customer is already gone
    assert.equal((await deleteAccount(db as any, { id: U }, OK, ENV, retry.deps)).status, 200, 'retry: ' + table);
    assert.deepEqual(counts(db).slice(1), [0, 0, 0, 0]);
  }
});

test('a failed deletion of the member itself is reported and can be retried; a Google revoke that fails does not stop the deletion', async () => {
  const db = world(); const h = harness({ deleteUserError: true });
  assert.deepEqual(await deleteAccount(db as any, { id: U }, OK, ENV, h.deps), { status: 500, body: { error: 'delete_failed' } });
  const retry = harness({ polar: { status: 404 } });
  assert.equal((await deleteAccount(db as any, { id: U }, OK, ENV, retry.deps)).status, 200);
  const googleDown = world({ subscriptions: [] }); const g = harness({ googleOk: false });
  assert.deepEqual(await deleteAccount(googleDown as any, { id: U }, OK, ENV, g.deps), { status: 200, body: { ok: true, revoked: false } });
  assert.ok(g.log.includes('deleteUser:' + U));
});

test('guard: the Polar address rule is the same as in the billing function', () => {
  for (const server of [undefined, '', 'sandbox', 'production', 'Production', 'production\n', ' production', 'live']) assert.equal(polarBase(server), billingBase(server), String(JSON.stringify(server)));
});