// Polar webhooks and the Pro rule (issue #22): signature, translation of events, the real handler against a fake database.
//   node --test supabase/functions/polar-webhook/webhook.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { makeDb, rng, type Row } from '../gmail-sync/testkit.ts';
import { verifySignature, parseSubscriptionEvent, TOLERANCE_SECONDS } from './webhook.ts';
import { handleWebhook } from './handler.ts';
import { isPro, hasProAccess, GRACE_MS, liveRow, serverKind } from './entitlement.ts';

const NOW = Date.parse('2026-10-13T08:00:00Z');
const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const SECRET = ['whsec', Buffer.from(['a', 'test', 'secret', 'of', 'some', 'length', '0123456789'].join('-')).toString('base64')].join('_'); // built at run time: a made-up test value, not a real secret
const RAW_SECRET = ['polar', 'whs', 'plain', 'test', 'secret', 'value'].join('_');

// A message signed the way Polar does it (Standard Webhooks).
function signed(secret: string, body: string, opts: { id?: string; ts?: number; keyMode?: 'standard' | 'legacy'; tamper?: boolean } = {}) {
  const id = opts.id ?? 'evt_1';
  const ts = String(opts.ts ?? Math.floor(NOW / 1000));
  const key = opts.keyMode === 'legacy' || !secret.startsWith('whsec_') ? Buffer.from(secret, 'utf8') : Buffer.from(secret.slice(6), 'base64');
  const signature = 'v1,' + createHmac('sha256', key).update(`${id}.${ts}.${opts.tamper ? body + ' ' : body}`).digest('base64');
  return { headers: { id, timestamp: ts, signature }, rawBody: body };
}

// ---------------------------------------------------------------- the Pro rule
const row = (status: string, endOffsetMs: number | null) => ({ status, current_period_end: endOffsetMs === null ? null : new Date(NOW + endOffsetMs).toISOString() });
test('isPro: live subscriptions yes, until the period end plus three days; past_due only inside the grace; the rest no; manual grants never expire', () => {
  assert.equal(isPro(row('active', 5 * 86400_000), NOW), true);
  assert.equal(isPro(row('trialing', 86400_000), NOW), true);
  assert.equal(isPro(row('active', -GRACE_MS + 1000), NOW), true, 'inside the grace after the period end');
  assert.equal(isPro(row('active', -GRACE_MS - 1000), NOW), false, 'a missed revoked message cannot keep somebody Pro for ever');
  assert.equal(isPro(row('past_due', -86400_000), NOW), true);
  assert.equal(isPro(row('past_due', 86400_000), NOW), true);
  assert.equal(isPro(row('past_due', -GRACE_MS - 1000), NOW), false);
  assert.equal(isPro(row('past_due', null), NOW), false, 'no date: past_due is not trusted');
  for (const status of ['canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'vip', null, undefined, 5]) assert.equal(isPro({ status: status as any, current_period_end: null }, NOW), false, String(status));
  assert.equal(isPro(row('active', null), NOW), true, 'manual grant: no period end');
  for (const junk of [null, undefined, 5, 'x', [], {}]) assert.equal(isPro(junk as any, NOW), false);
  assert.equal(isPro({ status: 'active', current_period_end: 'garbage' }, NOW), true, 'an unreadable date is treated like no date');
});

test('hasProAccess: while billing is not enforced everybody has everything; only a real true enforces', () => {
  for (const off of [false, null, undefined, 'true', 1, {}, 'yes']) assert.equal(hasProAccess(off, null, NOW), true, String(off));
  assert.equal(hasProAccess(true, null, NOW), false);
  assert.equal(hasProAccess(true, row('active', 86400_000), NOW), true);
  assert.equal(hasProAccess(true, row('canceled', 86400_000), NOW), false);
});

test('all copies of entitlement.ts are identical (a function can only import its own folder)', () => {
  const here = readFileSync(new URL('./entitlement.ts', import.meta.url), 'utf8');
  for (const other of ['../gmail-sync/entitlement.ts', '../polar-billing/entitlement.ts', '../gmail-connect/entitlement.ts']) assert.equal(readFileSync(new URL(other, import.meta.url), 'utf8'), here, other);
});

// ---------------------------------------------------------------- signature
test('signature: a message signed with our secret passes, with either reading of the secret', async () => {
  const body = '{"type":"subscription.active"}';
  assert.equal(await verifySignature(SECRET, signed(SECRET, body).headers, body, NOW), true, 'standard reading');
  assert.equal(await verifySignature(SECRET, signed(SECRET, body, { keyMode: 'legacy' }).headers, body, NOW), true, 'legacy reading (the whole text as the key)');
  assert.equal(await verifySignature(RAW_SECRET, signed(RAW_SECRET, body).headers, body, NOW), true, 'a secret without the whsec_ prefix');
});

test('signature: forged, tampered, wrong secret, wrong id or wrong timestamp all fail', async () => {
  const body = '{"type":"subscription.active","data":{"id":"s1"}}';
  const good = signed(SECRET, body);
  assert.equal(await verifySignature(SECRET, good.headers, body + ' ', NOW), false, 'the body changed after signing');
  assert.equal(await verifySignature(SECRET, signed(SECRET, body, { tamper: true }).headers, body, NOW), false);
  assert.equal(await verifySignature('whsec_' + Buffer.from('another-secret-value-xxxxxxxxxxxxxxxxx').toString('base64'), good.headers, body, NOW), false, 'signed with a different secret');
  assert.equal(await verifySignature(SECRET, { ...good.headers, id: 'evt_2' }, body, NOW), false, 'the id is part of what is signed');
  assert.equal(await verifySignature(SECRET, { ...good.headers, timestamp: String(Number(good.headers.timestamp) + 1) }, body, NOW), false, 'so is the timestamp');
  assert.equal(await verifySignature(SECRET, { ...good.headers, signature: 'v1,AAAA' }, body, NOW), false);
  assert.equal(await verifySignature(SECRET, { ...good.headers, signature: good.headers.signature.replace('v1,', 'v2,') }, body, NOW), false, 'only version v1 is accepted');
});

test('signature: replays and clock tricks - older or newer than five minutes fail, exactly five minutes passes; bad formats fail', async () => {
  const body = '{}';
  const at = (offsetSec: number) => signed(SECRET, body, { ts: Math.floor(NOW / 1000) + offsetSec });
  assert.equal(await verifySignature(SECRET, at(-TOLERANCE_SECONDS).headers, body, NOW), true);
  assert.equal(await verifySignature(SECRET, at(-TOLERANCE_SECONDS - 5).headers, body, NOW), false, 'an old message replayed');
  assert.equal(await verifySignature(SECRET, at(TOLERANCE_SECONDS + 5).headers, body, NOW), false, 'a message from the future');
  const good = signed(SECRET, body);
  for (const headers of [{ ...good.headers, id: null }, { ...good.headers, timestamp: null }, { ...good.headers, signature: null }, { ...good.headers, timestamp: 'abc' }, { ...good.headers, timestamp: '1.5e9' }, { ...good.headers, timestamp: '-5' }, { ...good.headers, id: 'x'.repeat(201) }, { ...good.headers, signature: '' }]) {
    assert.equal(await verifySignature(SECRET, headers as any, body, NOW), false, JSON.stringify(headers).slice(0, 80));
  }
  for (const secret of ['', '   ', undefined as any, null as any]) assert.equal(await verifySignature(secret, good.headers, body, NOW), false, 'no secret, no trust');
});

test('signature: several signatures in one header (key rotation): any matching one passes', async () => {
  const body = '{"a":1}';
  const good = signed(SECRET, body);
  const header = `v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= ${good.headers.signature}`;
  assert.equal(await verifySignature(SECRET, { ...good.headers, signature: header }, body, NOW), true);
});

// ---------------------------------------------------------------- translation
const PRODUCT = 'c0a5bcf3-700a-4076-9eed-9b3d542be0fb'; // a made-up product id for the tests
const CFG = { productId: PRODUCT, server: 'sandbox' };
const subscriptionEvent = (over: any = {}, type = 'subscription.active') => ({
  type,
  data: { id: 'sub_1', product_id: PRODUCT, status: 'active', current_period_end: '2026-11-13T08:00:00Z', cancel_at_period_end: false, modified_at: '2026-10-13T08:00:00Z', customer: { id: 'cus_1', external_id: U1 }, ...over },
});
test('events: a subscription event becomes our row for the member whose id we gave Polar', () => {
  const parsed = parseSubscriptionEvent(subscriptionEvent());
  assert.deepEqual(parsed, { kind: 'subscription', userId: U1, productId: PRODUCT, row: { status: 'active', current_period_end: '2026-11-13T08:00:00.000Z', cancel_at_period_end: false, polar_customer_id: 'cus_1', polar_subscription_id: 'sub_1', polar_modified_at: '2026-10-13T08:00:00.000Z' } });
  assert.equal((parseSubscriptionEvent(subscriptionEvent({ customer: { id: 'cus_1' }, metadata: { user_id: U2 } })) as any).userId, U2, 'the metadata is the fallback');
  assert.equal((parseSubscriptionEvent(subscriptionEvent({ cancel_at_period_end: true, status: 'active' })) as any).row.cancel_at_period_end, true);
  assert.equal((parseSubscriptionEvent(subscriptionEvent({ modified_at: null, created_at: '2026-10-01T00:00:00Z' })) as any).row.polar_modified_at, '2026-10-01T00:00:00.000Z');
  for (const status of ['trialing', 'past_due', 'canceled', 'unpaid', 'incomplete', 'incomplete_expired']) assert.equal((parseSubscriptionEvent(subscriptionEvent({ status }, 'subscription.updated')) as any).row.status, status);
});

test('events: everything that is not clearly ours is ignored, never an exception', () => {
  const ignored = (payload: any) => assert.equal(parseSubscriptionEvent(payload).kind, 'ignore', JSON.stringify(payload).slice(0, 100));
  ignored(null); ignored('x'); ignored(5); ignored([]); ignored({}); ignored({ type: 5 });
  ignored({ type: 'order.paid', data: {} });
  ignored({ type: 'customer.state_changed', data: { id: 'x' } });
  ignored({ type: 'subscription.active' });
  ignored({ type: 'subscription.active', data: 'x' });
  ignored(subscriptionEvent({ id: '' })); ignored(subscriptionEvent({ id: 'x'.repeat(101) })); ignored(subscriptionEvent({ id: 5 }));
  ignored(subscriptionEvent({ status: 'vip' })); ignored(subscriptionEvent({ status: undefined }));
  ignored(subscriptionEvent({ customer: { id: 'cus', external_id: 'not-a-uuid' } }));
  ignored(subscriptionEvent({ customer: { id: 'cus', external_id: "'; drop table subscriptions; --" } }));
  ignored(subscriptionEvent({ customer: undefined, metadata: undefined }));
});

test('fuzz: 3000 random payloads never throw, and a result always carries a real uuid and a known status', () => {
  const r = rng(31);
  const junk = () => [null, undefined, 5, 'x', '', U1, 'active', 'canceled', '2026-10-13T00:00:00Z', {}, [], true, 'x'.repeat(300)][Math.floor(r() * 13)];
  for (let n = 0; n < 3000; n++) {
    const payload = { type: ['subscription.active', 'subscription.revoked', 'order.paid', junk()][Math.floor(r() * 4)], data: { id: junk(), status: junk(), current_period_end: junk(), cancel_at_period_end: junk(), modified_at: junk(), customer: { id: junk(), external_id: junk() }, metadata: { user_id: junk() } } };
    const parsed = parseSubscriptionEvent(payload);
    if (parsed.kind === 'subscription') {
      assert.match(parsed.userId, /^[0-9a-f-]{36}$/);
      assert.ok(['incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid'].includes(parsed.row.status));
      assert.ok(parsed.row.polar_subscription_id.length >= 1 && parsed.row.polar_subscription_id.length <= 100);
    }
  }
});

// ---------------------------------------------------------------- the handler
const makeWorld = (subs: Row[] = [], failing: Record<string, any> = {}) => makeDb({ subscriptions: subs, polar_events: [] }, failing);
const send = (db: any, event: any, opts: { id?: string; ts?: number; secret?: string; signWith?: string; config?: any } = {}, now = NOW) =>
  handleWebhook(db, signed(opts.signWith ?? opts.secret ?? SECRET, JSON.stringify(event), { id: opts.id ?? 'evt_1', ts: Math.floor(now / 1000) }), opts.secret ?? SECRET, now, opts.config ?? CFG);
const subOf = (db: any, user = U1) => db.tables.subscriptions.find((s: Row) => s.user_id === user);

test('handler: a valid message saves the subscription; the member becomes Pro', async () => {
  const db = makeWorld();
  const answer = await send(db, subscriptionEvent());
  assert.deepEqual(answer, { status: 200, body: { applied: true } });
  assert.equal(isPro(subOf(db), NOW), true);
  assert.deepEqual([subOf(db).source, subOf(db).plan, subOf(db).polar_subscription_id], ['polar', 'pro', 'sub_1']);
});

test('handler: forged, unsigned, expired and unconfigured messages change nothing', async () => {
  const db = makeWorld();
  assert.equal((await send(db, subscriptionEvent(), { signWith: 'whsec_' + Buffer.from('attacker-secret-xxxxxxxxxxxxxxxxxxxx').toString('base64') })).status, 403);
  assert.equal((await handleWebhook(db as any, { headers: { id: 'evt_9', timestamp: null, signature: null }, rawBody: JSON.stringify(subscriptionEvent()) }, SECRET, NOW, CFG)).status, 403);
  assert.equal((await send(db, subscriptionEvent(), {}, NOW)).status, 200);
  const old = signed(SECRET, JSON.stringify(subscriptionEvent({ status: 'canceled' })), { id: 'evt_old', ts: Math.floor(NOW / 1000) - 3600 });
  assert.equal((await handleWebhook(makeWorld() as any, old, SECRET, NOW, CFG)).status, 403, 'a replayed old message');
  assert.equal((await handleWebhook(makeWorld() as any, signed(SECRET, '{}'), undefined, NOW, CFG)).status, 503);
  assert.equal((await handleWebhook(makeWorld() as any, signed(SECRET, '{}'), '  ', NOW, CFG)).status, 503);
  const empty = makeWorld();
  await send(empty, subscriptionEvent(), { signWith: 'whsec_' + Buffer.from('attacker-secret-xxxxxxxxxxxxxxxxxxxx').toString('base64') });
  assert.deepEqual([empty.tables.subscriptions.length, empty.tables.polar_events.length], [0, 0], 'a rejected message leaves no trace at all');
});

test('handler: a secret pasted with a trailing newline or spaces still verifies real messages (otherwise every payment would be refused)', async () => {
  for (const dirty of [SECRET + '\n', ' ' + SECRET + ' ', SECRET + '\r\n']) {
    const db = makeWorld();
    const answer = await send(db, subscriptionEvent(), { secret: dirty, signWith: SECRET });
    assert.deepEqual(answer, { status: 200, body: { applied: true } }, JSON.stringify(dirty));
    assert.equal(isPro(subOf(db), NOW), true);
  }
});

test('handler: bad JSON with a good signature is a 400 and leaves no trace', async () => {
  const db = makeWorld();
  const answer = await handleWebhook(db as any, signed(SECRET, '{not json'), SECRET, NOW, CFG);
  assert.equal(answer.status, 400);
  assert.deepEqual([db.tables.subscriptions.length, db.tables.polar_events.length], [0, 0]);
});

test('handler: the same message twice (and three at once) leaves one row with the same content; a finished message is recognised as a duplicate', async () => {
  const db = makeWorld();
  const answers = await Promise.all([send(db, subscriptionEvent()), send(db, subscriptionEvent()), send(db, subscriptionEvent())]);
  assert.ok(answers.every((x) => x.status === 200));
  assert.ok(answers.some((x) => x.body.applied === true));
  assert.equal(db.tables.subscriptions.length, 1, 'idempotent: applying it again changes nothing');
  assert.equal(subOf(db).status, 'active');
  assert.deepEqual(await send(db, subscriptionEvent()), { status: 200, body: { duplicate: true } });
});

test('handler: an old message arriving after a newer one does not undo it; an equal or newer one applies', async () => {
  const db = makeWorld();
  await send(db, subscriptionEvent({ status: 'canceled', modified_at: '2026-10-13T10:00:00Z' }, 'subscription.revoked'), { id: 'e-new' });
  assert.deepEqual(await send(db, subscriptionEvent({ status: 'active', modified_at: '2026-10-13T09:00:00Z' }, 'subscription.active'), { id: 'e-old' }), { status: 200, body: { ignored: 'older_than_stored' } });
  assert.equal(subOf(db).status, 'canceled');
  assert.equal((await send(db, subscriptionEvent({ status: 'active', modified_at: '2026-10-13T10:00:00Z' }), { id: 'e-same' })).body.applied, true);
  assert.equal(subOf(db).status, 'active');
  assert.equal((await send(db, subscriptionEvent({ status: 'canceled', modified_at: '2026-10-13T11:00:00Z' }, 'subscription.revoked'), { id: 'e-later' })).body.applied, true);
  assert.equal(isPro(subOf(db), NOW), false);
});

test('handler: a manual grant (the owner) is never overwritten; events for other things are acknowledged and ignored', async () => {
  const db = makeWorld([{ user_id: U1, source: 'manual', status: 'active', plan: 'pro', current_period_end: null, polar_modified_at: null }]);
  assert.deepEqual(await send(db, subscriptionEvent({ status: 'canceled' }, 'subscription.revoked')), { status: 200, body: { ignored: 'manual_grant' } });
  assert.equal(subOf(db).status, 'active');
  assert.equal(subOf(db).source, 'manual');
  assert.deepEqual(await send(db, { type: 'order.paid', data: { id: 'o1' } }, { id: 'e-order' }), { status: 200, body: { ignored: 'not_a_subscription_event' } });
  assert.deepEqual(await send(db, subscriptionEvent({ customer: { id: 'c', external_id: 'not-a-uuid' } }), { id: 'e-stranger' }), { status: 200, body: { ignored: 'no_member' } });
});

test('handler: a failed save answers 500 and records nothing, so Polar tries again and the payment is not lost', async () => {
  const db = makeWorld([], { 'subscriptions.insert': true });
  assert.equal((await send(db, subscriptionEvent())).status, 500);
  assert.equal(db.tables.polar_events.length, 0, 'an unfinished message is never recorded as done');
  delete db.failing['subscriptions.insert'];
  assert.deepEqual(await send(db, subscriptionEvent()), { status: 200, body: { applied: true } });
  assert.equal(isPro(subOf(db), NOW), true);
  const broken = makeWorld([], { 'subscriptions.select': true });
  assert.equal((await send(broken, subscriptionEvent())).status, 500);
  assert.equal(broken.tables.polar_events.length, 0);
  const noRecord = makeWorld([], { 'polar_events.insert': true });
  assert.equal((await send(noRecord, subscriptionEvent())).status, 200, 'remembering finished messages is best effort: the payment is saved');
  assert.equal(isPro(subOf(noRecord), NOW), true);
  const noLookup = makeWorld([], { 'polar_events.select': true });
  assert.equal((await send(noLookup, subscriptionEvent())).status, 200, 'a failed duplicate lookup only costs a second, harmless run');
});

test('handler: a deleted member or a subscription that belongs to someone else is acknowledged without saving', async () => {
  const gone = makeWorld([], { 'subscriptions.insert': { code: '23503', message: 'fk' } });
  assert.deepEqual(await send(gone, subscriptionEvent()), { status: 200, body: { ignored: 'unknown_member' } });
  const db = makeWorld([{ user_id: U2, source: 'polar', status: 'active', plan: 'pro', polar_subscription_id: 'sub_1', polar_modified_at: null }]);
  assert.deepEqual(await send(db, subscriptionEvent()), { status: 200, body: { ignored: 'subscription_of_another_member' } });
  assert.equal(db.tables.subscriptions.length, 1);
});

test('handler: old webhook ids are cleaned up, recent ones are kept', async () => {
  const db = makeWorld();
  db.tables.polar_events.push({ webhook_id: 'ancient', type: 'x', received_at: new Date(NOW - 40 * 86400_000).toISOString() }, { webhook_id: 'recent', type: 'x', received_at: new Date(NOW - 86400_000).toISOString() });
  await send(db, subscriptionEvent());
  assert.deepEqual(db.tables.polar_events.map((e: Row) => e.webhook_id).sort(), ['evt_1', 'recent']);
});

test('chaos: random order, repeats, forged messages and database failures - the stored state always equals the newest valid message, forged ones never count', async () => {
  for (let seed = 1; seed <= 40; seed++) {
    const r = rng(seed * 6007);
    const db = makeWorld();
    const stream: Array<{ event: any; id: string; forged: boolean; modified: number }> = [];
    const statuses = ['active', 'past_due', 'canceled', 'trialing'];
    for (let i = 0; i < 10; i++) {
      const modified = Date.parse('2026-10-13T00:00:00Z') + i * 60_000;
      stream.push({ id: 'e' + i, forged: r() < 0.2, modified, event: subscriptionEvent({ status: statuses[Math.floor(r() * statuses.length)], modified_at: new Date(modified).toISOString() }, 'subscription.updated') });
    }
    const order = [...stream, ...stream.filter(() => r() < 0.5)].sort(() => r() - 0.5);
    for (const item of order) {
      db.failing['subscriptions.insert'] = r() < 0.15; db.failing['subscriptions.update'] = r() < 0.15;
      db.failing['subscriptions.select'] = r() < 0.1;
      db.failing['polar_events.insert'] = r() < 0.1;
      await send(db, item.event, { id: item.id, signWith: item.forged ? 'whsec_' + Buffer.from('attacker-secret-xxxxxxxxxxxxxxxxxxxx').toString('base64') : SECRET });
    }
    // Polar keeps retrying until it gets a 200: healing, then every valid message arrives again
    for (const key of Object.keys(db.failing)) delete db.failing[key];
    for (const item of order) await send(db, item.event, { id: item.id, signWith: item.forged ? 'whsec_' + Buffer.from('attacker-secret-xxxxxxxxxxxxxxxxxxxx').toString('base64') : SECRET });
    const valid = stream.filter((s) => !s.forged);
    const newest = valid.sort((a, b) => b.modified - a.modified)[0];
    if (!newest) { assert.equal(db.tables.subscriptions.length, 0, `seed ${seed}: only forged messages`); continue; }
    assert.equal(subOf(db).status, newest.event.data.status, `seed ${seed}: the newest valid message wins`);
    assert.equal(db.tables.subscriptions.length, 1);
  }
});

test('handler: a late message about the end of an OLD subscription does not switch off a newer live one', async () => {
  const db = makeWorld();
  await send(db, subscriptionEvent({ id: 'sub_new', status: 'active', modified_at: '2026-10-13T10:00:00Z' }), { id: 'e-new' });
  const late = await send(db, subscriptionEvent({ id: 'sub_old', status: 'canceled', modified_at: '2026-10-13T11:00:00Z' }, 'subscription.revoked'), { id: 'e-old-ended' });
  assert.deepEqual(late, { status: 200, body: { ignored: 'other_subscription_still_active' } });
  assert.equal(subOf(db).polar_subscription_id, 'sub_new');
  assert.equal(isPro(subOf(db), NOW), true);
  // but a live message about a different subscription (the member bought again after the old one ended) is applied
  const ended = makeWorld([{ user_id: U1, source: 'polar', status: 'canceled', plan: 'pro', current_period_end: null, polar_subscription_id: 'sub_old', polar_modified_at: '2026-10-01T00:00:00.000Z' }]);
  assert.equal((await send(ended, subscriptionEvent({ id: 'sub_new', status: 'active', modified_at: '2026-10-13T10:00:00Z' }), { id: 'e-buy-again' })).body.applied, true);
  assert.equal(subOf(ended).polar_subscription_id, 'sub_new');
});

test('handler: an oversized body is refused before anything else; a message without modified_at uses the event time', async () => {
  const db = makeWorld();
  const big = 'x'.repeat(300 * 1024);
  const answer = await handleWebhook(db as any, signed(SECRET, JSON.stringify({ type: 'subscription.active', pad: big })), SECRET, NOW, CFG);
  assert.deepEqual(answer, { status: 413, body: { error: 'too_large' } });
  const parsed = parseSubscriptionEvent({ type: 'subscription.active', timestamp: '2026-10-13T12:00:00Z', data: { id: 's1', status: 'active', customer: { id: 'c', external_id: U1 } } }) as any;
  assert.equal(parsed.row.polar_modified_at, '2026-10-13T12:00:00.000Z');
});

test('handler: two messages arriving at the same moment, in either order, leave the NEWER one on top', async () => {
  const older = subscriptionEvent({ status: 'active', modified_at: '2026-10-13T09:00:00Z' }, 'subscription.active');
  const newer = subscriptionEvent({ status: 'canceled', modified_at: '2026-10-13T10:00:00Z' }, 'subscription.revoked');
  for (const order of [[older, newer], [newer, older]]) {
    const db = makeWorld();
    await Promise.all(order.map((event, i) => send(db, event, { id: 'race-' + i })));
    assert.equal(db.tables.subscriptions.length, 1);
    assert.equal(subOf(db).status, 'canceled', 'the newer message wins whatever the arrival order');
  }
  // and when the row already exists
  for (const order of [[older, newer], [newer, older]]) {
    const db = makeWorld([{ user_id: U1, source: 'polar', status: 'trialing', plan: 'pro', polar_subscription_id: 'sub_1', polar_modified_at: '2026-10-13T08:00:00.000Z' }]);
    await Promise.all(order.map((event, i) => send(db, event, { id: 'race2-' + i })));
    assert.equal(subOf(db).status, 'canceled');
  }
});

// ---------------------------------------------------------------- issue #24: product allowlist, outcome log, Polar environment
test('events: the product of the subscription is read from product_id or product.id, and only as short text', () => {
  assert.equal((parseSubscriptionEvent(subscriptionEvent({ product_id: undefined, product: { id: 'prod_nested' } })) as any).productId, 'prod_nested');
  assert.equal((parseSubscriptionEvent(subscriptionEvent({ product_id: 'prod_top', product: { id: 'prod_nested' } })) as any).productId, 'prod_top', 'product_id wins');
  for (const junk of [undefined, null, 5, '', {}, [], 'x'.repeat(101)]) assert.equal((parseSubscriptionEvent(subscriptionEvent({ product_id: junk, product: undefined })) as any).productId, null, String(junk));
});

test('handler: only subscriptions of OUR product change anybody\'s access; other products, a missing product and an unconfigured product are never trusted', async () => {
  const other = makeWorld();
  assert.deepEqual(await send(other, subscriptionEvent({ product_id: 'prod_of_another_app' })), { status: 200, body: { ignored: 'other_product' } });
  assert.equal(other.tables.subscriptions.length, 0, 'nothing saved for a foreign product');
  const none = makeWorld();
  assert.deepEqual(await send(none, subscriptionEvent({ product_id: undefined })), { status: 200, body: { ignored: 'no_product' } });
  assert.equal(none.tables.subscriptions.length, 0);
  for (const config of [{ server: 'sandbox' }, { productId: '', server: 'sandbox' }, { productId: '   ', server: 'sandbox' }, undefined]) {
    const unconfigured = makeWorld();
    const answer = await handleWebhook(unconfigured as any, signed(SECRET, JSON.stringify(subscriptionEvent()), { id: 'evt_u' }), SECRET, NOW, config as any);
    assert.deepEqual(answer, { status: 503, body: { error: 'not_configured' } }, 'Polar retries later; nothing is trusted without our product id');
    assert.equal(unconfigured.tables.subscriptions.length + unconfigured.tables.polar_events.length, 0);
  }
  const ours = makeWorld();
  assert.deepEqual(await send(ours, subscriptionEvent(), { config: { productId: ` ${PRODUCT}\n`, server: 'sandbox' } }), { status: 200, body: { applied: true } }, 'a pasted newline or space in the product id does not break it');
  const sameLooking = makeWorld();
  assert.equal((await send(sameLooking, subscriptionEvent({ product_id: PRODUCT.toUpperCase() }))).body.ignored, 'other_product', 'exact match only');
});

test('handler: every finished message leaves one outcome row (what happened and why), with no payload, no e-mail and no secret', async () => {
  const db = makeWorld();
  await send(db, subscriptionEvent({ customer: { id: 'cus_1', external_id: U1, email: 'secret-person@example.com', name: 'Secret Person' } }), { id: 'evt_a' });
  await send(db, subscriptionEvent({ product_id: 'prod_other' }), { id: 'evt_b' });
  await send(db, { type: 'order.paid', data: { id: 'o1', billing_name: 'Another Person' } }, { id: 'evt_c' });
  const events = db.tables.polar_events;
  assert.deepEqual(events.map((e: Row) => [e.webhook_id, e.outcome, e.reason ?? null]), [['evt_a', 'applied', null], ['evt_b', 'ignored', 'other_product'], ['evt_c', 'ignored', 'not_a_subscription_event']]);
  assert.deepEqual([events[0].user_id, events[0].subscription_status, events[0].current_period_end], [U1, 'active', '2026-11-13T08:00:00.000Z']);
  const allowed = ['webhook_id', 'type', 'outcome', 'reason', 'user_id', 'subscription_status', 'current_period_end'];
  for (const e of events) assert.deepEqual(Object.keys(e).filter((k) => !allowed.includes(k)), [], 'only whitelisted columns are written');
  const text = JSON.stringify(events);
  for (const forbidden of ['secret-person', 'Secret Person', 'Another Person', 'cus_1', SECRET, 'sub_1']) assert.ok(!text.includes(forbidden), `the log must not contain ${forbidden}`);
});

test('handler: a forged, expired or oversized message leaves no outcome row, and a failed save does not either (Polar retries)', async () => {
  const db = makeWorld([], { 'subscriptions.insert': true });
  await send(db, subscriptionEvent(), { id: 'evt_f1', signWith: 'whsec_' + Buffer.from('attacker-secret-xxxxxxxxxxxxxxxxxxxx').toString('base64') });
  await send(db, subscriptionEvent(), { id: 'evt_f2' }); // the save fails
  assert.equal(db.tables.polar_events.length, 0);
});

test('handler: rows are tagged with the Polar environment they come from; only the exact word production means production', async () => {
  for (const [server, expected] of [['sandbox', 'sandbox'], ['production', 'production'], [undefined, 'sandbox'], ['', 'sandbox'], ['Production', 'sandbox'], ['production\n', 'sandbox'], [' production', 'sandbox'], ['live', 'sandbox']] as const) {
    const db = makeWorld();
    await send(db, subscriptionEvent(), { config: { productId: PRODUCT, server } });
    assert.equal(subOf(db).polar_server, expected, String(JSON.stringify(server)));
    assert.equal(serverKind(server), expected);
  }
});

test('liveRow: a subscription written for the OTHER Polar environment is not a subscription here; manual grants always count; untagged old rows are sandbox', () => {
  const polar = (polar_server?: string | null) => ({ source: 'polar', status: 'active', polar_server });
  assert.ok(liveRow(polar('production'), 'production'));
  assert.ok(liveRow(polar('sandbox'), 'sandbox'));
  assert.ok(liveRow(polar('sandbox'), undefined), 'unset server = sandbox');
  assert.equal(liveRow(polar('sandbox'), 'production'), null, 'sandbox test data never grants access in production');
  assert.equal(liveRow(polar('production'), 'sandbox'), null);
  assert.equal(liveRow(polar(null), 'production'), null, 'a row from before the tag existed came from the sandbox');
  assert.equal(liveRow(polar(undefined), 'production'), null);
  assert.ok(liveRow(polar(undefined), 'sandbox'));
  assert.equal(liveRow(polar('production'), 'production\n'), null, 'a typo in the server setting falls back to sandbox, the safe side');
  for (const server of ['sandbox', 'production', undefined]) assert.ok(liveRow({ source: 'manual', status: 'active' }, server), 'manual: ' + server);
  for (const junk of [null, undefined, 5, 'x', []]) assert.equal(liveRow(junk as any, 'production'), null);
});

test('handler: in production a leftover SANDBOX row is replaced by the real subscription even when it looks newer; same-environment ordering still holds', async () => {
  const leftover = { user_id: U1, source: 'polar', status: 'active', plan: 'pro', current_period_end: '2030-01-01T00:00:00.000Z', polar_subscription_id: 'sub_sandbox', polar_modified_at: '2030-01-01T00:00:00.000Z', polar_server: 'sandbox' };
  const db = makeWorld([{ ...leftover }]);
  const answer = await send(db, subscriptionEvent({ id: 'sub_real', modified_at: '2026-10-13T08:00:00Z' }), { config: { productId: PRODUCT, server: 'production' } });
  assert.deepEqual(answer, { status: 200, body: { applied: true } });
  assert.deepEqual([subOf(db).polar_subscription_id, subOf(db).polar_server], ['sub_real', 'production']);
  // a late "ended" message about the sandbox subscription cannot switch the real one off
  const late = await send(db, subscriptionEvent({ id: 'sub_sandbox', status: 'canceled', modified_at: '2026-10-14T08:00:00Z' }, 'subscription.revoked'), { id: 'evt_late', config: { productId: PRODUCT, server: 'production' } });
  assert.equal(subOf(db).polar_subscription_id, 'sub_real');
  assert.notEqual(late.status, 500);
  // inside one environment an older message still cannot undo a newer one
  const same = makeWorld([{ ...leftover, polar_server: 'production', polar_modified_at: '2026-10-13T10:00:00.000Z', polar_subscription_id: 'sub_1' }]);
  assert.deepEqual(await send(same, subscriptionEvent({ modified_at: '2026-10-13T09:00:00Z' }), { config: { productId: PRODUCT, server: 'production' } }), { status: 200, body: { ignored: 'older_than_stored' } });
});

test('handler: nothing the handler prints can contain the secret, the product id of a stranger, e-mails or names', async () => {
  const lines: string[] = [];
  const keep = { error: console.error, log: console.log, warn: console.warn };
  console.error = console.log = console.warn = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    const db = makeWorld([], { 'subscriptions.insert': true });
    await send(db, subscriptionEvent({ customer: { id: 'cus_1', external_id: U1, email: 'leak-me@example.com', name: 'Leak Me' } }), { id: 'evt_leak' });
    await send(makeWorld(), subscriptionEvent({ product_id: 'prod_stranger_xyz' }), { id: 'evt_leak2' });
  } finally { Object.assign(console, keep); }
  const printed = lines.join('\n');
  for (const forbidden of [SECRET, 'leak-me@example.com', 'Leak Me', 'prod_stranger_xyz', 'cus_1']) assert.ok(!printed.includes(forbidden), `printed: ${forbidden}`);
});