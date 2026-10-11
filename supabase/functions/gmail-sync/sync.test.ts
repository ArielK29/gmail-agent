// Runs the REAL syncOne (sync.ts) in Node against a fake database and fake Google / Gemini answers.
// Covers what the pure-logic tests cannot: the per-run limit with real chunking, a draining backlog, a Gemini 429 that
// never ends, and each of the three database writes failing. Nothing here touches the network or a real mailbox.
//   node --test supabase/functions/gmail-sync/sync.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';

// ---- fake Deno + fake clock (set BEFORE sync.ts is loaded: it reads Deno.env at import time) ----
const env: Record<string, string> = { GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret', GEMINI_API_KEY: 'key' };
(globalThis as any).Deno = { env: { get: (name: string) => env[name] } };
const realSetTimeout = globalThis.setTimeout;
let sleeps: number[] = [];
(globalThis as any).setTimeout = (fn: () => void, ms?: number) => {
  sleeps.push(ms ?? 0);
  return realSetTimeout(fn, 0);
};
const { syncOne, MAX_NEW_PER_RUN, CHUNK_SIZE, MAX_EMAILS_PER_DAY } = await import('./sync.ts');

// ---- fake database: tables are arrays, writes can be made to fail ----
type Row = Record<string, any>;
function makeDb(tables: Record<string, Row[]>, failing: Record<string, boolean> = {}) {
  const writes: string[] = [];
  const db = {
    tables,
    writes,
    failing,
    from(name: string) {
      const filters: Array<(row: Row) => boolean> = [];
      let action: 'select' | 'update' | 'upsert' = 'select';
      let payload: any;
      const run = () => {
        const table = (tables[name] ??= []);
        if (action === 'select') return { data: table.filter((row) => filters.every((f) => f(row))).map((row) => ({ ...row })), error: null };
        const key = `${name}.${action}`;
        if (failing[key]) return { data: null, error: { message: 'fake failure ' + key } };
        writes.push(key);
        if (action === 'update') for (const row of table) if (filters.every((f) => f(row))) Object.assign(row, payload);
        if (action === 'upsert') {
          for (const item of [].concat(payload)) {
            const same = (row: Row) => (name === 'gmail_usage' ? row.user_id === item.user_id && row.day === item.day : row.user_id === item.user_id && row.gmail_message_id === item.gmail_message_id);
            const existing = table.find(same);
            if (existing) Object.assign(existing, item);
            else table.push({ ...item });
          }
        }
        return { data: null, error: null };
      };
      const builder: any = {
        select: () => builder,
        update: (value: Row) => ((action = 'update'), (payload = value), builder),
        upsert: (value: Row | Row[]) => ((action = 'upsert'), (payload = value), builder),
        eq: (column: string, value: any) => (filters.push((row) => row[column] === value), builder),
        in: (column: string, values: any[]) => (filters.push((row) => values.includes(row[column])), builder),
        maybeSingle: () => {
          const result: any = run();
          return Promise.resolve({ data: result.data?.[0] ?? null, error: result.error });
        },
        then: (resolve: any, reject: any) => Promise.resolve(run()).then(resolve, reject),
      };
      return builder;
    },
  };
  return db;
}

// ---- fake Google and Gemini ----
interface World {
  newIds: string[]; // what Gmail's history / list reports as new
  historyStatus?: number; // status of the history call (404 = position too old)
  tokenStatus?: number;
  tokenBody?: Record<string, unknown>;
  geminiStatuses?: number[]; // answers in order; the last one repeats. 200 = a good answer
  geminiCalls: number;
  chunkSizes: number[];
  gmailMessageReads: number;
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function installFetch(world: World) {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      return json(world.tokenStatus ?? 200, world.tokenBody ?? { access_token: 'fake-access-token' });
    }
    if (url.includes('/history?')) return json(world.historyStatus ?? 200, { history: [{ messagesAdded: world.newIds.map((id) => ({ message: { id } })) }], historyId: '900' });
    if (url.endsWith('/profile')) return json(200, { historyId: '900' });
    if (url.includes('/messages?q=')) return json(200, { messages: world.newIds.map((id) => ({ id })) });
    const message = /\/messages\/([^?]+)\?format=full/.exec(url);
    if (message) {
      world.gmailMessageReads++;
      return json(200, {
        internalDate: String(Date.parse('2026-10-12T08:00:00Z')),
        snippet: 'טקסט של מייל ' + message[1],
        payload: { headers: [{ name: 'From', value: 'שולח <a@example.com>' }, { name: 'Subject', value: 'נושא ' + message[1] }] },
      });
    }
    if (url.includes('generativelanguage.googleapis.com')) {
      const statuses = world.geminiStatuses ?? [200];
      const status = statuses[Math.min(world.geminiCalls, statuses.length - 1)];
      world.geminiCalls++;
      if (status !== 200) return json(status, { error: { message: 'fake ' + status } });
      const sent: Array<{ id: string }> = JSON.parse(JSON.parse(init.body).contents[0].parts[0].text);
      world.chunkSizes.push(sent.length);
      const answer = sent.map((email) => ({ id: email.id, category: 'work', summary: 'סיכום ' + email.id, urgency: 'normal', action: '' }));
      return json(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }] });
    }
    throw new Error('unexpected fetch ' + url);
  }) as typeof fetch;
}

const world = (over: Partial<World> = {}): World => ({ newIds: [], geminiCalls: 0, chunkSizes: [], gmailMessageReads: 0, ...over });
const ids = (n: number, prefix = 'm') => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);
const USER = 'user-1';
const connection = (over: Row = {}) => ({ user_id: USER, refresh_token: 'rt', history_id: '100', last_checked_at: null, status: 'active', ...over });
const freshDb = (failing: Record<string, boolean> = {}) => makeDb({ gmail_connections: [{ user_id: USER, status: 'active', history_id: '100' }], gmail_digest: [], gmail_usage: [] }, failing);
const today = new Date().toISOString().slice(0, 10);

test.beforeEach(() => { sleeps = []; });

test('more new mails than the per-run limit: 30 are summarized in chunks of 10, the position stays, the rest drain next run', async () => {
  const w = world({ newIds: ids(45) });
  installFetch(w);
  const db = freshDb();

  const first = await syncOne(db as any, connection());
  assert.deepEqual(first, { saved: MAX_NEW_PER_RUN });
  assert.equal(db.tables.gmail_digest.length, 30);
  assert.deepEqual(w.chunkSizes, [10, 10, 10], 'three model calls of 10, never one huge call');
  assert.equal(db.tables.gmail_connections[0].history_id, '100', 'the position must NOT move while mails are waiting');
  assert.equal(db.tables.gmail_usage[0].emails, 30);

  const second = await syncOne(db as any, connection());
  assert.deepEqual(second, { saved: 15 }, 'the remaining 15, none summarized twice');
  assert.equal(db.tables.gmail_digest.length, 45);
  assert.equal(new Set(db.tables.gmail_digest.map((r) => r.gmail_message_id)).size, 45);
  assert.equal(db.tables.gmail_connections[0].history_id, '900', 'now everything is done, the position moves forward');
  assert.equal(db.tables.gmail_usage[0].emails, 45);
});

test('exactly the per-run limit is not "behind": the position moves', async () => {
  installFetch(world({ newIds: ids(MAX_NEW_PER_RUN) }));
  const db = freshDb();
  assert.deepEqual(await syncOne(db as any, connection()), { saved: MAX_NEW_PER_RUN });
  assert.equal(db.tables.gmail_connections[0].history_id, '900');
});

test('a Gemini 429 that never ends: the run fails with the model reason, nothing is saved, the position stays', async () => {
  const w = world({ newIds: ids(3), geminiStatuses: [429] });
  installFetch(w);
  const db = freshDb();
  await assert.rejects(syncOne(db as any, connection()), /Gemini: fake 429/);
  assert.equal(w.geminiCalls, 4, 'one try plus three retries');
  assert.deepEqual(sleeps, [500, 1000, 2000], 'growing pauses');
  assert.equal(db.tables.gmail_digest.length, 0);
  assert.equal(db.tables.gmail_connections[0].history_id, '100');
  assert.equal(db.tables.gmail_connections[0].status, 'active', 'a rate limit never touches the connection');
  assert.equal(db.writes.length, 0, 'no write of any kind happened');
});

test('a Gemini 429 followed by a good answer recovers inside the same run', async () => {
  const w = world({ newIds: ids(3), geminiStatuses: [429, 429, 200] });
  installFetch(w);
  const db = freshDb();
  assert.deepEqual(await syncOne(db as any, connection()), { saved: 3 });
  assert.equal(w.geminiCalls, 3);
  assert.equal(db.tables.gmail_connections[0].history_id, '900');
});

test('a Gemini 400 is not retried', async () => {
  const w = world({ newIds: ids(2), geminiStatuses: [400] });
  installFetch(w);
  await assert.rejects(syncOne(freshDb() as any, connection()), /Gemini: fake 400/);
  assert.equal(w.geminiCalls, 1);
  assert.deepEqual(sleeps, []);
});

test('the digest write fails: nothing counted, the position stays, the problem is reported', async () => {
  installFetch(world({ newIds: ids(4) }));
  const db = freshDb({ 'gmail_digest.upsert': true });
  assert.deepEqual(await syncOne(db as any, connection()), { saved: 0, error: 'could not save' });
  assert.equal(db.tables.gmail_usage.length, 0, 'the budget is not charged for mails that were not saved');
  assert.equal(db.tables.gmail_connections[0].history_id, '100');
});

test('the usage write fails: the mails are kept but the problem is reported (the budget would not be enforced)', async () => {
  installFetch(world({ newIds: ids(4) }));
  const db = freshDb({ 'gmail_usage.upsert': true });
  assert.deepEqual(await syncOne(db as any, connection()), { saved: 4, error: 'could not save usage' });
  assert.equal(db.tables.gmail_digest.length, 4);
});

test('the position write fails: the mails are kept, the problem is reported, and the next run does not summarize them again', async () => {
  const w = world({ newIds: ids(4) });
  installFetch(w);
  const db = freshDb({ 'gmail_connections.update': true });
  assert.deepEqual(await syncOne(db as any, connection()), { saved: 4, error: 'could not save' });
  assert.equal(db.tables.gmail_connections[0].history_id, '100');
  db.failing['gmail_connections.update'] = false;
  const callsBefore = w.geminiCalls;
  assert.deepEqual(await syncOne(db as any, connection()), { saved: 0 }, 'already saved mails are skipped');
  assert.equal(w.geminiCalls, callsBefore, 'no model call for mails that are already saved');
  assert.equal(db.tables.gmail_connections[0].history_id, '900');
});

test('the daily budget is used up: nothing is summarized, nothing is lost, the position stays', async () => {
  const w = world({ newIds: ids(5) });
  installFetch(w);
  const db = freshDb();
  db.tables.gmail_usage.push({ user_id: USER, day: today, emails: MAX_EMAILS_PER_DAY });
  assert.deepEqual(await syncOne(db as any, connection()), { saved: 0 });
  assert.equal(w.geminiCalls, 0);
  assert.equal(db.tables.gmail_connections[0].history_id, '100');
});

test('only part of the daily budget is left: just that many are summarized', async () => {
  installFetch(world({ newIds: ids(10) }));
  const db = freshDb();
  db.tables.gmail_usage.push({ user_id: USER, day: today, emails: MAX_EMAILS_PER_DAY - 4 });
  assert.deepEqual(await syncOne(db as any, connection()), { saved: 4 });
  assert.equal(db.tables.gmail_connections[0].history_id, '100');
  assert.equal(db.tables.gmail_usage[0].emails, MAX_EMAILS_PER_DAY);
});

test('Google says invalid_grant: the connection is kept and marked needs_reconnect', async () => {
  installFetch(world({ tokenStatus: 400, tokenBody: { error: 'invalid_grant' } }));
  const db = freshDb();
  const result = await syncOne(db as any, connection());
  assert.match(result.error ?? '', /access was revoked/);
  assert.equal(db.tables.gmail_connections[0].status, 'needs_reconnect');
});

test('any other token problem is temporary: it throws and the connection is untouched', async () => {
  installFetch(world({ tokenStatus: 503, tokenBody: { error: 'backend_error' } }));
  const db = freshDb();
  await assert.rejects(syncOne(db as any, connection()), /Google token: backend_error/);
  assert.equal(db.tables.gmail_connections[0].status, 'active');
  assert.equal(db.writes.length, 0);
});

test('the history position is too old (404): starts again from the last 2 days instead of failing', async () => {
  installFetch(world({ newIds: ids(3), historyStatus: 404 }));
  const db = freshDb();
  assert.deepEqual(await syncOne(db as any, connection()), { saved: 3 });
  assert.equal(db.tables.gmail_connections[0].history_id, '900');
});

test('chunk size constant matches what the tests assume', () => {
  assert.equal(CHUNK_SIZE, 10);
  assert.equal(MAX_NEW_PER_RUN, 30);
});
