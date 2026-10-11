// Runs the REAL syncOne (sync.ts) in Node against a fake database and fake Google / Gemini answers.
// Covers what the pure-logic tests cannot: the per-run limit with real chunking, a draining backlog, a Gemini 429 that
// never ends, and each of the three database writes failing. Nothing here touches the network or a real mailbox.
//   node --test supabase/functions/gmail-sync/sync.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';

// ---- fake Deno + fake clock (set BEFORE sync.ts is loaded: it reads Deno.env at import time) ----
const env: Record<string, string> = { GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: ['fake', 'test', 'value'].join('-'), GEMINI_API_KEY: 'key' };
(globalThis as any).Deno = { env: { get: (name: string) => env[name] } };
const realSetTimeout = globalThis.setTimeout;
let sleeps: number[] = [];
(globalThis as any).setTimeout = (fn: () => void, ms?: number) => {
  sleeps.push(ms ?? 0);
  return realSetTimeout(fn, 0);
};
const { syncOne, findNewIds, MAX_NEW_PER_RUN, CHUNK_SIZE, MAX_EMAILS_PER_DAY } = await import('./sync.ts');

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
  historyPages?: Array<{ ids: string[]; lastId: string }>; // several pages of history (page n is asked with pageToken p<n>)
  readStatus?: Record<string, number>; // per message id: the status the message read returns (default 200)
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function installFetch(world: World) {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      return json(world.tokenStatus ?? 200, world.tokenBody ?? { access_token: 'fake-access-token' });
    }
    if (url.includes('/history?')) {
      if (world.historyPages) {
        const asked = /pageToken=p(\d+)/.exec(url);
        const index = asked ? Number(asked[1]) : 0;
        const page = world.historyPages[index];
        return json(200, {
          history: page.ids.map((id, n) => ({ id: String(Number(page.lastId) - page.ids.length + 1 + n), messagesAdded: [{ message: { id } }] })),
          historyId: '9000',
          ...(index + 1 < world.historyPages.length ? { nextPageToken: 'p' + (index + 1) } : {}),
        });
      }
      return json(world.historyStatus ?? 200, { history: [{ id: '150', messagesAdded: world.newIds.map((id) => ({ message: { id } })) }], historyId: '900' });
    }
    if (url.endsWith('/profile')) return json(200, { historyId: '900' });
    if (url.includes('/messages?q=')) return json(200, { messages: world.newIds.map((id) => ({ id })) });
    const message = /\/messages\/([^?]+)\?format=full/.exec(url);
    if (message) {
      world.gmailMessageReads++;
      const forced = world.readStatus?.[message[1]];
      if (forced && forced !== 200) return json(forced, { error: { message: 'fake ' + forced } });
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

test('history longer than the page limit: the position only moves to what was actually listed, never to the mailbox head', async () => {
  // 7 pages of 100 mails; the code reads 5 pages. The mailbox head (9000) must NOT become the new position.
  const pages = Array.from({ length: 7 }, (_, p) => ({ ids: ids(100, `p${p}-`), lastId: String(1000 + (p + 1) * 100) }));
  installFetch(world({ historyPages: pages }));
  const truncated = await findNewIds('token', '1000');
  assert.equal(truncated.ids.length, 500);
  assert.equal(truncated.historyId, '1500', 'the last history record that was read, so the next run continues after it');
  installFetch(world({ historyPages: pages.slice(0, 3) }));
  const complete = await findNewIds('token', '1000');
  assert.equal(complete.ids.length, 300);
  assert.equal(complete.historyId, '9000', 'everything was listed: the position may move to the mailbox head');
});

test('a mail that Gmail could not return right now (429 / 500) is retried next run, not dropped; a deleted mail (404) is skipped', async () => {
  const w = world({ newIds: ['ok1', 'busy', 'gone', 'ok2'], readStatus: { busy: 429, gone: 404 } });
  installFetch(w);
  const db = freshDb();
  assert.deepEqual(await syncOne(db as any, connection()), { saved: 2 });
  assert.deepEqual(db.tables.gmail_digest.map((r) => r.gmail_message_id).sort(), ['ok1', 'ok2']);
  assert.equal(db.tables.gmail_connections[0].history_id, '100', 'the position must wait for the mail that was busy');

  // Gmail recovers: the busy mail is summarized, the deleted one is still skipped, the position moves.
  const healthy = world({ newIds: ['ok1', 'busy', 'gone', 'ok2'], readStatus: { gone: 404 } });
  installFetch(healthy);
  assert.deepEqual(await syncOne(db as any, connection()), { saved: 1 });
  assert.equal(db.tables.gmail_digest.length, 3);
  assert.equal(db.tables.gmail_connections[0].history_id, '900', 'everything was handled: the position moves to the mailbox head');
});

test('only deleted mails (404): nothing to retry, the position moves', async () => {
  installFetch(world({ newIds: ['gone1', 'gone2'], readStatus: { gone1: 404, gone2: 404 } }));
  const db = freshDb();
  assert.deepEqual(await syncOne(db as any, connection()), { saved: 0 });
  assert.equal(db.tables.gmail_connections[0].history_id, '900', 'everything was handled: the position moves to the mailbox head');
});
// ---------------------------------------------------------------------------------------------------------------------
// Chaos simulation: Google, Gemini and the database fail at random, in every step, for several runs in a row. After the
// chaos the services heal and the agent keeps running. Whatever the random failures were, these must always be true:
//   1. the position never moves past a mail that is not saved (a mail is never lost),
//   2. a mail that is already saved is never sent to the model again (no double spending),
//   3. the usage counter never counts more mails than were saved,
//   4. once everything heals, every mail that still exists is saved and the position is at the mailbox head.
// 60 different random worlds; the generator is seeded, so any failure can be replayed.
// ---------------------------------------------------------------------------------------------------------------------
function rng(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

test('chaos: random failures everywhere never lose a mail, never summarize one twice, never move the position past an unsaved mail', async () => {
  for (let seed = 1; seed <= 60; seed++) {
    const next = rng(seed);
    const allIds = ids(Math.floor(next() * 90), 'c');
    const gone = new Set(allIds.filter(() => next() < 0.05));
    let chaos = 1; // 1 = failures on, 0 = healed
    const roll = (p: number) => chaos > 0 && next() < p;
    // random failures for every database write (the Proxy is handed to the fake database when it is created)
    const flaky = new Proxy({}, { get: (_t, key) => (['gmail_digest.upsert', 'gmail_usage.upsert', 'gmail_connections.update'].includes(String(key)) ? roll(0.07) : false) });
    const db = freshDb(flaky as any);
    let sentAfterSaved = 0;
    const saved = () => new Set(db.tables.gmail_digest.map((r: Row) => r.gmail_message_id));

    globalThis.fetch = (async (input: any, init?: any) => {
      const url = String(input);
      if (url.startsWith('https://oauth2.googleapis.com/token')) {
        if (roll(0.02)) throw new Error('network down');
        return roll(0.08) ? json(503, { error: 'backend_error' }) : json(200, { access_token: 'fake' });
      }
      if (url.includes('/history?')) return roll(0.08) ? json(500, { error: { message: 'Backend Error' } }) : json(200, { history: [{ id: '150', messagesAdded: allIds.map((id) => ({ message: { id } })) }], historyId: '900' });
      if (url.endsWith('/profile')) return json(200, { historyId: '900' });
      if (url.includes('/messages?q=')) return json(200, { messages: allIds.map((id) => ({ id })) });
      const message = /\/messages\/([^?]+)\?format=full/.exec(url);
      if (message) {
        if (gone.has(message[1])) return json(404, { error: { message: 'Not Found' } });
        if (roll(0.03)) throw new Error('network blip');
        if (roll(0.12)) return json(429, { error: { message: 'rate limit' } });
        return json(200, { internalDate: String(Date.parse('2026-10-12T08:00:00Z')), snippet: 'x ' + message[1], payload: { headers: [{ name: 'From', value: 'a <a@b.c>' }, { name: 'Subject', value: 's ' + message[1] }] } });
      }
      if (url.includes('generativelanguage.googleapis.com')) {
        if (roll(0.2)) return json([429, 500, 503][Math.floor(next() * 3)], { error: { message: 'busy' } });
        if (roll(0.05)) return json(400, { error: { message: 'bad request' } });
        const sent: Array<{ id: string }> = JSON.parse(JSON.parse(init.body).contents[0].parts[0].text);
        for (const email of sent) if (saved().has(email.id)) sentAfterSaved++;
        if (roll(0.05)) return json(200, { candidates: [{ content: { parts: [{ text: 'sorry, I cannot do JSON today' }] } }] });
        const answer = sent.filter(() => !roll(0.05)).map((email) => ({ id: email.id, category: 'work', summary: 'סיכום ' + email.id, urgency: 'normal', action: '' }));
        return json(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }] });
      }
      throw new Error('unexpected fetch ' + url);
    }) as typeof fetch;

    const live = () => allIds.filter((id) => !gone.has(id));
    const checkInvariants = (label: string) => {
      const have = saved();
      if (db.tables.gmail_connections[0].history_id !== '100') {
        for (const id of live()) assert.ok(have.has(id), `seed ${seed} ${label}: position moved but ${id} is not saved`);
      }
      const usage = db.tables.gmail_usage.reduce((sum: number, r: Row) => sum + r.emails, 0);
      assert.ok(usage <= db.tables.gmail_digest.length, `seed ${seed} ${label}: usage ${usage} > saved ${db.tables.gmail_digest.length}`);
      assert.equal(sentAfterSaved, 0, `seed ${seed} ${label}: a saved mail was sent to the model again`);
    };

    for (let run = 0; run < 6; run++) { try { await syncOne(db as any, connection({ history_id: db.tables.gmail_connections[0].history_id })); } catch { /* a failed run is fine, the invariants are what matter */ } checkInvariants('chaos run ' + run); }
    chaos = 0; // the services heal
    for (let run = 0; run < 12 && db.tables.gmail_connections[0].history_id !== '900'; run++) { await syncOne(db as any, connection({ history_id: db.tables.gmail_connections[0].history_id })); checkInvariants('healthy run ' + run); }
    assert.equal(db.tables.gmail_connections[0].history_id, '900', `seed ${seed}: did not reach the mailbox head after healing`);
    assert.deepEqual([...saved()].sort(), live().sort(), `seed ${seed}: after healing, exactly the mails that still exist are saved`);
  }
});

test('two runs at the same time (the scheduler and the button) never duplicate or lose a mail', async () => {
  const w = world({ newIds: ids(25) });
  installFetch(w);
  const db = freshDb();
  const [a, b] = await Promise.all([syncOne(db as any, connection()), syncOne(db as any, connection())]);
  assert.equal(a.error ?? b.error, undefined);
  assert.equal(db.tables.gmail_digest.length, 25, 'one row per mail, not two');
  assert.equal(new Set(db.tables.gmail_digest.map((r: Row) => r.gmail_message_id)).size, 25);
  assert.equal(db.tables.gmail_connections[0].history_id, '900');
});