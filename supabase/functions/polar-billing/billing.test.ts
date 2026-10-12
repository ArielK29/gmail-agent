// Starting a payment and opening the portal (issue #22), against a fake database and a fake Polar.
//   node --test supabase/functions/polar-billing/billing.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, type Row } from '../gmail-sync/testkit.ts';
import { createCheckout, createPortal, polarBase } from './billing.ts';

const NOW = Date.parse('2026-10-13T08:00:00Z');
const U = '11111111-1111-4111-8111-111111111111';
const ENV = { token: ['polar', 'oat', 'test'].join('_'), productId: 'prod_pro', server: 'sandbox', appUrl: 'https://arielk29.github.io/gmail-agent/' };
const user = { id: U, email: 'dana@example.com' };

function fakePolar(reply: { status?: number; json?: any; throws?: boolean } = {}) {
  const calls: Array<{ url: string; init: any; body: any }> = [];
  const fn = (async (url: any, init: any) => {
    calls.push({ url: String(url), init, body: JSON.parse(init.body) });
    if (reply.throws) throw new Error('network');
    return new Response(JSON.stringify(reply.json ?? { url: 'https://sandbox.polar.sh/checkout/abc' }), { status: reply.status ?? 201 });
  }) as typeof fetch;
  return { fn, calls };
}
const world = (subs: Row[] = [], failing: Record<string, any> = {}) => makeDb({ subscriptions: subs }, failing);

test('the Polar address: sandbox unless production is chosen on purpose', () => {
  assert.equal(polarBase(undefined), 'https://sandbox-api.polar.sh/v1');
  assert.equal(polarBase('sandbox'), 'https://sandbox-api.polar.sh/v1');
  assert.equal(polarBase('production'), 'https://api.polar.sh/v1');
  for (const odd of ['Production', 'prod', '', 'live', ' production']) assert.equal(polarBase(odd), 'https://sandbox-api.polar.sh/v1', odd);
});

test('checkout: asks Polar for the one product we chose, tagged with the member\'s own id, and returns Polar\'s payment page', async () => {
  const polar = fakePolar();
  const answer = await createCheckout(world() as any, user, 'pro', ENV, NOW, polar.fn);
  assert.deepEqual(answer, { status: 200, body: { url: 'https://sandbox.polar.sh/checkout/abc' } });
  const call = polar.calls[0];
  assert.equal(call.url, 'https://sandbox-api.polar.sh/v1/checkouts/');
  assert.equal(call.init.headers.Authorization, `Bearer ${ENV.token}`);
  assert.deepEqual(call.body, { products: ['prod_pro'], external_customer_id: U, customer_email: 'dana@example.com', success_url: 'https://arielk29.github.io/gmail-agent/?billing=success', return_url: 'https://arielk29.github.io/gmail-agent/', metadata: { user_id: U } });
  const withQuery = fakePolar();
  await createCheckout(world() as any, user, 'pro', { ...ENV, appUrl: 'https://x.example/app?lang=he' }, NOW, withQuery.fn);
  assert.equal(withQuery.calls[0].body.success_url, 'https://x.example/app?lang=he&billing=success');
});

test('checkout: secrets pasted with a trailing newline or spaces still work (found in the first sandbox payment test: fetch throws on such a header)', async () => {
  const strict = (async (url: any, init: any) => {
    if (/[\r\n]/.test(init.headers.Authorization) || /\s$/.test(init.headers.Authorization)) throw new TypeError('invalid header value'); // like a real fetch
    return new Response(JSON.stringify({ url: 'https://sandbox.polar.sh/checkout/abc', productSeen: JSON.parse(init.body).products[0] }), { status: 201 });
  }) as typeof fetch;
  const dirty = { ...ENV, token: `${ENV.token}\n`, productId: ' prod_pro\r\n', appUrl: 'https://arielk29.github.io/gmail-agent/ ' };
  const answer = await createCheckout(world() as any, user, 'pro', dirty, NOW, strict);
  assert.deepEqual(answer, { status: 200, body: { url: 'https://sandbox.polar.sh/checkout/abc' } });
  const portal = await createPortal(world([{ user_id: U, source: 'polar', polar_customer_id: 'cus_1' }]) as any, user, dirty, (async () => new Response(JSON.stringify({ customer_portal_url: 'https://sandbox.polar.sh/portal/x' }), { status: 201 })) as typeof fetch);
  assert.equal(portal.status, 200);
  // a value that is only whitespace counts as not configured
  assert.equal((await createCheckout(world() as any, user, 'pro', { ...ENV, token: ' \n' }, NOW, strict)).status, 503);
});

test('checkout: the member cannot choose the product, the price or anybody else\'s id', async () => {
  for (const plan of ['free', 'enterprise', '', null, undefined, { id: 'prod_other' }, ['pro'], 'PRO']) {
    const polar = fakePolar();
    assert.deepEqual(await createCheckout(world() as any, user, plan, ENV, NOW, polar.fn), { status: 400, body: { error: 'unknown_plan' } }, String(plan));
    assert.equal(polar.calls.length, 0);
  }
  const polar = fakePolar();
  await createCheckout(world() as any, { id: U, email: 'bad@@x, y@z.com' }, 'pro', ENV, NOW, polar.fn);
  assert.equal('customer_email' in polar.calls[0].body, false, 'an odd address is not passed on');
});

test('checkout: not configured (no token, no product, no https address) asks nothing from Polar', async () => {
  for (const env of [{}, { ...ENV, token: undefined }, { ...ENV, productId: '' }, { ...ENV, appUrl: undefined }, { ...ENV, appUrl: 'http://insecure.example/' }, { ...ENV, appUrl: 'javascript:alert(1)' }]) {
    const polar = fakePolar();
    assert.deepEqual(await createCheckout(world() as any, user, 'pro', env, NOW, polar.fn), { status: 503, body: { error: 'not_configured' } }, JSON.stringify(env));
    assert.equal(polar.calls.length, 0);
  }
});

test('checkout: a member who already pays gets "already subscribed" (no second subscription); a lapsed or cancelled one may buy again', async () => {
  const active = world([{ user_id: U, status: 'active', current_period_end: new Date(NOW + 10 * 86400_000).toISOString() }]);
  const polar = fakePolar();
  assert.deepEqual(await createCheckout(active as any, user, 'pro', ENV, NOW, polar.fn), { status: 409, body: { error: 'already_subscribed' } });
  assert.equal(polar.calls.length, 0);
  for (const sub of [{ status: 'canceled', current_period_end: null }, { status: 'active', current_period_end: new Date(NOW - 20 * 86400_000).toISOString() }, { status: 'unpaid', current_period_end: null }]) {
    const again = fakePolar();
    assert.equal((await createCheckout(world([{ user_id: U, ...sub }]) as any, user, 'pro', ENV, NOW, again.fn)).status, 200, JSON.stringify(sub));
  }
});

test('checkout: Polar refusing, being unreachable, or answering with something odd gives a clear failure and never a made-up address', async () => {
  for (const reply of [{ status: 422, json: { detail: 'bad' } }, { status: 500 }, { throws: true }, { status: 201, json: {} }, { status: 201, json: { url: 'http://insecure.example/' } }, { status: 201, json: { url: 'javascript:alert(1)' } }, { status: 201, json: { url: 5 } }, { status: 201, json: { url: 'https://evil.example/polar.sh' } }, { status: 201, json: { url: 'https://polar.sh.evil.example/checkout' } }, { status: 201, json: { url: 'https://notpolar.sh/checkout' } }]) {
    const polar = fakePolar(reply as any);
    assert.deepEqual(await createCheckout(world() as any, user, 'pro', ENV, NOW, polar.fn), { status: 502, body: { error: 'checkout_failed' } }, JSON.stringify(reply));
  }
  const broken = world([], { 'subscriptions.select': true });
  assert.deepEqual(await createCheckout(broken as any, user, 'pro', ENV, NOW, fakePolar().fn), { status: 500, body: { error: 'read_failed' } });
});

test('portal: opens the portal of the member\'s own Polar customer; refuses members without a Polar subscription and manual grants', async () => {
  const db = world([{ user_id: U, source: 'polar', polar_customer_id: 'cus_1', status: 'active' }]);
  const polar = fakePolar({ status: 201, json: { customer_portal_url: 'https://sandbox.polar.sh/portal/xyz' } });
  assert.deepEqual(await createPortal(db as any, user, ENV, polar.fn), { status: 200, body: { url: 'https://sandbox.polar.sh/portal/xyz' } });
  assert.equal(polar.calls[0].url, 'https://sandbox-api.polar.sh/v1/customer-sessions/');
  assert.deepEqual(polar.calls[0].body, { customer_id: 'cus_1', return_url: ENV.appUrl });
  const other = { id: '22222222-2222-4222-8222-222222222222' };
  const p2 = fakePolar();
  assert.deepEqual(await createPortal(db as any, other, ENV, p2.fn), { status: 409, body: { error: 'no_subscription' } }, 'somebody else cannot open this customer\'s portal');
  assert.deepEqual(await createPortal(world([{ user_id: U, source: 'manual', polar_customer_id: 'cus_left_over', status: 'active' }]) as any, user, ENV, p2.fn), { status: 409, body: { error: 'no_subscription' } });
  assert.equal(p2.calls.length, 0);
  assert.deepEqual(await createPortal(db as any, user, {}, p2.fn), { status: 503, body: { error: 'not_configured' } });
  for (const reply of [{ status: 500 }, { throws: true }, { status: 201, json: {} }, { status: 201, json: { customer_portal_url: 'http://x.example' } }, { status: 201, json: { customer_portal_url: 'https://evil.example/portal' } }]) assert.deepEqual(await createPortal(db as any, user, ENV, fakePolar(reply as any).fn), { status: 502, body: { error: 'portal_failed' } });
});

test('checkout: a trialing member or one whose payment is being retried (past_due) also cannot buy a second subscription', async () => {
  for (const sub of [{ status: 'trialing', current_period_end: new Date(NOW + 5 * 86400_000).toISOString() }, { status: 'past_due', current_period_end: new Date(NOW - 86400_000).toISOString() }, { status: 'active', current_period_end: null }]) {
    const polar = fakePolar();
    assert.deepEqual(await createCheckout(world([{ user_id: U, ...sub }]) as any, user, 'pro', ENV, NOW, polar.fn), { status: 409, body: { error: 'already_subscribed' } }, JSON.stringify(sub));
    assert.equal(polar.calls.length, 0);
  }
});