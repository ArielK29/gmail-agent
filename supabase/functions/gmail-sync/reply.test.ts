// Morning briefing (issue #16): deadlines saved by the sync, and the "do I owe an answer" check, with the REAL sync.ts against
// a fake database and fake Google / Gemini.   node --test supabase/functions/gmail-sync/reply.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, rng, json, type Row } from './testkit.ts';

const env: Record<string, string> = { GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: ['fake', 'test', 'value'].join('-'), GEMINI_API_KEY: 'key' };
(globalThis as any).Deno = { env: { get: (name: string) => env[name] } };
const realSetTimeout = globalThis.setTimeout;
(globalThis as any).setTimeout = (fn: () => void) => realSetTimeout(fn, 0);
const { syncOne, refreshReplyState } = await import('./sync.ts');

const U = 'user-1';
const NOW = Date.parse('2026-10-12T09:00:00Z');
const ago = (hours: number) => new Date(NOW - hours * 3600_000).toISOString();
const todayIso = new Date().toISOString().slice(0, 10);
const plusDays = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

interface ThreadSpec { messages?: Array<{ labelIds: string[]; internalDate: string }>; status?: number; throws?: boolean }
interface World { threads: Record<string, ThreadSpec>; threadRequests: string[]; mailIds: string[]; deadlines: Record<string, string>; threadOf: (id: string) => string }
const makeWorld = (over: Partial<World> = {}): World => ({ threads: {}, threadRequests: [], mailIds: [], deadlines: {}, threadOf: (id) => 'th-' + id, ...over });

function install(world: World, flaky?: (kind: string) => boolean) {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    if (url.startsWith('https://oauth2.googleapis.com/token')) return json(200, { access_token: 'fake' });
    const thread = /\/threads\/([^?]+)\?format=metadata/.exec(url);
    if (thread) {
      const id = decodeURIComponent(thread[1]);
      world.threadRequests.push(id);
      if (flaky?.('thread')) throw new Error('network blip');
      const spec = world.threads[id];
      if (!spec) return json(404, { error: { message: 'Not Found' } });
      if (spec.throws) throw new Error('network');
      if (spec.status && spec.status !== 200) return json(spec.status, { error: { message: 'busy' } });
      return json(200, { id, messages: spec.messages ?? [] });
    }
    if (url.includes('/history?')) return json(200, { history: [{ id: '150', messagesAdded: world.mailIds.map((id) => ({ message: { id } })) }], historyId: '900' });
    if (url.endsWith('/profile')) return json(200, { historyId: '900' });
    if (url.includes('/messages?q=')) return json(200, { messages: world.mailIds.map((id) => ({ id })) });
    const message = /\/messages\/([^?]+)\?format=full/.exec(url);
    if (message) return json(200, { threadId: world.threadOf(message[1]), internalDate: String(NOW - 3_600_000), snippet: 'text ' + message[1], payload: { headers: [{ name: 'From', value: 'Dana <d@x.com>' }, { name: 'Subject', value: 's ' + message[1] }] } });
    if (url.includes('generativelanguage.googleapis.com')) {
      const sent = JSON.parse(JSON.parse(init.body).contents[0].parts[0].text) as Array<{ id: string }>;
      const answer = sent.map((mail) => ({ id: mail.id, category: 'work', summary: 'סיכום ' + mail.id, urgency: 'normal', action: '', deadline: world.deadlines[mail.id] ?? '' }));
      return json(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }] });
    }
    throw new Error('unexpected fetch ' + url);
  }) as typeof fetch;
}

const digestRow = (id: string, over: Row = {}): Row => ({ user_id: U, gmail_message_id: id, thread_id: 'th-' + id, received_at: ago(30), category: 'work', urgency: 'normal', from_name: 'Dana <d@x.com>', needs_reply: null, reply_checked_at: null, summary: 's', ...over });
const msg = (date: number, labels: string[]) => ({ internalDate: String(date), labelIds: labels });
const tables = (rows: Row[] = []) => ({ gmail_connections: [{ user_id: U, status: 'active', history_id: '100', refresh_token: 'rt' }], gmail_digest: rows, gmail_usage: [] as Row[] });
const rowOf = (db: any, id: string) => db.tables.gmail_digest.find((r: Row) => r.gmail_message_id === id);

test('the reply check flags threads where someone else wrote last, clears threads I answered, and stamps both', async () => {
  const w = makeWorld({ threads: { 'th-a': { messages: [msg(1, ['INBOX'])] }, 'th-b': { messages: [msg(1, ['INBOX']), msg(2, ['SENT'])] }, 'th-c': { messages: [msg(1, ['SENT']), msg(2, ['INBOX'])] } } });
  install(w);
  const db = makeDb(tables([digestRow('a'), digestRow('b'), digestRow('c')]));
  const r = await refreshReplyState(db as any, U, 'token', NOW);
  assert.equal(r.checked, 3);
  assert.equal(rowOf(db, 'a').needs_reply, true);
  assert.equal(rowOf(db, 'b').needs_reply, false, 'I answered last');
  assert.equal(rowOf(db, 'c').needs_reply, true, 'they answered my mail');
  assert.ok(db.tables.gmail_digest.every((row) => row.reply_checked_at === new Date(NOW).toISOString()));
});

test('only the right mails cause a Gmail request: no newsletters, robots, urgent-low, old mails, or threads checked in the last 6 hours', async () => {
  const w = makeWorld({ threads: { 'th-ok': { messages: [msg(1, ['INBOX'])] } } });
  install(w);
  const db = makeDb(tables([
    digestRow('ok'), digestRow('news', { category: 'newsletter' }), digestRow('robot', { from_name: 'noreply@x.com' }), digestRow('low', { urgency: 'low' }),
    digestRow('old', { received_at: ago(24 * 20) }), digestRow('fresh', { reply_checked_at: ago(1) }), digestRow('nothread', { thread_id: null }),
  ]));
  await refreshReplyState(db as any, U, 'token', NOW);
  assert.deepEqual(w.threadRequests, ['th-ok']);
  assert.equal(rowOf(db, 'news').needs_reply, null, 'untouched');
});

test('a busy or unreachable Gmail leaves the thread unknown (asked again later); a deleted thread (404) becomes "no reply needed"', async () => {
  const w = makeWorld({ threads: { 'th-busy': { status: 429 }, 'th-net': { throws: true }, 'th-5xx': { status: 503 } } }); // th-gone does not exist: 404
  install(w);
  const db = makeDb(tables([digestRow('busy'), digestRow('net'), digestRow('5xx'), digestRow('gone')]));
  const r = await refreshReplyState(db as any, U, 'token', NOW);
  assert.equal(r.checked, 1);
  for (const id of ['busy', 'net', '5xx']) { assert.equal(rowOf(db, id).needs_reply, null, id); assert.equal(rowOf(db, id).reply_checked_at, null, id + ' will be asked again'); }
  assert.equal(rowOf(db, 'gone').needs_reply, false);
});

test('at most 20 threads per run, newest first; the rest are picked up by the next run', async () => {
  const rows = Array.from({ length: 35 }, (_, i) => digestRow('m' + i, { received_at: ago(13 + i * 0.1) }));
  const w = makeWorld({ threads: Object.fromEntries(rows.map((r) => [r.thread_id, { messages: [msg(1, ['INBOX'])] }])) });
  install(w);
  const db = makeDb(tables(rows));
  await refreshReplyState(db as any, U, 'token', NOW);
  assert.equal(w.threadRequests.length, 20);
  assert.deepEqual(w.threadRequests.slice(0, 3), ['th-m0', 'th-m1', 'th-m2'], 'newest first');
  w.threadRequests = [];
  await refreshReplyState(db as any, U, 'token', NOW);
  assert.equal(w.threadRequests.length, 15, 'the 20 already checked are not asked again');
});

test('the answer is refreshed after 6 hours: a reply I send later clears the flag; not before', async () => {
  const w = makeWorld({ threads: { 'th-a': { messages: [msg(1, ['INBOX'])] } } });
  install(w);
  const db = makeDb(tables([digestRow('a')]));
  await refreshReplyState(db as any, U, 'token', NOW);
  assert.equal(rowOf(db, 'a').needs_reply, true);
  w.threads['th-a'] = { messages: [msg(1, ['INBOX']), msg(2, ['SENT'])] }; // I answered
  await refreshReplyState(db as any, U, 'token', NOW + 5 * 3600_000);
  assert.equal(rowOf(db, 'a').needs_reply, true, 'still inside the 6 hour pause');
  await refreshReplyState(db as any, U, 'token', NOW + 7 * 3600_000);
  assert.equal(rowOf(db, 'a').needs_reply, false, 'cleared after the pause');
});

test('a failing database in the reply step is reported by a smaller "checked", never by an exception', async () => {
  const w = makeWorld({ threads: { 'th-a': { messages: [msg(1, ['INBOX'])] } } });
  install(w);
  const db = makeDb(tables([digestRow('a')]), { 'gmail_digest.update': true });
  assert.deepEqual(await refreshReplyState(db as any, U, 'token', NOW), { checked: 0 });
});

test('a full sync saves the thread id and the deadline; an invented or impossible deadline is dropped', async () => {
  const w = makeWorld({ mailIds: ['d1', 'd2', 'd3', 'd4'], deadlines: { d1: plusDays(3), d2: '2026-02-30', d3: '', d4: '1999-01-01' }, threads: {} });
  install(w);
  const db = makeDb(tables());
  const result = await syncOne(db as any, { user_id: U, refresh_token: 'rt', history_id: '100', last_checked_at: null, status: 'active' });
  assert.deepEqual(result, { saved: 4 });
  assert.equal(rowOf(db, 'd1').due_date, plusDays(3));
  for (const id of ['d2', 'd3', 'd4']) assert.equal(rowOf(db, id).due_date, null, id);
  assert.equal(rowOf(db, 'd1').thread_id, 'th-d1');
});

test('the reply check can never change the outcome of a sync: same result whether Gmail threads work, fail, or throw', async () => {
  const run = async (mode: 'ok' | 'fail' | 'throw') => {
    const w = makeWorld({ mailIds: ['x1', 'x2', 'x3'], threads: mode === 'ok' ? { 'th-x1': { messages: [msg(1, ['INBOX'])] }, 'th-x2': { messages: [msg(1, ['INBOX'])] }, 'th-x3': { messages: [msg(1, ['INBOX'])] } } : mode === 'fail' ? { 'th-x1': { status: 500 }, 'th-x2': { status: 429 }, 'th-x3': { status: 503 } } : { 'th-x1': { throws: true }, 'th-x2': { throws: true }, 'th-x3': { throws: true } } });
    install(w);
    const db = makeDb(tables());
    const result = await syncOne(db as any, { user_id: U, refresh_token: 'rt', history_id: '100', last_checked_at: null, status: 'active' });
    return { result, saved: db.tables.gmail_digest.length, position: db.tables.gmail_connections[0].history_id };
  };
  const ok = await run('ok');
  assert.deepEqual(await run('fail'), ok);
  assert.deepEqual(await run('throw'), ok);
  assert.deepEqual(ok.result, { saved: 3 });
  assert.equal(ok.position, '900');
});

// Chaos for the reply step: random failures of Gmail threads and of the database while many mails and threads exist.
test('chaos: 40 random worlds for the reply step keep every invariant', async () => {
  for (let seed = 1; seed <= 40; seed++) {
    const next = rng(seed);
    const count = Math.floor(next() * 60) + 1;
    const rows = Array.from({ length: count }, (_, i) => digestRow('c' + i, { received_at: ago(13 + next() * 300), category: ['work', 'personal', 'newsletter', 'finance', 'promotion'][Math.floor(next() * 5)], urgency: ['high', 'normal', 'low'][Math.floor(next() * 3)], from_name: next() < 0.15 ? 'noreply@x.com' : 'Dana <d@x.com>', thread_id: next() < 0.1 ? null : 'th-c' + Math.floor(next() * 40) }));
    const threads: Record<string, ThreadSpec> = {};
    for (let t = 0; t < 40; t++) threads['th-c' + t] = next() < 0.1 ? { status: 429 } : next() < 0.05 ? { throws: true } : { messages: Array.from({ length: Math.floor(next() * 4) + 1 }, (_, k) => msg(k + 1, [['INBOX'], ['SENT'], ['DRAFT'], ['TRASH']][Math.floor(next() * 4)])) };
    // some threads do not exist at all (404)
    for (let t = 0; t < 40; t += 7) delete threads['th-c' + t];
    const w = makeWorld({ threads });
    install(w, () => next() < 0.05);
    const flaky = new Proxy({}, { get: (_t, key) => (String(key) === 'gmail_digest.update' ? next() < 0.1 : false) });
    const db = makeDb(tables(rows), flaky as any);
    for (let run = 0; run < 4; run++) {
      w.threadRequests = [];
      const r = await refreshReplyState(db as any, U, 'token', NOW + run * 7 * 3600_000);
      assert.ok(w.threadRequests.length <= 20, `seed ${seed}: ${w.threadRequests.length} threads in one run`);
      assert.equal(new Set(w.threadRequests).size, w.threadRequests.length, `seed ${seed}: a thread asked twice in one run`);
      assert.ok(r.checked >= 0);
      for (const row of db.tables.gmail_digest) {
        assert.ok(row.needs_reply === null || typeof row.needs_reply === 'boolean', `seed ${seed}: needs_reply ${row.needs_reply}`);
        if (['newsletter', 'promotion'].includes(row.category) || row.urgency === 'low' || row.from_name === 'noreply@x.com' || row.thread_id === null) assert.equal(row.needs_reply, null, `seed ${seed}: a mail that must never be checked was flagged (${row.gmail_message_id})`);
      }
    }
  }
});
