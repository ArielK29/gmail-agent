// Calendar and tasks in the briefing (issue #20): the parsing of Google's answers, and the REAL refreshAgenda / syncOne against
// a fake database and fake Google services.   node --test supabase/functions/gmail-sync/agenda.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, rng, json, type Row } from './testkit.ts';

const env: Record<string, string> = { GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: ['fake', 'test', 'value'].join('-'), GEMINI_API_KEY: 'key' };
(globalThis as any).Deno = { env: { get: (name: string) => env[name] } };
const realSetTimeout = globalThis.setTimeout;
(globalThis as any).setTimeout = (fn: () => void) => realSetTimeout(fn, 0);
const { syncOne, refreshAgenda } = await import('./sync.ts');
const { parseEvents, parseTasks, isMissingPermission, shouldRefreshAgenda, MAX_EVENTS, MAX_TASKS } = await import('./logic.ts');

const U = 'user-1';
const OTHER = 'user-2';
const NOW = Date.parse('2026-10-12T09:00:00Z');
const timed = (id: string, start: string, over: any = {}) => ({ id, summary: 'Meeting ' + id, start: { dateTime: start }, end: { dateTime: new Date(Date.parse(start) + 3600_000).toISOString() }, ...over });
const allDay = (id: string, day: string, over: any = {}) => ({ id, summary: 'Day ' + id, start: { date: day }, end: { date: day }, ...over });
const task = (id: string, due: string | null, over: any = {}) => ({ id, title: 'Task ' + id, status: 'needsAction', ...(due ? { due: due + 'T00:00:00.000Z' } : {}), ...over });

// ---------------------------------------------------------------- pure logic
test('events: timed and all-day events become rows; cancelled, declined, working-location and duplicate events do not', () => {
  const rows = parseEvents({ items: [
    timed('a', '2026-10-12T10:00:00+03:00'),
    allDay('b', '2026-10-13'),
    timed('c', '2026-10-12T11:00:00Z', { status: 'cancelled' }),
    timed('d', '2026-10-12T12:00:00Z', { attendees: [{ self: true, responseStatus: 'declined' }] }),
    timed('e', '2026-10-12T12:00:00Z', { attendees: [{ self: true, responseStatus: 'accepted' }, { email: 'x@y.z', responseStatus: 'declined' }] }),
    timed('f', '2026-10-12T12:00:00Z', { eventType: 'workingLocation' }),
    timed('a', '2026-10-12T13:00:00Z'),
  ] });
  assert.deepEqual(rows.map((r) => r.external_id), ['a', 'b', 'e']);
  assert.equal(rows[0].starts_at, '2026-10-12T07:00:00.000Z', 'normalised to UTC');
  assert.equal(rows[0].all_day, false);
  assert.deepEqual([rows[1].all_day, rows[1].day, rows[1].starts_at], [true, '2026-10-13', null]);
});

test('events: a missing title gets a placeholder, links and bidi tricks are removed, long titles are cut, an end before the start is dropped', () => {
  const [a, b, c] = parseEvents({ items: [
    { id: 'a', start: { dateTime: '2026-10-12T10:00:00Z' } },
    { id: 'b', summary: 'see https://evil.example/x ‮fdp.exe​ now', start: { dateTime: '2026-10-12T10:00:00Z' } },
    { id: 'c', summary: 'x'.repeat(500), start: { dateTime: '2026-10-12T10:00:00Z' }, end: { dateTime: '2026-10-12T09:00:00Z' } },
  ] });
  assert.equal(a.title, '(ללא כותרת)');
  assert.ok(!/https?:|[‪-‮​]/.test(b.title), b.title);
  assert.equal(c.title.length, 200);
  assert.equal(c.ends_at, null);
});

test('events: garbage in, nothing out (and no exception)', () => {
  for (const body of [null, undefined, 5, 'x', [], {}, { items: 'x' }, { items: [null, 5, 'x', [], {}] }, { items: [{ id: 5 }, { id: '' }, { id: 'x'.repeat(257), start: { date: '2026-10-12' } }, { id: 'ok', start: { date: '2026-02-30' } }, { id: 'ok2', start: { dateTime: 'not a date' } }] }]) {
    assert.deepEqual(parseEvents(body), [], JSON.stringify(body));
  }
});

test('events: at most 30', () => {
  const items = Array.from({ length: 80 }, (_, i) => timed('e' + i, '2026-10-12T10:00:00Z'));
  assert.equal(parseEvents({ items }).length, MAX_EVENTS);
});

test('tasks: only open tasks with a real due day; the time part of the due value is ignored', () => {
  const rows = parseTasks({ items: [
    task('a', '2026-10-13'),
    task('b', null),
    task('c', '2026-10-13', { status: 'completed' }),
    task('d', '2026-10-13', { deleted: true }),
    task('e', '2026-10-13', { hidden: true }),
    { id: 'f', title: 'bad day', status: 'needsAction', due: '2026-13-45T00:00:00.000Z' },
    { id: 'g', title: 'no due text', status: 'needsAction', due: 5 },
    task('a', '2026-10-14'),
  ] });
  assert.deepEqual(rows.map((r) => [r.external_id, r.day]), [['a', '2026-10-13']]);
  assert.equal(rows[0].kind, 'task');
});

test('tasks: the cap of 50 holds across several lists (shared set), and the same task twice counts once', () => {
  const seen = new Set<string>();
  const a = parseTasks({ items: Array.from({ length: 40 }, (_, i) => task('a' + i, '2026-10-13')) }, seen);
  const b = parseTasks({ items: [...Array.from({ length: 40 }, (_, i) => task('b' + i, '2026-10-13')), task('a0', '2026-10-13')] }, seen);
  assert.equal(a.length, 40);
  assert.equal(b.length, MAX_TASKS - 40);
  assert.ok(!b.some((r) => r.external_id === 'a0'));
});

test('missing permission: 401, and 403 only when Google talks about permissions; "API not enabled" is our problem, not the member\'s', () => {
  assert.equal(isMissingPermission(403, { error: { message: 'Request had insufficient authentication scopes.', status: 'PERMISSION_DENIED' } }), true);
  assert.equal(isMissingPermission(403, { error: { errors: [{ reason: 'insufficientPermissions' }] } }), true);
  assert.equal(isMissingPermission(401, {}), true);
  assert.equal(isMissingPermission(403, { error: { message: 'Google Calendar API has not been used in project 1 before or it is disabled.', status: 'PERMISSION_DENIED' } }), false);
  assert.equal(isMissingPermission(403, { error: { errors: [{ reason: 'accessNotConfigured' }] } }), false);
  assert.equal(isMissingPermission(403, { error: { details: [{ reason: 'SERVICE_DISABLED' }] } }), false);
  assert.equal(isMissingPermission(403, { error: { message: 'Rate Limit Exceeded' } }), false);
  assert.equal(isMissingPermission(403, { error: { message: 'Calendar API has not been used in project 1 or it is disabled. Insufficient scope of the project quota.', status: 'PERMISSION_DENIED' } }), false, 'disabled wins even when the text also says insufficient');
  for (const status of [200, 404, 429, 500, 503]) assert.equal(isMissingPermission(status, { error: { message: 'insufficient scope' } }), false, String(status));
});

test('refresh timing: never checked, 10 minutes passed, or a clock that went backwards', () => {
  assert.equal(shouldRefreshAgenda(null, NOW), true);
  assert.equal(shouldRefreshAgenda(undefined, NOW), true);
  assert.equal(shouldRefreshAgenda('garbage', NOW), true);
  assert.equal(shouldRefreshAgenda(new Date(NOW - 9 * 60_000).toISOString(), NOW), false);
  assert.equal(shouldRefreshAgenda(new Date(NOW - 10 * 60_000).toISOString(), NOW), true);
  assert.equal(shouldRefreshAgenda(new Date(NOW + 60_000).toISOString(), NOW), true);
});

test('fuzz: 3000 random Google answers never throw and every row satisfies the database rules', () => {
  const r = rng(20);
  const pick = <T,>(list: T[]) => list[Math.floor(r() * list.length)];
  const junk = () => pick<any>([null, undefined, 5, 'x', '2026-10-12', '2026-10-12T10:00:00Z', 'nope', '', {}, [], true, 'x'.repeat(300), '‮evil​', { dateTime: pick(['2026-10-12T10:00:00Z', 'bad', 5, null]), date: pick(['2026-10-12', '2026-02-30', 5, null]) }]);
  for (let n = 0; n < 3000; n++) {
    const items = Array.from({ length: Math.floor(r() * 8) }, () => ({ id: junk(), summary: junk(), title: junk(), status: pick(['needsAction', 'completed', 'cancelled', junk()]), due: junk(), start: junk(), end: junk(), attendees: junk(), eventType: junk() }));
    for (const row of [...parseEvents({ items }), ...parseTasks({ items })]) {
      assert.ok(row.external_id.length >= 1 && row.external_id.length <= 256);
      assert.ok(row.title.length <= 200);
      if (row.kind === 'task') assert.ok(row.day && /^\d{4}-\d{2}-\d{2}$/.test(row.day));
      else if (row.all_day) assert.ok(row.day && row.starts_at === null);
      else assert.ok(row.starts_at && Number.isFinite(Date.parse(row.starts_at)));
    }
  }
});

test('events: an all-day event that lasts several days is saved for every day that matters now (yesterday to the day after tomorrow), without a clock only once', () => {
  const trip = { id: 'trip', summary: 'Trip', start: { date: '2026-10-12' }, end: { date: '2026-10-16' } }; // Monday to Thursday, the end day is exclusive
  const rows = parseEvents({ items: [trip, allDay('single', '2026-10-13')] }, Date.parse('2026-10-13T09:00:00Z'));
  assert.deepEqual(rows.filter((r) => r.external_id.startsWith('trip')).map((r) => [r.external_id, r.day]), [['trip:2026-10-12', '2026-10-12'], ['trip:2026-10-13', '2026-10-13'], ['trip:2026-10-14', '2026-10-14'], ['trip:2026-10-15', '2026-10-15']]);
  assert.deepEqual(rows.filter((r) => r.external_id === 'single').length, 1, 'a one-day event keeps its plain id');
  const late = parseEvents({ items: [trip] }, Date.parse('2026-10-20T09:00:00Z'));
  assert.deepEqual(late, [], 'a trip that is over is not saved');
  const early = parseEvents({ items: [trip] }, Date.parse('2026-10-10T09:00:00Z'));
  assert.deepEqual(early.map((r) => r.day), ['2026-10-12'], 'a trip starting the day after tomorrow shows only its first day for now');
  assert.deepEqual(parseEvents({ items: [trip] }, Date.parse('2026-10-09T09:00:00Z')), [], 'and nothing while it is still further away')
  const noClock = parseEvents({ items: [trip] });
  assert.deepEqual(noClock.map((r) => [r.external_id, r.day]), [['trip', '2026-10-12']]);
  const huge = parseEvents({ items: [{ id: 'long', summary: 'x', start: { date: '2026-10-01' }, end: { date: '2027-10-01' } }] }, Date.parse('2026-10-05T00:00:00Z'));
  assert.ok(huge.length <= 4 && huge.every((r) => r.day! >= '2026-10-04' && r.day! <= '2026-10-07'), 'a year-long event saves only the days around now');
  const brokenEnd = parseEvents({ items: [{ id: 'x', summary: 'x', start: { date: '2026-10-13' }, end: { date: '2026-10-01' } }] }, Date.parse('2026-10-13T09:00:00Z'));
  assert.deepEqual(brokenEnd.map((r) => [r.external_id, r.day]), [['x', '2026-10-13']], 'an end before the start is one day');
});

// ---------------------------------------------------------------- refreshAgenda against fake Google
interface World { events: any[]; lists: Array<{ id: string; tasks: any[] }>; calls: string[]; status: Record<string, number>; throws: Record<string, boolean>; body: Record<string, any> }
const makeWorld = (over: Partial<World> = {}): World => ({ events: [], lists: [{ id: 'L1', tasks: [] }], calls: [], status: {}, throws: {}, body: {}, ...over });

function install(world: World) {
  globalThis.fetch = (async (input: any) => {
    const url = String(input);
    const key = url.includes('/calendar/v3/') ? 'events' : url.includes('/users/@me/lists') ? 'lists' : /\/lists\/([^/]+)\/tasks/.test(url) ? 'tasks:' + decodeURIComponent(/\/lists\/([^/]+)\/tasks/.exec(url)![1]) : url.startsWith('https://oauth2.googleapis.com/token') ? 'token' : 'other';
    world.calls.push(key);
    if (key === 'token') return json(200, { access_token: 'fake' });
    const group = key.startsWith('tasks:') ? 'tasks' : key;
    if (world.throws[key] || world.throws[group]) throw new Error('network blip');
    const status = world.status[key] ?? world.status[group] ?? 200;
    if (status !== 200) return json(status, world.body[key] ?? world.body[group] ?? { error: { message: 'failure ' + status } });
    if (key === 'events') return json(200, { items: world.events });
    if (key === 'lists') return json(200, { items: world.lists.map((l) => ({ id: l.id })) });
    if (key.startsWith('tasks:')) return json(200, { items: world.lists.find((l) => 'tasks:' + l.id === key)?.tasks ?? [] });
    if (url.includes('/history?')) return json(200, { history: [], historyId: '900' });
    if (url.endsWith('/profile')) return json(200, { historyId: '900' });
    throw new Error('unexpected fetch ' + url);
  }) as typeof fetch;
}

const conn = (over: Row = {}): any => ({ user_id: U, status: 'active', history_id: '100', refresh_token: 'rt', has_calendar: true, has_tasks: true, agenda_checked_at: null, ...over });
const mk = (extra: Record<string, Row[]> = {}, over: Row = {}) => makeDb({ gmail_connections: [conn(over)], gmail_digest: [], gmail_usage: [], gmail_agenda: [], ...extra });
const agendaOf = (db: any, kind?: string, user = U) => db.tables.gmail_agenda.filter((r: Row) => r.user_id === user && (!kind || r.kind === kind));
const ids = (rows: Row[]) => rows.map((r) => r.external_id).sort();

test('both calendar and tasks are saved for the member, and the time of the check is stamped', async () => {
  const w = makeWorld({ events: [timed('e1', '2026-10-12T10:00:00Z'), allDay('e2', '2026-10-13')], lists: [{ id: 'L1', tasks: [task('t1', '2026-10-13'), task('t2', null)] }, { id: 'L2', tasks: [task('t3', '2026-10-11')] }] });
  install(w);
  const db = mk();
  await refreshAgenda(db as any, db.tables.gmail_connections[0], 'tok', NOW);
  assert.deepEqual(ids(agendaOf(db, 'event')), ['e1', 'e2']);
  assert.deepEqual(ids(agendaOf(db, 'task')), ['t1', 't3'], 'a task without a due day is not saved');
  assert.equal(db.tables.gmail_connections[0].agenda_checked_at, new Date(NOW).toISOString());
});

test('a member who did not tick the permission causes no Google request at all', async () => {
  const w = makeWorld({ events: [timed('e1', '2026-10-12T10:00:00Z')] });
  install(w);
  const db = mk({}, { has_calendar: false, has_tasks: false });
  await refreshAgenda(db as any, db.tables.gmail_connections[0], 'tok', NOW);
  assert.deepEqual(w.calls, []);
  assert.equal(db.tables.gmail_connections[0].agenda_checked_at, null);
  const onlyTasks = mk({}, { has_calendar: false });
  await refreshAgenda(onlyTasks as any, onlyTasks.tables.gmail_connections[0], 'tok', NOW);
  assert.ok(!w.calls.includes('events'));
});

test('asked at most every 10 minutes; a later check removes what is no longer there and leaves other members alone', async () => {
  const w = makeWorld({ events: [timed('e1', '2026-10-12T10:00:00Z'), timed('e2', '2026-10-12T11:00:00Z')], lists: [{ id: 'L1', tasks: [task('t1', '2026-10-13')] }] });
  install(w);
  // the other member holds rows with the SAME external ids that will become stale for the first member
  const db = mk({ gmail_agenda: [{ user_id: OTHER, kind: 'event', external_id: 'e2', title: 'x', all_day: false, starts_at: '2026-10-12T10:00:00Z' }, { user_id: OTHER, kind: 'task', external_id: 't1', title: 'x', all_day: false, day: '2026-10-13' }] });
  const c = db.tables.gmail_connections[0];
  await refreshAgenda(db as any, c, 'tok', NOW);
  const calls = w.calls.length;
  await refreshAgenda(db as any, c, 'tok', NOW + 9 * 60_000);
  assert.equal(w.calls.length, calls, 'nothing asked within 10 minutes');
  w.events = [w.events[0]]; w.lists[0].tasks = [];
  await refreshAgenda(db as any, c, 'tok', NOW + 10 * 60_000);
  assert.deepEqual(ids(agendaOf(db, 'event')), ['e1']);
  assert.deepEqual(ids(agendaOf(db, 'task')), []);
  assert.deepEqual(ids(agendaOf(db, undefined, OTHER)), ['e2', 't1'], 'the other member kept their rows even with identical ids');
});

test('a changed title or time is updated, not duplicated', async () => {
  const w = makeWorld({ events: [timed('e1', '2026-10-12T10:00:00Z')] });
  install(w);
  const db = mk({}, { has_tasks: false });
  const c = db.tables.gmail_connections[0];
  await refreshAgenda(db as any, c, 'tok', NOW);
  w.events = [timed('e1', '2026-10-12T15:00:00Z', { summary: 'Moved' })];
  await refreshAgenda(db as any, c, 'tok', NOW + 11 * 60_000);
  assert.equal(agendaOf(db).length, 1);
  assert.equal(agendaOf(db)[0].title, 'Moved');
  assert.equal(agendaOf(db)[0].starts_at, '2026-10-12T15:00:00.000Z');
});

test('Google busy (429/5xx) or unreachable: the saved day stays as it was; the other service is still refreshed', async () => {
  for (const failure of [{ status: { events: 429 } }, { status: { events: 503 } }, { throws: { events: true } }]) {
    const w = makeWorld({ events: [timed('new', '2026-10-12T10:00:00Z')], lists: [{ id: 'L1', tasks: [task('t-new', '2026-10-13')] }], ...failure });
    install(w);
    const db = mk({ gmail_agenda: [{ user_id: U, kind: 'event', external_id: 'old', title: 'old', all_day: false, starts_at: '2026-10-12T08:00:00Z' }] });
    await refreshAgenda(db as any, db.tables.gmail_connections[0], 'tok', NOW);
    assert.deepEqual(ids(agendaOf(db, 'event')), ['old'], JSON.stringify(failure));
    assert.deepEqual(ids(agendaOf(db, 'task')), ['t-new'], 'tasks do not depend on the calendar');
    assert.equal(db.tables.gmail_connections[0].has_calendar, true, 'a temporary failure never switches the permission off');
  }
});

test('Google says the permission is gone: the flag is switched off and that kind is deleted; the other kind stays', async () => {
  const w = makeWorld({ status: { events: 403 }, body: { events: { error: { message: 'Request had insufficient authentication scopes.' } } }, lists: [{ id: 'L1', tasks: [task('t1', '2026-10-13')] }] });
  install(w);
  const db = mk({ gmail_agenda: [{ user_id: U, kind: 'event', external_id: 'old', title: 'old', all_day: false, starts_at: '2026-10-12T08:00:00Z' }, { user_id: OTHER, kind: 'event', external_id: 'theirs', title: 'x', all_day: false, starts_at: '2026-10-12T08:00:00Z' }] });
  await refreshAgenda(db as any, db.tables.gmail_connections[0], 'tok', NOW);
  assert.equal(db.tables.gmail_connections[0].has_calendar, false);
  assert.equal(db.tables.gmail_connections[0].has_tasks, true);
  assert.deepEqual(ids(agendaOf(db, 'event')), []);
  assert.deepEqual(ids(agendaOf(db, 'task')), ['t1']);
  assert.deepEqual(ids(agendaOf(db, 'event', OTHER)), ['theirs']);
});

test('the API being switched off in our Google project does NOT remove the member\'s permission or their saved day', async () => {
  const w = makeWorld({ status: { events: 403 }, body: { events: { error: { message: 'Google Calendar API has not been used in project 1 before or it is disabled.' } } } });
  install(w);
  const db = mk({ gmail_agenda: [{ user_id: U, kind: 'event', external_id: 'old', title: 'old', all_day: false, starts_at: '2026-10-12T08:00:00Z' }] });
  await refreshAgenda(db as any, db.tables.gmail_connections[0], 'tok', NOW);
  assert.equal(db.tables.gmail_connections[0].has_calendar, true);
  assert.deepEqual(ids(agendaOf(db, 'event')), ['old']);
});

test('one task list that cannot be read changes nothing about the tasks (no wrongful delete)', async () => {
  const w = makeWorld({ lists: [{ id: 'L1', tasks: [task('t1', '2026-10-13')] }, { id: 'L2', tasks: [task('t2', '2026-10-13')] }], status: { 'tasks:L2': 500 } });
  install(w);
  const db = mk({ gmail_agenda: [{ user_id: U, kind: 'task', external_id: 'old-in-L2', title: 'old', all_day: false, day: '2026-10-13' }] }, { has_calendar: false });
  await refreshAgenda(db as any, db.tables.gmail_connections[0], 'tok', NOW);
  assert.deepEqual(ids(agendaOf(db, 'task')), ['old-in-L2']);
});

test('a failed write never deletes the old rows', async () => {
  const w = makeWorld({ events: [timed('new', '2026-10-12T10:00:00Z')] });
  install(w);
  const db = mk({ gmail_agenda: [{ user_id: U, kind: 'event', external_id: 'old', title: 'old', all_day: false, starts_at: '2026-10-12T08:00:00Z' }] }, { has_tasks: false });
  db.failing['gmail_agenda.upsert'] = true;
  await refreshAgenda(db as any, db.tables.gmail_connections[0], 'tok', NOW);
  assert.deepEqual(ids(agendaOf(db, 'event')), ['old']);
});

test('a calendar that is empty clears the saved events (the day really is free)', async () => {
  const w = makeWorld({ events: [] });
  install(w);
  const db = mk({ gmail_agenda: [{ user_id: U, kind: 'event', external_id: 'old', title: 'old', all_day: false, starts_at: '2026-10-12T08:00:00Z' }] }, { has_tasks: false });
  await refreshAgenda(db as any, db.tables.gmail_connections[0], 'tok', NOW);
  assert.deepEqual(agendaOf(db), []);
});

// ---------------------------------------------------------------- inside the real sync
test('inside syncOne: the agenda is saved, and a failing calendar never turns a good sync into a failed one', async () => {
  const w = makeWorld({ events: [timed('e1', '2026-10-12T10:00:00Z')] });
  install(w);
  const db = mk();
  const first = await syncOne(db as any, db.tables.gmail_connections[0]);
  assert.equal(first.error, undefined);
  assert.deepEqual(ids(agendaOf(db, 'event')), ['e1']);

  const w2 = makeWorld({ throws: { events: true, lists: true } });
  install(w2);
  const db2 = mk();
  const second = await syncOne(db2 as any, db2.tables.gmail_connections[0]);
  assert.deepEqual(second, { saved: 0 });
  assert.ok(db2.tables.gmail_connections[0].last_checked_at, 'the sync itself finished');
});

// ---------------------------------------------------------------- chaos
test('chaos: random failures in Google and the database, repeated runs, a jumping clock: other members are never touched and after healing the saved day equals Google\'s', async () => {
  for (let seed = 1; seed <= 40; seed++) {
    const r = rng(seed * 7919);
    const w = makeWorld({ events: Array.from({ length: 1 + Math.floor(r() * 6) }, (_, i) => (r() < 0.5 ? timed('e' + i, '2026-10-12T1' + (i % 10) + ':00:00Z') : allDay('e' + i, '2026-10-13'))), lists: [{ id: 'L1', tasks: Array.from({ length: Math.floor(r() * 5) }, (_, i) => task('a' + i, '2026-10-13')) }, { id: 'L2', tasks: Array.from({ length: Math.floor(r() * 4) }, (_, i) => task('b' + i, '2026-10-14')) }] });
    install(w);
    const db = mk({ gmail_agenda: [{ user_id: OTHER, kind: 'event', external_id: 'theirs', title: 'x', all_day: false, starts_at: '2026-10-12T10:00:00Z' }, { user_id: OTHER, kind: 'task', external_id: 'theirs-t', title: 'x', all_day: false, day: '2026-10-13' }] });
    const c = db.tables.gmail_connections[0];
    let clock = NOW;
    for (let round = 0; round < 8; round++) {
      w.status = r() < 0.4 ? { [pick(r, ['events', 'lists', 'tasks'])]: pick(r, [429, 500, 503]) } : {};
      w.throws = r() < 0.3 ? { [pick(r, ['events', 'lists', 'tasks'])]: true } : {};
      db.failing['gmail_agenda.upsert'] = r() < 0.25;
      db.failing['gmail_agenda.delete'] = r() < 0.25;
      db.failing['gmail_agenda.select'] = r() < 0.15;
      if (r() < 0.5) { w.events = w.events.slice(0, Math.floor(r() * w.events.length)); w.lists[0].tasks = w.lists[0].tasks.slice(0, Math.floor(r() * (w.lists[0].tasks.length + 1))); }
      clock += r() < 0.2 ? -5 * 60_000 : 11 * 60_000;
      await refreshAgenda(db as any, c, 'tok', clock);
      assert.deepEqual(ids(agendaOf(db, undefined, OTHER)), ['theirs', 'theirs-t'], `seed ${seed} round ${round}: another member's rows changed`);
      assert.equal(c.has_calendar, true, 'temporary failures never switch a permission off');
      assert.equal(c.has_tasks, true);
    }
    w.status = {}; w.throws = {}; for (const key of Object.keys(db.failing)) delete db.failing[key];
    await refreshAgenda(db as any, c, 'tok', clock + 60 * 60_000);
    assert.deepEqual(ids(agendaOf(db, 'event')), w.events.map((e) => e.id).sort(), `seed ${seed}: events after healing`);
    assert.deepEqual(ids(agendaOf(db, 'task')), w.lists.flatMap((l) => l.tasks.map((t) => t.id)).sort(), `seed ${seed}: tasks after healing`);
  }
});
function pick<T>(r: () => number, list: T[]): T { return list[Math.floor(r() * list.length)]; }
