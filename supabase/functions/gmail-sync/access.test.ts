// Free and Pro on the server (issue #22): the scan, calendar and tasks, and the e-mail briefing are Pro features once billing is
// enforced, and open to everybody while it is not (the testers phase).   node --test supabase/functions/gmail-sync/access.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, rng, type Row } from './testkit.ts';

const env: Record<string, string> = { GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: ['fake', 'test', 'value'].join('-'), GEMINI_API_KEY: 'key' };
(globalThis as any).Deno = { env: { get: (name: string) => env[name] } };
const { startScan } = await import('./scan.ts');
const { refreshAgenda } = await import('./sync.ts');
const { sendDigests, sendTestDigest } = await import('./digest.ts');
const { memberHasPro, membersWithPro } = await import('./access.ts');

const NOW = Date.parse('2026-10-12T05:30:00Z'); // 08:30 in Jerusalem
const U = 'user-1';
const day = (offset: number) => new Date(NOW + offset * 86400_000).toISOString();
const SCAN_BODY = { consent: true, periodStart: '2026-01-01', periodEnd: '2026-01-31', query: 'invoice' };
const mailRow = () => ({ user_id: U, gmail_message_id: 'm1', from_name: 'Dana <d@x.com>', subject: 'Hello', category: 'personal', received_at: new Date(NOW - 30 * 3600_000).toISOString(), needs_reply: true });

interface World { enforced?: boolean | 'missing'; subs?: Row[]; failing?: Record<string, any> }
function world({ enforced = true, subs = [], failing = {} }: World = {}) {
  return makeDb({
    app_settings: enforced === 'missing' ? [] : [{ key: 'billing_enforced', value: enforced }],
    subscriptions: subs,
    gmail_connections: [{ user_id: U, status: 'active', refresh_token: 'rt', history_id: '1', has_calendar: true, has_tasks: true, agenda_checked_at: null, google_email: 'dana@example.com', digest_email: true, digest_tz: 'Asia/Jerusalem', digest_last_sent_on: null, digest_failures: 0, digest_test_at: null }],
    gmail_digest: [mailRow()],
    gmail_agenda: [],
    gmail_scans: [],
    gmail_usage: [],
  }, failing);
}
const PRO = [{ user_id: U, status: 'active', current_period_end: day(10) }];

const sender = () => { const sent: string[] = []; return { sent, send: async (m: { to: string }) => { sent.push(m.to); return { ok: true as const }; } }; };
function noGoogle(calls: string[]) {
  globalThis.fetch = (async (url: any) => { calls.push(String(url)); return new Response(JSON.stringify({ items: [] }), { status: 200 }); }) as typeof fetch;
}

test('access: while billing is not enforced everybody is Pro; a missing setting row counts as not enforced; only a real true enforces', async () => {
  assert.equal(await memberHasPro(world({ enforced: false }) as any, U, NOW), true);
  assert.equal(await memberHasPro(world({ enforced: 'missing' }) as any, U, NOW), true);
  assert.equal(await memberHasPro(world({ enforced: 'true' as any }) as any, U, NOW), true, 'the text "true" is not the switch');
  assert.equal(await memberHasPro(world({ enforced: true }) as any, U, NOW), false);
  assert.equal(await memberHasPro(world({ enforced: true, subs: PRO }) as any, U, NOW), true);
  assert.equal(await memberHasPro(world({ enforced: true, subs: [{ user_id: U, status: 'canceled', current_period_end: day(10) }] }) as any, U, NOW), false);
  assert.equal(await memberHasPro(world({ enforced: true, subs: [{ user_id: U, status: 'active', current_period_end: day(-30) }] }) as any, U, NOW), false, 'lapsed');
});

test('access: a failing read means "cannot decide" (null), never "yes" and never "no"', async () => {
  assert.equal(await memberHasPro(world({ failing: { 'app_settings.select': true } }) as any, U, NOW), null);
  assert.equal(await memberHasPro(world({ enforced: true, failing: { 'subscriptions.select': true } }) as any, U, NOW), null);
  assert.equal(await membersWithPro(world({ failing: { 'app_settings.select': true } }) as any, [U], NOW), null);
  assert.equal(await membersWithPro(world({ enforced: true, failing: { 'subscriptions.select': true } }) as any, [U], NOW), null);
  const several = world({ enforced: true, subs: [...PRO, { user_id: 'other', status: 'canceled' }] });
  assert.deepEqual([...(await membersWithPro(several as any, [U, 'other', 'third'], NOW))!], [U]);
  assert.deepEqual([...(await membersWithPro(world({ enforced: false }) as any, [U, 'other'], NOW))!], [U, 'other']);
  assert.deepEqual([...(await membersWithPro(world({ enforced: true }) as any, [], NOW))!], []);
});

test('scan: refused for Free (402) once billing is enforced, allowed for Pro, allowed for everybody before; an undecidable access is a clear 503', async () => {
  const free = world({ enforced: true });
  assert.deepEqual(await startScan(free as any, U, SCAN_BODY, new Date(NOW)), { status: 402, body: { error: 'pro_required' } });
  assert.equal(free.tables.gmail_scans.length, 0, 'nothing was started');
  assert.equal((await startScan(world({ enforced: true, subs: PRO }) as any, U, SCAN_BODY, new Date(NOW))).status, 200);
  assert.equal((await startScan(world({ enforced: false }) as any, U, SCAN_BODY, new Date(NOW))).status, 200);
  assert.deepEqual(await startScan(world({ failing: { 'app_settings.select': true } }) as any, U, SCAN_BODY, new Date(NOW)), { status: 503, body: { error: 'access_unknown' } });
  assert.equal((await startScan(world({ enforced: true }) as any, U, { ...SCAN_BODY, consent: false }, new Date(NOW))).status, 400, 'a bad request is still a bad request first');
});

test('calendar and tasks: Free members are not asked about and their saved rows are removed; Pro and testers are refreshed; an undecidable access changes nothing', async () => {
  const saved = [{ user_id: U, kind: 'event', external_id: 'old', title: 'old', all_day: false, starts_at: day(0) }];
  const free = world({ enforced: true }); free.tables.gmail_agenda.push(...saved);
  const calls: string[] = []; noGoogle(calls);
  await refreshAgenda(free as any, free.tables.gmail_connections[0] as any, 'tok', NOW);
  assert.deepEqual(calls, [], 'no request to Google for a Free member');
  assert.equal(free.tables.gmail_agenda.length, 0, 'what was saved while they were Pro is removed');
  assert.equal(free.tables.gmail_connections[0].agenda_checked_at, null);

  for (const w of [world({ enforced: true, subs: PRO }), world({ enforced: false })]) {
    const c: string[] = []; noGoogle(c);
    await refreshAgenda(w as any, w.tables.gmail_connections[0] as any, 'tok', NOW);
    assert.ok(c.length > 0, 'Pro and the testers are asked');
  }
  const unknown = world({ failing: { 'app_settings.select': true } }); unknown.tables.gmail_agenda.push(...saved);
  const c2: string[] = []; noGoogle(c2);
  await refreshAgenda(unknown as any, unknown.tables.gmail_connections[0] as any, 'tok', NOW);
  assert.deepEqual([c2.length, unknown.tables.gmail_agenda.length], [0, 1], 'nothing asked, nothing deleted');
});

test('e-mail briefing: sent to Pro members and testers, not to Free members; a failing access read mails nobody and claims nothing', async () => {
  const free = world({ enforced: true }); const s1 = sender();
  const run1 = await sendDigests(free as any, NOW, s1.send as any);
  assert.deepEqual([s1.sent.length, run1.sent], [0, 0]);
  assert.equal(free.tables.gmail_connections[0].digest_last_sent_on, null, 'the day was not claimed');

  const pro = world({ enforced: true, subs: PRO }); const s2 = sender();
  await sendDigests(pro as any, NOW, s2.send as any);
  assert.deepEqual(s2.sent, ['dana@example.com']);

  const testers = world({ enforced: false }); const s3 = sender();
  await sendDigests(testers as any, NOW, s3.send as any);
  assert.equal(s3.sent.length, 1);

  const unknown = world({ failing: { 'app_settings.select': true } }); const s4 = sender();
  await sendDigests(unknown as any, NOW, s4.send as any);
  assert.deepEqual([s4.sent.length, unknown.tables.gmail_connections[0].digest_last_sent_on], [0, null]);

  const lapsed = world({ enforced: true, subs: [{ user_id: U, status: 'active', current_period_end: day(-30) }] }); const s5 = sender();
  await sendDigests(lapsed as any, NOW, s5.send as any);
  assert.equal(s5.sent.length, 0, 'a subscription that ended stops the mail');
});

test('test e-mail: Pro only (402 for Free), allowed for the testers phase, 503 when the access is undecidable; a refused request does not use up the cooldown', async () => {
  const free = world({ enforced: true }); const s = sender();
  assert.deepEqual(await sendTestDigest(free as any, U, NOW, s.send as any), { status: 402, body: { error: 'pro_required' } });
  assert.deepEqual([s.sent.length, free.tables.gmail_connections[0].digest_test_at], [0, null]);
  assert.equal((await sendTestDigest(world({ enforced: true, subs: PRO }) as any, U, NOW, s.send as any)).status, 200);
  assert.equal((await sendTestDigest(world({ enforced: false }) as any, U, NOW, s.send as any)).status, 200);
  assert.equal((await sendTestDigest(world({ failing: { 'app_settings.select': true } }) as any, U, NOW, s.send as any)).status, 503);
});

test('chaos: random billing state and random failures - a Free member never reaches a Pro feature, a Pro member always does when the reads work', async () => {
  for (let seed = 1; seed <= 60; seed++) {
    const r = rng(seed * 97);
    const kind = ['none', 'active', 'canceled', 'lapsed', 'past_due_old'][Math.floor(r() * 5)];
    const subs = kind === 'none' ? [] : [{ user_id: U, status: kind === 'lapsed' || kind === 'past_due_old' ? (kind === 'lapsed' ? 'active' : 'past_due') : kind, current_period_end: kind === 'active' || kind === 'canceled' ? day(5) : day(-10) }];
    const enforced = r() < 0.7;
    const w = world({ enforced, subs });
    const expectPro = !enforced || kind === 'active';
    assert.equal(await memberHasPro(w as any, U, NOW), expectPro, `seed ${seed} ${kind} enforced=${enforced}`);
    const scan = await startScan(w as any, U, SCAN_BODY, new Date(NOW));
    assert.equal(scan.status === 200, expectPro, `seed ${seed}: scan`);
    const sent = sender();
    await sendDigests(w as any, NOW, sent.send as any);
    assert.equal(sent.sent.length === 1, expectPro, `seed ${seed}: e-mail`);
  }
});
