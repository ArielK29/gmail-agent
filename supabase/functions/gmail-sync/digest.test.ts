// The morning briefing by e-mail (issue #14): the pure decisions (briefing.ts) and the REAL sendDigests (digest.ts) against a fake
// database and a fake sending service.   node --test supabase/functions/gmail-sync/digest.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { makeDb, rng, type Row } from './testkit.ts';

(globalThis as any).Deno = { env: { get: (_name: string) => undefined } };
const { safeTz, localParts, isDueForDigest, isDeliverable, buildBrief, composeEmail, escapeHtml, DEFAULT_TZ, MAX_FAILURES } = await import('./briefing.ts');
const { sendDigests, sendEmail } = await import('./digest.ts');
const page = createRequire(import.meta.url)('../../../docs/logic.js');

const NOW = Date.parse('2026-10-12T05:30:00Z'); // 08:30 in Jerusalem (UTC+3), 01:30 in New York
const hoursAgo = (h: number, now = NOW) => new Date(now - h * 3600_000).toISOString();

// ---------------------------------------------------------------- time zones and the send window
test('safeTz: real IANA names pass, everything else becomes the default (no exception, nothing odd reaches Intl)', () => {
  for (const ok of ['Asia/Jerusalem', 'UTC', 'America/New_York', 'America/Argentina/Buenos_Aires', 'Etc/GMT+5']) assert.equal(safeTz(ok), ok, ok);
  for (const bad of [null, undefined, 5, '', 'Nowhere/City', 'x'.repeat(65), 'Asia/Jerusalem\nBcc: x', '../../etc', 'a b', {}, [], 'Asia/Jerusalem; drop table']) assert.equal(safeTz(bad), DEFAULT_TZ, String(bad));
});

test('localParts: the member\'s own day and hour, also across a date line and a daylight-saving change', () => {
  assert.deepEqual(localParts(NOW, 'Asia/Jerusalem'), { day: '2026-10-12', hour: 8, minute: 30 });
  assert.deepEqual(localParts(NOW, 'America/New_York'), { day: '2026-10-12', hour: 1, minute: 30 });
  assert.deepEqual(localParts(Date.parse('2026-10-11T22:30:00Z'), 'Asia/Jerusalem'), { day: '2026-10-12', hour: 1, minute: 30 }, 'already tomorrow there');
  assert.deepEqual(localParts(Date.parse('2026-10-12T20:00:00Z'), 'Pacific/Auckland'), { day: '2026-10-13', hour: 9, minute: 0 });
  // Israel leaves daylight time on 2026-10-25 at 02:00 (23:00 UTC): the clock goes back to 01:00, so 23:30 UTC is 01:30 and 00:30 UTC is 02:30.
  assert.equal(localParts(Date.parse('2026-10-24T23:30:00Z'), 'Asia/Jerusalem').hour, 1);
  assert.equal(localParts(Date.parse('2026-10-25T00:30:00Z'), 'Asia/Jerusalem').hour, 2);
  assert.equal(localParts(Date.parse('2026-10-25T04:59:00Z'), 'Asia/Jerusalem').hour, 6);
  assert.equal(localParts(Date.parse('2026-10-25T05:00:00Z'), 'Asia/Jerusalem').hour, 7);
});

const base = (over: Row = {}) => ({ status: 'active', digest_email: true, digest_tz: 'Asia/Jerusalem', digest_last_sent_on: null, digest_failures: 0, google_email: 'dana@example.com', ...over });
test('isDueForDigest: only switched on, alive, in the morning window of the member\'s own day, not yet sent today, not failing', () => {
  assert.equal(isDueForDigest(base(), NOW), true);
  assert.equal(isDueForDigest(base({ digest_email: false }), NOW), false);
  assert.equal(isDueForDigest(base({ digest_email: 'true' }), NOW), false, 'only a real true');
  assert.equal(isDueForDigest(base({ status: 'needs_reconnect' }), NOW), false);
  assert.equal(isDueForDigest(base({ digest_last_sent_on: '2026-10-12' }), NOW), false, 'already sent today');
  assert.equal(isDueForDigest(base({ digest_last_sent_on: '2026-10-11' }), NOW), true);
  assert.equal(isDueForDigest(base({ digest_failures: MAX_FAILURES }), NOW), false);
  assert.equal(isDueForDigest(base({ digest_failures: MAX_FAILURES - 1 }), NOW), true);
  assert.equal(isDueForDigest(base({ google_email: null }), NOW), false);
  assert.equal(isDueForDigest(base({ google_email: 'a@b.c\nBcc: x@y.z' }), NOW), false);
  assert.equal(isDueForDigest(base({ digest_tz: 'America/New_York' }), NOW), false, '01:30 there');
  assert.equal(isDueForDigest(base({ digest_tz: 'garbage' }), NOW), true, 'unknown zone: the default zone (08:30 there)');
  const at = (iso: string) => isDueForDigest(base(), Date.parse(iso));
  assert.equal(at('2026-10-12T03:59:00Z'), false, '06:59');
  assert.equal(at('2026-10-12T04:00:00Z'), true, '07:00');
  assert.equal(at('2026-10-12T08:59:00Z'), true, '11:59');
  assert.equal(at('2026-10-12T09:00:00Z'), false, '12:00');
  for (const junk of [null, undefined, 5, 'x', [], {}]) assert.equal(isDueForDigest(junk as any, NOW), false);
});

test('isDeliverable: one plain address, nothing else', () => {
  for (const ok of ['dana@example.com', 'a.b+c@sub.example.co.il']) assert.equal(isDeliverable(ok), true, ok);
  for (const bad of ['', 'x', 'a@b', 'a@b.c, d@e.f', 'a@b.c;d@e.f', 'Dana <a@b.c>', 'a b@c.d', 'a@b.c\r\nBcc: x@y.z', '"a"@b.c', 'a@b.c' + 'x'.repeat(260)]) assert.equal(isDeliverable(bad), false, JSON.stringify(bad));
});

// ---------------------------------------------------------------- the same lists as the page
test('the e-mail lists equal the page lists (the same rules, 400 random worlds, computed in the machine\'s own zone)', () => {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const r = rng(77);
  const pick = <T,>(list: T[]) => list[Math.floor(r() * list.length)];
  for (let n = 0; n < 400; n++) {
    const now = new Date(Date.UTC(2026, 9, 10 + Math.floor(r() * 5), Math.floor(r() * 24), Math.floor(r() * 60)));
    const day = (offset: number) => new Date(now.getTime() + offset * 86400_000).toISOString().slice(0, 10);
    const mails = Array.from({ length: Math.floor(r() * 9) }, (_, i) => ({ id: i, subject: 'S' + i, received_at: hoursAgo(r() * 24 * 16, now.getTime()), due_date: pick([null, day(-40), day(-3), day(0), day(2), day(9)]), needs_reply: pick([true, false, null]), handled_at: pick([null, null, null, '2026-10-01T00:00:00Z']) }));
    const agenda: any[] = Array.from({ length: Math.floor(r() * 10) }, (_, i) => {
      const kind = pick(['event', 'task']);
      if (kind === 'task') return { kind, title: 'T' + i, day: pick([day(-40), day(-1), day(0), day(5), day(9)]) };
      if (r() < 0.3) return { kind, title: 'D' + i, all_day: true, day: pick([day(-1), day(0), day(1), day(2)]) };
      const start = now.getTime() + (r() * 80 - 20) * 3600_000;
      return { kind, title: 'E' + i, all_day: false, starts_at: new Date(start).toISOString(), ends_at: r() < 0.8 ? new Date(start + r() * 3 * 3600_000).toISOString() : null };
    });
    const ours = buildBrief(mails, agenda, now.getTime(), tz);
    const todayLocal = page.localDay(new Date(now.getTime()));
    const brief = page.morningBriefing(mails, now, null, todayLocal);
    const agendaBrief = page.agendaBriefing(agenda, now, todayLocal);
    const names = (list: any[], key: string) => list.map((e) => e.row[key] ?? e.row.external_id);
    assert.deepEqual(ours.deadlines.map((e) => e.row.id), brief.deadlines.map((e: any) => e.row.id), `deadlines, world ${n}`);
    assert.deepEqual(ours.replies.map((e) => e.row.id), brief.replies.map((e: any) => e.row.id), `replies, world ${n}`);
    assert.deepEqual([ours.deadlineMore, ours.replyMore], [brief.deadlineMore, brief.replyMore]);
    assert.deepEqual(ours.events.map((e) => [e.row.title, e.label]), agendaBrief.events.map((e: any) => [e.row.title, e.label]), `events, world ${n}`);
    assert.deepEqual(ours.tasks.map((e) => [e.row.title, e.label]), agendaBrief.tasks.map((e: any) => [e.row.title, e.label]), `tasks, world ${n}`);
    assert.deepEqual([ours.eventMore, ours.taskMore], [agendaBrief.eventMore, agendaBrief.taskMore]);
    void names;
  }
});

// ---------------------------------------------------------------- the message
const mailRow = (over: Row = {}) => ({ from_name: 'Dana <dana@example.com>', subject: 'Hello', category: 'personal', received_at: hoursAgo(30), due_date: null, needs_reply: true, handled_at: null, ...over });

test('composeEmail: nothing to say gives no mail; the subject has numbers only', () => {
  assert.equal(composeEmail(buildBrief([], [], NOW, 'Asia/Jerusalem')), null);
  const one = composeEmail(buildBrief([mailRow()], [], NOW, 'Asia/Jerusalem'))!;
  assert.equal(one.subject, 'סיכום הבוקר: דבר אחד שכדאי לראות');
  assert.equal(one.count, 1);
  const many = composeEmail(buildBrief(Array.from({ length: 9 }, (_, i) => mailRow({ subject: 'S' + i })), [{ kind: 'task', title: 'Pay', day: '2026-10-13' }], NOW, 'Asia/Jerusalem'))!;
  assert.equal(many.subject, 'סיכום הבוקר: 10 דברים שכדאי לראות');
  assert.ok(many.text.includes('ועוד 4 מיילים שממתינים לתשובה.'));
  assert.ok(many.text.includes('משימות שמחכות') && many.text.includes('Pay'));
});

test('composeEmail: hostile text cannot break the page of the mail or the subject', () => {
  const evil = '<script>alert(1)</script>"><img src=x onerror=alert(2)>‮fdp.exe​&amp;\r\nBcc: attacker@example.com ' + 'W'.repeat(400);
  const out = composeEmail(buildBrief([mailRow({ from_name: evil, subject: evil })], [{ kind: 'event', title: evil, all_day: true, day: '2026-10-12' }, { kind: 'task', title: evil, day: '2026-10-12' }], NOW, 'Asia/Jerusalem'))!;
  assert.ok(!/<script|<img|onerror=alert\(2\)>/i.test(out.html), 'no raw tag from a mail');
  assert.ok(out.html.includes('&lt;script&gt;'));
  assert.ok(!/[‪-‮​]/.test(out.html + out.text + out.subject));
  assert.ok(!/[\r\n]/.test(out.subject));
  assert.ok(!out.subject.includes('attacker'));
  assert.ok(out.html.length < 8000, 'long words are cut');
  assert.equal(escapeHtml(`<a href="x">'&`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
});

test('fuzz: 2000 random worlds never throw, and the mail never contains a raw angle bracket from the data', () => {
  const r = rng(5);
  const junk = () => [null, undefined, 5, 'x', '<b>', '2026-10-12', 'garbage', {}, [], true, '‮', 'a'.repeat(300)][Math.floor(r() * 12)];
  for (let n = 0; n < 2000; n++) {
    const mails = Array.from({ length: Math.floor(r() * 6) }, () => ({ from_name: junk(), subject: junk(), received_at: junk(), due_date: junk(), needs_reply: junk(), handled_at: junk() }));
    const agenda = Array.from({ length: Math.floor(r() * 6) }, () => ({ kind: ['event', 'task', junk()][Math.floor(r() * 3)], title: junk(), starts_at: junk(), ends_at: junk(), all_day: junk(), day: junk() }));
    let out: ReturnType<typeof composeEmail>;
    try { out = composeEmail(buildBrief(mails, agenda, NOW, safeTz(junk()))); } catch (error) { throw new Error(`world ${n}: ${(error as Error).stack?.split('\n').slice(0, 3).join(' | ')} ${JSON.stringify({ mails, agenda })}`); }
    if (out) assert.ok(!/<(?!\/?(div|h3|ul|li|p)\b)/.test(out.html), 'only our own tags');
  }
  assert.doesNotThrow(() => buildBrief('x', 5, NaN, 'Asia/Jerusalem'));
});

// ---------------------------------------------------------------- sendDigests against a fake database and a fake sender
interface Sent { to: string; subject: string; key: string }
function makeSender(behavior: (n: number) => 'ok' | 'transient' | 'permanent' | 'skip' = () => 'ok') {
  const sent: Sent[] = [];
  let calls = 0;
  const send = async (m: { to: string; subject: string; html: string; text: string; key: string }) => {
    calls++;
    const outcome = behavior(calls);
    if (outcome === 'ok') { sent.push({ to: m.to, subject: m.subject, key: m.key }); return { ok: true as const }; }
    if (outcome === 'skip') return { skip: 'not_configured' as const };
    return { fail: outcome };
  };
  return { send, sent, get calls() { return calls; } };
}
const world = (connection: Row = {}, mails: Row[] = [mailRow()], agenda: Row[] = []) =>
  makeDb({ gmail_connections: [{ user_id: 'u1', ...base(), ...connection }], gmail_digest: mails.map((m, i) => ({ user_id: 'u1', gmail_message_id: 'm' + i, ...m })), gmail_agenda: agenda.map((a, i) => ({ user_id: 'u1', external_id: 'a' + i, ...a })) });
const conn = (db: any, id = 'u1') => db.tables.gmail_connections.find((c: Row) => c.user_id === id);

test('one mail per local day: sent once, not again the same day, again the next day', async () => {
  const db = world();
  const s = makeSender();
  assert.deepEqual(await sendDigests(db as any, NOW, s.send), { sent: 1, empty: 0, failed: 0, notConfigured: 0 });
  assert.equal(s.sent.length, 1);
  assert.equal(s.sent[0].to, 'dana@example.com');
  assert.equal(conn(db).digest_last_sent_on, '2026-10-12');
  await sendDigests(db as any, NOW + 3600_000, s.send);
  assert.equal(s.sent.length, 1, 'not twice in one day');
  const tomorrow = NOW + 24 * 3600_000;
  await sendDigests(db as any, tomorrow, s.send);
  assert.equal(s.sent.length, 2);
  assert.notEqual(s.sent[0].key, s.sent[1].key, 'a new idempotency key every day');
});

test('two runs at the same moment (the scheduler overlapping itself) send once', async () => {
  const db = world();
  const s = makeSender();
  await Promise.all([sendDigests(db as any, NOW, s.send), sendDigests(db as any, NOW, s.send), sendDigests(db as any, NOW, s.send)]);
  assert.equal(s.sent.length, 1);
});

test('an empty briefing sends nothing and the day stays claimed; a handled mail is not mentioned', async () => {
  const db = world({}, [mailRow({ handled_at: '2026-10-12T00:00:00Z' })]);
  const s = makeSender();
  const run = await sendDigests(db as any, NOW, s.send);
  assert.deepEqual([run.sent, run.empty, s.calls], [0, 1, 0]);
  assert.equal(conn(db).digest_last_sent_on, '2026-10-12');
});

test('no sending service configured: nothing is counted as a failure and the day is given back; once configured, it sends', async () => {
  const db = world();
  const off = makeSender(() => 'skip');
  const run = await sendDigests(db as any, NOW, off.send);
  assert.deepEqual([run.notConfigured, run.sent, run.failed], [1, 0, 0]);
  assert.deepEqual([conn(db).digest_last_sent_on, conn(db).digest_failures], [null, 0]);
  const on = makeSender();
  await sendDigests(db as any, NOW + 120_000, on.send);
  assert.equal(on.sent.length, 1);
});

test('the real sender without a key reports "not configured" and never calls out', async () => {
  let called = false;
  const original = globalThis.fetch;
  globalThis.fetch = (async () => { called = true; return new Response('{}'); }) as typeof fetch;
  try {
    assert.deepEqual(await sendEmail({ to: 'a@b.c', subject: 's', html: 'h', text: 't', key: 'k' }), { skip: 'not_configured' });
    assert.equal(called, false);
  } finally { globalThis.fetch = original; }
});

test('the real sender with a key: the request is addressed to ONE recipient with an idempotency key; 4xx is permanent, 429/5xx/network are temporary', async () => {
  (globalThis as any).Deno = { env: { get: (name: string) => (name === 'RESEND_API_KEY' ? ['fake', 'resend', 'key'].join('-') : undefined) } };
  const original = globalThis.fetch;
  const seen: any[] = [];
  let status = 200;
  let boom = false;
  globalThis.fetch = (async (url: any, init: any) => { seen.push({ url: String(url), init }); if (boom) throw new Error('network'); return new Response('{}', { status }); }) as typeof fetch;
  try {
    const message = { to: 'dana@example.com', subject: 'Subject', html: '<p>h</p>', text: 't', key: 'digest-u1-2026-10-12' };
    assert.deepEqual(await sendEmail(message), { ok: true });
    assert.equal(seen[0].url, 'https://api.resend.com/emails');
    assert.equal(seen[0].init.headers['Idempotency-Key'], message.key);
    assert.deepEqual(JSON.parse(seen[0].init.body).to, ['dana@example.com']);
    for (const [code, kind] of [[403, 'permanent'], [422, 'permanent'], [401, 'permanent'], [429, 'transient'], [500, 'transient'], [503, 'transient']] as const) { status = code; assert.deepEqual(await sendEmail(message), { fail: kind }, String(code)); }
    boom = true;
    assert.deepEqual(await sendEmail(message), { fail: 'transient' });
  } finally { globalThis.fetch = original; (globalThis as any).Deno = { env: { get: () => undefined } }; }
});

test('a temporary failure gives the day back without counting; permanent refusals count and stop after three; a success resets', async () => {
  const db = world();
  const flaky = makeSender(() => 'transient');
  await sendDigests(db as any, NOW, flaky.send);
  assert.deepEqual([conn(db).digest_last_sent_on, conn(db).digest_failures], [null, 0]);
  const refuse = makeSender(() => 'permanent');
  for (let i = 0; i < 5; i++) await sendDigests(db as any, NOW + i * 120_000, refuse.send);
  assert.equal(refuse.calls, MAX_FAILURES, 'three refusals and then it stops asking');
  assert.equal(conn(db).digest_failures, MAX_FAILURES);
  conn(db).digest_failures = 1; // the member switched it off and on again, or one refusal was long ago
  const ok = makeSender();
  await sendDigests(db as any, NOW + 600_000, ok.send);
  assert.equal(ok.sent.length, 1);
  assert.equal(conn(db).digest_failures, 0);
});

test('only the right members: not switched on, needs reconnect, outside their morning, and every mail goes to its own owner', async () => {
  const db = makeDb({
    gmail_connections: [
      { user_id: 'on', ...base({ google_email: 'on@example.com' }) },
      { user_id: 'off', ...base({ digest_email: false, google_email: 'off@example.com' }) },
      { user_id: 'dead', ...base({ status: 'needs_reconnect', google_email: 'dead@example.com' }) },
      { user_id: 'night', ...base({ digest_tz: 'America/New_York', google_email: 'night@example.com' }) },
      { user_id: 'other', ...base({ google_email: 'other@example.com' }) },
    ],
    gmail_digest: ['on', 'off', 'dead', 'night', 'other'].map((u) => ({ user_id: u, gmail_message_id: 'x' + u, ...mailRow({ subject: 'for ' + u }) })),
    gmail_agenda: [],
  });
  const s = makeSender();
  await sendDigests(db as any, NOW, s.send);
  assert.deepEqual(s.sent.map((m) => m.to).sort(), ['on@example.com', 'other@example.com']);
});

test('a failing database read gives the day back; a crash inside never leaves a day claimed without a mail', async () => {
  const db = world();
  db.failing['gmail_digest.select'] = true;
  const s = makeSender();
  await sendDigests(db as any, NOW, s.send);
  assert.equal(s.calls, 0);
  assert.equal(conn(db).digest_last_sent_on, null);
  delete db.failing['gmail_digest.select'];
  const crash = async () => { throw new Error('sender crashed'); };
  await sendDigests(db as any, NOW + 1000, crash as any);
  assert.equal(conn(db).digest_last_sent_on, null);
  await sendDigests(db as any, NOW + 2000, s.send);
  assert.equal(s.sent.length, 1);
});

test('chaos: random failures, overlapping runs and a jumping clock: never more than one mail per member per local day, never to a stranger; after healing exactly one', async () => {
  for (let seed = 1; seed <= 40; seed++) {
    const r = rng(seed * 104729);
    const tzs = ['Asia/Jerusalem', 'America/New_York', 'Pacific/Auckland', 'UTC', 'garbage'];
    const members = Array.from({ length: 4 }, (_, i) => ({ user_id: 'u' + i, ...base({ digest_tz: tzs[Math.floor(r() * tzs.length)], google_email: `m${i}@example.com`, digest_email: r() < 0.8 }) }));
    const db = makeDb({ gmail_connections: members, gmail_digest: members.map((m) => ({ user_id: m.user_id, gmail_message_id: 'x', ...mailRow() })), gmail_agenda: [] });
    const sentKeys: string[] = [];
    const sentTo: string[] = [];
    let mode = 0;
    const send = async (m: { to: string; key: string }) => {
      const outcome = mode === 0 ? 'ok' : (['ok', 'transient', 'permanent', 'skip'] as const)[Math.floor(r() * 4)];
      if (outcome === 'ok') { sentKeys.push(m.key); sentTo.push(m.to); return { ok: true as const }; }
      if (outcome === 'skip') return { skip: 'not_configured' as const };
      return { fail: outcome };
    };
    let clock = NOW;
    for (let round = 0; round < 12; round++) {
      mode = 1;
      for (const key of ['gmail_digest.select', 'gmail_agenda.select', 'gmail_connections.update']) db.failing[key] = r() < 0.15;
      clock += r() < 0.15 ? -3600_000 : Math.floor(r() * 5 * 3600_000);
      await Promise.all(Array.from({ length: 1 + Math.floor(r() * 3) }, () => sendDigests(db as any, clock, send as any)));
    }
    const unique = new Set(sentKeys);
    assert.equal(unique.size, sentKeys.length, `seed ${seed}: a (member, day) got two mails`);
    for (const to of sentTo) assert.ok(members.some((m) => m.google_email === to && m.digest_email), `seed ${seed}: mail to ${to}`);
    // healing: keep the clock inside one morning window for everybody, with working services: nobody who is opted in and still
    // failing less than three times in a row is left without that day's mail
    mode = 0;
    for (const key of Object.keys(db.failing)) delete db.failing[key];
    for (const m of db.tables.gmail_connections) m.digest_failures = 0;
    const when = Date.parse('2027-01-14T00:00:00Z');
    for (const row of db.tables.gmail_digest) row.received_at = new Date(when - 30 * 3600_000).toISOString(); // fresh mails again
    for (const hour of [4, 6, 8, 10, 12, 14, 16, 18, 20, 22]) await sendDigests(db as any, when + hour * 3600_000, send as any);
    const todayKeys = sentKeys.filter((k) => /-2027-01-1[3-5]$/.test(k));
    for (const m of members.filter((x) => x.digest_email)) assert.ok(todayKeys.some((k) => k.startsWith(`digest-${m.user_id}-`)), `seed ${seed}: ${m.user_id} got no mail after healing`);
    assert.equal(new Set(sentKeys).size, sentKeys.length);
  }
});
