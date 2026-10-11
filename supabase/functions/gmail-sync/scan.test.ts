// On-demand scan (issue #15): the REAL scan.ts against a fake database and fake Google / Gemini.
//   node --test supabase/functions/gmail-sync/scan.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, rng, json, type Row } from './testkit.ts';

const env: Record<string, string> = { GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: ['fake', 'test', 'value'].join('-'), GEMINI_API_KEY: 'key' };
(globalThis as any).Deno = { env: { get: (name: string) => env[name] } };
const realSetTimeout = globalThis.setTimeout;
(globalThis as any).setTimeout = (fn: () => void) => realSetTimeout(fn, 0);
const { startScan, stepScan, cancelScan, tickScans } = await import('./scan.ts');

const A = 'user-a';
const B = 'user-b';
const NOW = Date.parse('2026-10-12T09:00:00Z');
const day = '2026-10-12';

interface World {
  ids: string[]; // what Gmail's search returns
  queries: string[];
  readStatus: Record<string, number>;
  tokenStatus?: number; tokenBody?: Record<string, unknown>;
  listStatus?: number;
  geminiFail?: number; // answer this status instead
  modelCalls: number;
  sentToModel: string[];
}
const makeWorld = (ids: string[], over: Partial<World> = {}): World => ({ ids, queries: [], readStatus: {}, modelCalls: 0, sentToModel: [], ...over });
const ids = (n: number, prefix = 'm') => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);
const textOf = (id: string) => (Number(id.replace(/\D/g, '')) % 3 === 0 ? `Invoice INV-${id} from Acme Ltd` : `Newsletter number ${id}`);

function install(world: World, extra?: (url: string) => Response | null) {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    const forced = extra?.(url);
    if (forced) return forced;
    if (url.startsWith('https://oauth2.googleapis.com/token')) return json(world.tokenStatus ?? 200, world.tokenBody ?? { access_token: 'fake' });
    if (url.includes('/messages?q=')) {
      world.queries.push(decodeURIComponent(/q=([^&]*)/.exec(url)![1]));
      if (world.listStatus && world.listStatus !== 200) return json(world.listStatus, { error: { message: 'Invalid query' } });
      const page = /pageToken=p(\d+)/.exec(url); const index = page ? Number(page[1]) : 0;
      const chunk = world.ids.slice(index * 100, index * 100 + 100);
      return json(200, { messages: chunk.map((id) => ({ id })), ...(world.ids.length > (index + 1) * 100 ? { nextPageToken: 'p' + (index + 1) } : {}) });
    }
    const message = /\/messages\/([^?]+)\?format=full/.exec(url);
    if (message) {
      const status = world.readStatus[message[1]];
      if (status && status !== 200) return json(status, { error: { message: 'fake ' + status } });
      return json(200, { internalDate: String(Date.parse('2026-01-15T08:00:00Z')), snippet: textOf(message[1]), payload: { headers: [{ name: 'From', value: 'Acme <a@acme.example>' }, { name: 'Subject', value: 'Re: ' + message[1] }] } });
    }
    if (url.includes('generativelanguage.googleapis.com')) {
      world.modelCalls++;
      if (world.geminiFail) return json(world.geminiFail, { error: { message: 'busy' } });
      const request = JSON.parse(JSON.parse(init.body).contents[0].parts[0].text) as { items: string[]; mails: Array<{ id: string; subject: string; text: string; from: string }> };
      for (const mail of request.mails) world.sentToModel.push(mail.id);
      const answer = request.mails.map((mail) => ({ id: mail.id, matches: request.items.map((item, i) => (`${mail.from} ${mail.subject} ${mail.text}`.toLowerCase().includes(item.toLowerCase()) ? i : -1)).filter((i) => i >= 0), summary: 'סיכום ' + mail.id }));
      return json(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }] });
    }
    throw new Error('unexpected fetch ' + url);
  }) as typeof fetch;
}

const baseTables = () => ({
  gmail_connections: [{ user_id: A, status: 'active', refresh_token: 'rt' }, { user_id: B, status: 'active', refresh_token: 'rt-b' }],
  gmail_scans: [] as Row[], gmail_scan_hits: [] as Row[], gmail_usage: [] as Row[],
});
const request = (over: Record<string, unknown> = {}) => ({ consent: true, periodStart: '2026-01-01', periodEnd: '2026-01-31', query: 'invoice', items: ['INV-m3', 'Acme Ltd', 'nothing-like-this'], ...over });
const NOWD = new Date(NOW);

async function startOk(db: any, over: Record<string, unknown> = {}) {
  const r = await startScan(db, A, request(over), NOWD);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return String(r.body.id);
}
async function runToEnd(db: any, id: string, user: string | null = A, limit = 40, nowMs = NOW) {
  let last: any = null;
  for (let i = 0; i < limit; i++) { last = await stepScan(db, id, user, nowMs); if (!last || ['done', 'failed', 'cancelled', 'paused'].includes(last.status)) break; }
  return last;
}

// ---------------------------------------------------------------------------------------------------------------
test('start: refuses without consent, without a connection, with an expired connection, a second active scan, a 4th scan in a day', async () => {
  const db = makeDb(baseTables());
  assert.deepEqual((await startScan(db as any, A, request({ consent: false }), NOWD)).body, { error: 'consent_required' });
  assert.equal(db.tables.gmail_scans.length, 0, 'nothing was created without consent');
  assert.deepEqual((await startScan(db as any, 'stranger', request(), NOWD)).body, { error: 'not_connected' });
  db.tables.gmail_connections[1].status = 'needs_reconnect';
  assert.deepEqual((await startScan(db as any, B, request(), NOWD)).body, { error: 'needs_reconnect' });

  const first = await startScan(db as any, A, request(), NOWD);
  assert.equal(first.status, 200);
  const second = await startScan(db as any, A, request(), NOWD);
  assert.equal(second.status, 409); assert.equal(second.body.error, 'scan_in_progress'); assert.equal(second.body.id, first.body.id);
  for (const s of db.tables.gmail_scans) s.status = 'done';
  assert.equal((await startScan(db as any, A, request(), NOWD)).status, 200);
  for (const s of db.tables.gmail_scans) s.status = 'done';
  assert.equal((await startScan(db as any, A, request(), NOWD)).status, 200);
  for (const s of db.tables.gmail_scans) s.status = 'done';
  const fourth = await startScan(db as any, A, request(), NOWD);
  assert.equal(fourth.status, 429); assert.equal(fourth.body.error, 'daily_scan_limit');
  const tomorrow = new Date(NOW + 25 * 3600 * 1000);
  for (const s of db.tables.gmail_scans) s.created_at = new Date(NOW).toISOString();
  assert.equal((await startScan(db as any, A, request({ periodEnd: '2026-01-31' }), tomorrow)).status, 200, 'the limit is per rolling 24 hours');
});

test('start: the server stamps the consent time and stores only cleaned values (hostile text and items)', async () => {
  const db = makeDb(baseTables());
  const id = await startOk(db, { query: 'bill (from:boss) {x} "open ‮', items: ['  Acme  ', 'acme', 'a\u0000b', ''] });
  const row = db.tables.gmail_scans.find((r) => r.id === id)!;
  assert.equal(row.consent_at, NOWD.toISOString());
  assert.equal(row.query_text, 'bill from:boss x open');
  assert.deepEqual(row.items, ['Acme', 'ab']);
  assert.equal(row.user_id, A);
});

test('a scan finds, reads and matches: 75 mails in 3 slices, local and model matches combined, budget charged once per mail', async () => {
  const w = makeWorld(ids(75)); install(w);
  const db = makeDb(baseTables());
  const id = await startOk(db);
  const result = await runToEnd(db, id);
  assert.equal(result.status, 'done'); assert.equal(result.processed, 75); assert.equal(result.total, 75);
  assert.equal(db.tables.gmail_scan_hits.length, 75);
  assert.match(w.queries[0], /^after:2026\/01\/01 before:2026\/02\/01 invoice$/);
  const hit = (mail: string) => db.tables.gmail_scan_hits.find((r) => r.gmail_message_id === mail)!;
  assert.deepEqual(hit('m3').matches, [0, 1], 'the invoice mail mentions INV-m3 and Acme Ltd');
  assert.deepEqual(hit('m4').matches, [], 'a newsletter mentions none of the items');
  assert.ok(db.tables.gmail_scan_hits.every((r) => !r.matches.includes(2)), 'an item that is nowhere is matched nowhere');
  assert.equal(db.tables.gmail_usage[0].emails, 75);
  assert.equal(db.tables.gmail_scans[0].status, 'done');
  assert.ok(db.tables.gmail_scans[0].finished_at);
  assert.equal(new Set(w.sentToModel).size, w.sentToModel.length, 'no mail was sent to the model twice');
});

test('one scan reads at most 200 mails even if the search finds more', async () => {
  const w = makeWorld(ids(450)); install(w);
  const db = makeDb(baseTables());
  const id = await startOk(db);
  const result = await runToEnd(db, id, A, 60);
  assert.equal(result.total, 200); assert.equal(db.tables.gmail_scan_hits.length, 200); assert.equal(result.status, 'done');
});

test('a search with no result ends at once, and an invalid Gmail query fails with a clear code', async () => {
  const w = makeWorld([]); install(w);
  const db = makeDb(baseTables());
  const done = await runToEnd(db, await startOk(db));
  assert.equal(done.status, 'done'); assert.equal(done.total, 0);
  for (const s of db.tables.gmail_scans) s.status = 'done';
  install(makeWorld(ids(5), { listStatus: 400 }));
  const failed = await runToEnd(db, await startOk(db));
  assert.equal(failed.status, 'failed'); assert.equal(failed.error, 'invalid_query');
});

test('a mail Gmail cannot return right now holds the counter; a deleted mail (404) does not; after healing everything is saved', async () => {
  const w = makeWorld(ids(12), { readStatus: { m5: 429, m7: 404 } }); install(w);
  const db = makeDb(baseTables());
  const id = await startOk(db);
  const first = await stepScan(db as any, id, A, NOW);
  assert.equal(first!.processed, 4, 'stopped in front of the busy mail m5');
  assert.deepEqual(db.tables.gmail_scan_hits.map((r) => r.gmail_message_id).sort(), ['m1', 'm2', 'm3', 'm4']);
  const stuck = await stepScan(db as any, id, A, NOW);
  assert.equal(stuck!.progressed, false, 'busy again: no progress, nothing lost');
  w.readStatus = { m7: 404 }; // Gmail recovers
  const end = await runToEnd(db, id);
  assert.equal(end.status, 'done'); assert.equal(end.processed, 12);
  assert.equal(db.tables.gmail_scan_hits.length, 11, 'the deleted mail m7 has no row, everything else has');
  assert.ok(!db.tables.gmail_scan_hits.some((r) => r.gmail_message_id === 'm7'));
});

test('the daily budget is shared with the sync: only what is left is read, then the scan is paused and continues the next day', async () => {
  install(makeWorld(ids(40)));
  const db = makeDb(baseTables());
  db.tables.gmail_usage.push({ user_id: A, day, emails: 290 });
  const id = await startOk(db);
  const first = await stepScan(db as any, id, A, NOW);
  assert.equal(first!.processed, 10, 'only 10 mails were left in today\'s budget');
  const paused = await stepScan(db as any, id, A, NOW);
  assert.equal(paused!.status, 'paused'); assert.equal(paused!.error, 'daily_budget');
  assert.equal(db.tables.gmail_usage[0].emails, 300, 'never above the cap');
  assert.equal(db.tables.gmail_scan_hits.length, 10);
  const tomorrow = NOW + 24 * 3600 * 1000;
  const end = await runToEnd(db, id, A, 10, tomorrow);
  assert.equal(end.status, 'done'); assert.equal(db.tables.gmail_scan_hits.length, 40);
});

test('revoked access fails the scan and marks the connection; a temporary token problem does not', async () => {
  const db = makeDb(baseTables());
  const id = await startOk(db);
  install(makeWorld(ids(5), { tokenStatus: 503, tokenBody: { error: 'backend_error' } }));
  const temporary = await stepScan(db as any, id, A, NOW);
  assert.equal(temporary!.status, 'running'); assert.equal(temporary!.progressed, false);
  assert.equal(db.tables.gmail_connections[0].status, 'active');
  install(makeWorld(ids(5), { tokenStatus: 400, tokenBody: { error: 'invalid_grant' } }));
  const revoked = await stepScan(db as any, id, A, NOW);
  assert.equal(revoked!.status, 'failed'); assert.equal(revoked!.error, 'needs_reconnect');
  assert.equal(db.tables.gmail_connections[0].status, 'needs_reconnect');
});

test('two slices at the same moment: exactly one works, the other is "busy"; a stale claim (older than a minute) can be taken over', async () => {
  const w = makeWorld(ids(25)); install(w);
  const db = makeDb(baseTables());
  const id = await startOk(db);
  const [x, y] = await Promise.all([stepScan(db as any, id, A, NOW), stepScan(db as any, id, A, NOW)]);
  assert.equal([x, y].filter((r) => r!.busy).length, 1, 'one of them reported busy');
  assert.equal(db.tables.gmail_scan_hits.length, 25);
  assert.equal(new Set(w.sentToModel).size, w.sentToModel.length, 'no mail summarized twice');
  const db2 = makeDb(baseTables());
  const id2 = await startOk(db2);
  db2.tables.gmail_scans[0].claimed_until = new Date(NOW + 30_000).toISOString();
  assert.equal((await stepScan(db2 as any, id2, A, NOW))!.busy, true, 'a fresh claim blocks');
  db2.tables.gmail_scans[0].claimed_until = new Date(NOW - 1000).toISOString();
  assert.equal((await stepScan(db2 as any, id2, A, NOW))!.busy, undefined, 'a stale claim does not');
});

test('a slice that saved its results but could not move the counter does not send those mails to the model again', async () => {
  const w = makeWorld(ids(10)); install(w);
  const flaky = { 'gmail_scans.update': false } as Record<string, any>;
  const db = makeDb(baseTables(), flaky);
  const id = await startOk(db);
  await stepScan(db as any, id, A, NOW); // lists the mails
  const sentBefore = w.sentToModel.length;
  assert.equal(sentBefore, 10);
  // the next slice: pretend the counter write failed after the results were saved
  db.tables.gmail_scans[0].processed = 0;
  db.tables.gmail_scans[0].status = 'running';
  db.tables.gmail_scans[0].finished_at = null;
  const again = await stepScan(db as any, id, A, NOW);
  assert.equal(w.sentToModel.length, 10, 'the 10 saved mails were not sent again');
  assert.equal(again!.processed, 10);
});

test('cancel stops the scan for good; a member cannot cancel or step another member\'s scan', async () => {
  const w = makeWorld(ids(60)); install(w);
  const db = makeDb(baseTables());
  const id = await startOk(db);
  await stepScan(db as any, id, A, NOW);
  assert.deepEqual((await cancelScan(db as any, B, id)).body, { cancelled: false }, 'another member cannot cancel it');
  assert.equal(await stepScan(db as any, id, B, NOW), null, 'another member cannot even see it');
  assert.deepEqual((await cancelScan(db as any, A, id)).body, { cancelled: true });
  const calls = w.modelCalls;
  const after = await stepScan(db as any, id, A, NOW);
  assert.equal(after!.status, 'cancelled'); assert.equal(w.modelCalls, calls, 'no more work after cancel');
  assert.deepEqual((await cancelScan(db as any, A, id)).body, { cancelled: false }, 'already cancelled');
});

test('the scheduler continues scans nobody drives, skips claimed ones, and deletes results older than 30 days', async () => {
  install(makeWorld(ids(20)));
  const db = makeDb(baseTables());
  const id = await startOk(db);
  assert.deepEqual(await tickScans(db as any, NOW), { stepped: 1 });
  assert.equal(db.tables.gmail_scans[0].status, 'done');
  assert.deepEqual(await tickScans(db as any, NOW), { stepped: 0 }, 'a finished scan is not touched again');
  db.tables.gmail_scans.push({ id: 'old', user_id: A, status: 'done', expires_at: new Date(NOW - 1000).toISOString() });
  db.tables.gmail_scan_hits.push({ scan_id: 'old', user_id: A, gmail_message_id: 'x' });
  await tickScans(db as any, NOW);
  assert.ok(!db.tables.gmail_scans.some((r) => r.id === 'old'), 'the expired scan is deleted');
  const id2 = (await startScan(db as any, A, request(), new Date(NOW + 3600_000)) as any).body.id ?? id;
  db.tables.gmail_scans.forEach((r) => { if (r.id === id2) { r.status = 'running'; r.claimed_until = new Date(NOW + 30_000).toISOString(); } });
  assert.equal((await tickScans(db as any, NOW)).stepped, 0, 'a scan that is being worked on is not picked up');
});

test('the member cannot step a scan that does not exist, nor one that is already finished (it only reports)', async () => {
  install(makeWorld(ids(3)));
  const db = makeDb(baseTables());
  assert.equal(await stepScan(db as any, 'nope', A, NOW), null);
  const id = await startOk(db);
  const end = await runToEnd(db, id);
  const calls = Object.keys(db.writes).length;
  const again = await stepScan(db as any, id, A, NOW);
  assert.equal(again!.status, 'done'); assert.equal(Object.keys(db.writes).length, calls, 'a finished scan is not written again');
  assert.equal(end.status, 'done');
});

// ---------------------------------------------------------------------------------------------------------------
// Chaos: Google, Gemini and the database fail at random, several slices run at the same time, scans are cancelled and the
// clock jumps a day. Always true: the counter never passes a mail that is neither saved nor deleted, no mail is sent to the
// model after it was saved, the budget never exceeds the cap or the saved results, hits are unique, and after healing a
// scan that was not cancelled ends with exactly the mails that still exist.
// ---------------------------------------------------------------------------------------------------------------
test('chaos: 50 random worlds', async () => {
  for (let seed = 1; seed <= 50; seed++) {
    const next = rng(seed);
    const all = ids(Math.floor(next() * 90) + 1, 'c');
    const gone = new Set(all.filter(() => next() < 0.05));
    let chaos = 1;
    const roll = (p: number) => chaos > 0 && next() < p;
    const flaky = new Proxy({}, { get: (_t, key) => (['gmail_scan_hits.upsert', 'gmail_usage.upsert', 'gmail_scans.update', 'gmail_scans.select'].includes(String(key)) ? roll(0.05) : false) });
    const db = makeDb(baseTables(), flaky as any);
    const w = makeWorld(all);
    let savedBeforeSend = 0;
    install(w, (url) => {
      if (url.startsWith('https://oauth2.googleapis.com/token')) { if (roll(0.02)) throw new Error('network'); if (roll(0.06)) return json(503, { error: 'backend_error' }); return null; }
      if (url.includes('/messages?q=')) return roll(0.06) ? json(500, { error: { message: 'Backend Error' } }) : null;
      const message = /\/messages\/([^?]+)\?format=full/.exec(url);
      if (message) {
        if (gone.has(message[1])) return json(404, { error: { message: 'Not Found' } });
        if (roll(0.03)) throw new Error('blip');
        if (roll(0.12)) return json(429, { error: { message: 'rate' } });
        return null;
      }
      if (url.includes('generativelanguage.googleapis.com')) {
        if (roll(0.2)) return json([429, 500, 503][Math.floor(next() * 3)], { error: { message: 'busy' } });
        if (roll(0.05)) return json(200, { candidates: [{ content: { parts: [{ text: 'not json at all' }] } }] });
        const before = w.sentToModel.length;
        return null && before;
      }
      return null;
    });
    // count a mail as "sent after saved" at the moment it is sent
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
      if (String(input).includes('generativelanguage.googleapis.com') && chaos >= 0) {
        const request = JSON.parse(JSON.parse(init.body).contents[0].parts[0].text) as { mails: Array<{ id: string }> };
        for (const mail of request.mails) if (db.tables.gmail_scan_hits.some((r) => r.gmail_message_id === mail.id)) savedBeforeSend++;
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    const first = await startScan(db as any, A, request(), NOWD);
    assert.equal(first.status, 200);
    const id = String(first.body.id);
    const live = all.filter((m) => !gone.has(m));
    const check = (label: string) => {
      const scan = db.tables.gmail_scans[0];
      const hitIds = db.tables.gmail_scan_hits.map((r) => r.gmail_message_id);
      assert.equal(new Set(hitIds).size, hitIds.length, `seed ${seed} ${label}: duplicate hits`);
      const pending: string[] = scan.pending_ids ?? [];
      const passed = pending.slice(0, scan.processed);
      for (const m of passed) assert.ok(gone.has(m) || hitIds.includes(m), `seed ${seed} ${label}: the counter passed ${m}, which is neither saved nor deleted`);
      const usage = db.tables.gmail_usage.reduce((sum, r) => sum + r.emails, 0);
      assert.ok(usage <= hitIds.length, `seed ${seed} ${label}: usage ${usage} above saved results ${hitIds.length}`);
      assert.ok(usage <= 300);
      assert.equal(savedBeforeSend, 0, `seed ${seed} ${label}: a saved mail was sent to the model again`);
    };
    for (let round = 0; round < 8; round++) {
      // several slices at once, sometimes with a jump of the clock
      const clock = NOW + (next() < 0.1 ? 86_400_000 : 0) + round * 1000;
      try { await Promise.all([stepScan(db as any, id, A, clock), stepScan(db as any, id, A, clock)]); } catch { /* a failed slice is fine */ }
      check('chaos round ' + round);
    }
    chaos = 0;
    // after healing the stale claim of a failed slice may still be set: the scheduler / page continues after a minute
    const end = await runToEnd(db, id, A, 30, NOW + 2 * 86_400_000); // later than any claim made during the chaos
    check('after healing');
    assert.equal(end.status, 'done', `seed ${seed}: did not finish after healing (${JSON.stringify(end)})`);
    assert.deepEqual(db.tables.gmail_scan_hits.map((r) => r.gmail_message_id).sort(), live.sort(), `seed ${seed}: exactly the mails that still exist`);
  }
});

test('a cancel that arrives while a slice is running stays a cancel (the slice does not turn it back into "running")', async () => {
  const w = makeWorld(ids(25));
  const db = makeDb(baseTables());
  const id = await startOk(db);
  let cancelled = false;
  install(w, (url) => {
    if (url.includes('generativelanguage.googleapis.com') && !cancelled) { cancelled = true; db.tables.gmail_scans[0].status = 'cancelled'; } // the member pressed cancel during the model call
    return null;
  });
  const result = await stepScan(db as any, id, A, NOW);
  assert.equal(db.tables.gmail_scans[0].status, 'cancelled', 'still cancelled in the database');
  assert.notEqual(result!.status, 'done');
  assert.equal((await stepScan(db as any, id, A, NOW))!.status, 'cancelled');
});

test('two starts at the same moment: the database lets one in, the other gets the normal "in progress" answer', async () => {
  const db = makeDb(baseTables(), { 'gmail_scans.insert': { code: '23505', message: 'duplicate key value violates unique constraint "gmail_scans_one_active"' } });
  const lost = await startScan(db as any, A, request(), NOWD);
  assert.equal(lost.status, 409); assert.equal(lost.body.error, 'scan_in_progress');
  const broken = makeDb(baseTables(), { 'gmail_scans.insert': { message: 'something else' } });
  assert.equal((await startScan(broken as any, A, request(), NOWD)).status, 500);
});