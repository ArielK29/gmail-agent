const test = require('node:test');
const assert = require('node:assert/strict');
const { authMessage, validateCredentials, problemMessage, emptyStateText, dailySummary, summaryHeadline, urgentHeadline, safeText, scanErrorMessage, parseItemsText, validateScanForm, scanProgressText, rollupItems, lastFullMonth, morningBriefing, agendaBriefing, deadlineLabel, greeting, localDay, planView, isProRow, billingErrorMessage, isPayUrl, priceText, deleteAccountMessage, deleteAccountConfirmText, oauthReturnMessage } = require('./logic.js');

test('authMessage maps the Supabase errors seen in the browser run', () => {
  assert.equal(authMessage({ message: 'Invalid login credentials' }), 'האימייל או הסיסמה שגויים.');
  assert.equal(authMessage({ message: 'missing email or phone' }), 'יש למלא אימייל וסיסמה.');
  assert.equal(authMessage({ message: 'Anonymous sign-ins are disabled' }), 'יש למלא אימייל וסיסמה.');
  assert.equal(authMessage({ message: 'Email not confirmed' }), 'צריך לאשר את כתובת האימייל. בדוק את תיבת הדואר.');
  assert.equal(authMessage({ message: 'User already registered' }), 'כבר קיים חשבון עם האימייל הזה. נסה להתחבר.');
  assert.equal(authMessage({ message: 'Password should be at least 6 characters.' }), 'הסיסמה קצרה מדי (לפחות 6 תווים).');
  assert.equal(authMessage({ code: 'over_email_send_rate_limit', message: 'email rate limit exceeded' }), 'נשלחו יותר מדי ניסיונות. נסה שוב בעוד כמה דקות.');
  assert.equal(authMessage({ message: 'Failed to fetch' }), 'אין חיבור לאינטרנט. נסה שוב.');
});

test('authMessage never shows English, even for an error it does not know', () => {
  for (const error of [{ message: 'Some brand new English sentence' }, {}, null, undefined, { code: 'weird_code' }]) {
    assert.doesNotMatch(authMessage(error), /[A-Za-z]/);
  }
});

test('validateCredentials checks the form before the server is asked', () => {
  assert.equal(validateCredentials('', ''), 'יש להכניס אימייל.');
  assert.equal(validateCredentials('   ', 'x'), 'יש להכניס אימייל.');
  assert.equal(validateCredentials('not-an-email', 'x'), 'כתובת האימייל לא תקינה.');
  assert.equal(validateCredentials('a@b.co', ''), 'יש להכניס סיסמה.');
  assert.equal(validateCredentials(' a@b.co ', 'secret'), null);
});

test('problemMessage translates what the sync function reports', () => {
  assert.equal(problemMessage('access was revoked or expired: connect Gmail again'), 'החיבור ל-Gmail פג. חבר את Gmail מחדש.');
  assert.match(problemMessage('Gemini: quota exceeded'), /שירות הסיכום/);
  assert.match(problemMessage('Gmail: Backend Error'), /Gmail לא ענה/);
  assert.match(problemMessage('Google token: server_error'), /Google/);
  assert.equal(problemMessage('could not save'), 'לא הצלחנו לשמור את הסיכומים. ננסה שוב אוטומטית.');
  assert.doesNotMatch(problemMessage('something nobody planned for'), /[A-Za-z]/);
});

test('emptyStateText follows the real connection state', () => {
  assert.equal(emptyStateText({ connected: false, expired: false }), 'חבר את Gmail כדי להתחיל לקבל סיכומים.');
  assert.equal(emptyStateText({ connected: true, expired: true }), 'החיבור פג. חבר שוב כדי להמשיך.');
  assert.equal(emptyStateText({ connected: true, expired: false }), 'עוד אין מיילים. לחץ "בדוק מיילים חדשים עכשיו".');
});

test('problemMessage separates "usage counter failed" from "summaries failed"', () => {
  assert.equal(problemMessage('could not save usage'), 'הסיכומים נשמרו, אבל לא הצלחנו לעדכן את מונה השימוש. ננסה שוב אוטומטית.');
  assert.equal(problemMessage('could not save'), 'לא הצלחנו לשמור את הסיכומים. ננסה שוב אוטומטית.');
});

// Guard (issue #4): nothing the page can show comes out in English. The only Latin letters allowed are the
// brand names "Gmail" and "Google" inside a Hebrew sentence.
test('every message the page can show is Hebrew (brand names aside)', () => {
  const withoutBrands = (text) => text.replace(/Gmail|Google/g, '');
  const samples = ['', 'x', 'Gemini: ???', 'Gmail: 500', 'Google token: boom', 'could not save usage', 'could not save', 'delete_failed', 'access was revoked or expired: connect Gmail again', 'unknown error'];
  for (const sample of samples) assert.doesNotMatch(withoutBrands(problemMessage(sample)), /[A-Za-z]/, `problemMessage(${JSON.stringify(sample)})`);
  const errors = [null, undefined, {}, { message: 'x' }, { code: 'weird' }, { message: 'Invalid login credentials' }, { message: 'Failed to fetch' }];
  for (const error of errors) assert.doesNotMatch(withoutBrands(authMessage(error)), /[A-Za-z]/, `authMessage(${JSON.stringify(error)})`);
  for (const state of [{ connected: false, expired: false }, { connected: true, expired: true }, { connected: true, expired: false }]) {
    assert.doesNotMatch(withoutBrands(emptyStateText(state)), /[A-Za-z]/);
  }
  for (const [e, p] of [['', ''], ['a@b', 'x'], ['a@b.co', '']]) assert.doesNotMatch(withoutBrands(String(validateCredentials(e, p))), /[A-Za-z]/);
});

// ---- Daily summary (the "last 24 hours" card) ----
const NOW = new Date('2026-10-12T09:00:00Z');
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600 * 1000).toISOString();
const mail = (over) => ({ from_name: 'שולח', subject: 'נושא', category: 'other', summary: 'סיכום', urgency: 'normal', suggested_action: null, received_at: hoursAgo(1), ...over });

test('dailySummary counts only the last 24 hours', () => {
  const rows = [mail({ received_at: hoursAgo(1) }), mail({ received_at: hoursAgo(23.9) }), mail({ received_at: hoursAgo(24.1) }), mail({ received_at: hoursAgo(72) })];
  assert.equal(dailySummary(rows, NOW).total, 2);
});

test('dailySummary lists urgent mails newest first, at most 5, and says how many more', () => {
  const rows = [];
  for (let i = 1; i <= 7; i++) rows.push(mail({ urgency: 'high', subject: 'דחוף ' + i, received_at: hoursAgo(i) }));
  rows.push(mail({ urgency: 'low' }), mail({ urgency: null }));
  const s = dailySummary(rows, NOW);
  assert.equal(s.urgentCount, 7);
  assert.equal(s.urgent.length, 5);
  assert.equal(s.urgentMore, 2);
  assert.deepEqual(s.urgent.map((r) => r.subject), ['דחוף 1', 'דחוף 2', 'דחוף 3', 'דחוף 4', 'דחוף 5']);
});

test('dailySummary counts mails that carry a suggested action and groups by category, biggest first', () => {
  const rows = [
    mail({ category: 'finance', suggested_action: 'בדוק' }), mail({ category: 'finance' }), mail({ category: 'work', suggested_action: ' ' }),
    mail({ category: 'promotion' }), mail({ category: 'promotion' }), mail({ category: 'promotion' }),
  ];
  const s = dailySummary(rows, NOW);
  assert.equal(s.actionCount, 1, 'blank suggestions do not count');
  assert.deepEqual(s.byCategory, [{ category: 'promotion', count: 3 }, { category: 'finance', count: 2 }, { category: 'work', count: 1 }]);
});

test('dailySummary survives missing, empty and broken input', () => {
  for (const rows of [null, undefined, [], [null], [{}], [{ received_at: 'not a date' }], 'x']) {
    const s = dailySummary(rows, NOW);
    assert.equal(s.total, 0);
    assert.equal(s.urgentCount, 0);
    assert.deepEqual(s.urgent, []);
    assert.deepEqual(s.byCategory, []);
  }
});

test('dailySummary warns when the loaded list may be cut off', () => {
  const full = Array.from({ length: 200 }, () => mail({ received_at: hoursAgo(2) }));
  assert.equal(dailySummary(full, NOW, 200).incomplete, true, 'a full page that is still inside the window may hide more');
  const reachedOlder = full.slice(0, 199).concat([mail({ received_at: hoursAgo(30) })]);
  assert.equal(dailySummary(reachedOlder, NOW, 200).incomplete, false, 'the list already reaches mails older than a day');
  assert.equal(dailySummary(full.slice(0, 10), NOW, 200).incomplete, false);
});

test('headlines use the right Hebrew number form', () => {
  assert.equal(summaryHeadline(0), 'אין מיילים חדשים ב-24 השעות האחרונות.');
  assert.equal(summaryHeadline(1), 'מייל אחד חדש ב-24 השעות האחרונות.');
  assert.equal(summaryHeadline(12), '12 מיילים חדשים ב-24 השעות האחרונות.');
  assert.equal(urgentHeadline(0), 'אין מיילים דחופים.');
  assert.equal(urgentHeadline(1), 'מייל דחוף אחד:');
  assert.equal(urgentHeadline(3), '3 מיילים דחופים:');
});

test('summary headlines are Hebrew only', () => {
  for (const text of [summaryHeadline(0), summaryHeadline(1), summaryHeadline(5), urgentHeadline(0), urgentHeadline(1), urgentHeadline(9)]) {
    assert.doesNotMatch(text, /[A-Za-z]/);
  }
});
// ---- Professional-grade checks: attacker text, properties over thousands of random inputs, time edges ----
// A tiny seeded random generator: the "random" runs are the same every time, so a failure can be reproduced.
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200D\u2060\u202A-\u202E\u2066-\u2069\uFEFF]/;

test('safeText removes text-reordering and invisible characters but keeps real text', () => {
  assert.equal(safeText('invoice\u202Efdp.exe'), 'invoicefdp.exe', 'right-to-left override');
  assert.equal(safeText('a\u2066b\u2069c\u202Ad\u202Ce'), 'abcde', 'isolates and embeddings');
  assert.equal(safeText('pay\u200Bpal\u200D.com\uFEFF'), 'paypal.com', 'zero-width characters used to fake a name');
  assert.equal(safeText('שלום\u200F world\u200E 😀 O\'Reilly'), 'שלום\u200F world\u200E 😀 O\'Reilly', 'Hebrew, English, emoji and the harmless direction marks stay');
  assert.equal(safeText('a\u0000b\u0007c\u001Bd\u009Fe'), 'abcde', 'control characters');
  assert.equal(safeText('line1\nline2\ttab'), 'line1\nline2\ttab', 'newline and tab are normal text');
  for (const bad of [null, undefined, 5, {}, [], true]) assert.equal(safeText(bad), '');
});

test('safeText: random strings never keep a forbidden character, and cleaning twice equals cleaning once', () => {
  const pool = ['a', 'ש', ' ', '\u202E', '\u200B', '\u2066', '\u0000', '😀', '\uFEFF', '\u200F', 'Z', '\n', '\u009F', '\u2069', '9'];
  const next = rng(7);
  for (let n = 0; n < 3000; n++) {
    let s = ''; for (let i = 0, len = Math.floor(next() * 40); i < len; i++) s += pool[Math.floor(next() * pool.length)];
    const once = safeText(s);
    assert.doesNotMatch(once, FORBIDDEN, JSON.stringify(s));
    assert.equal(safeText(once), once, 'idempotent: ' + JSON.stringify(s));
  }
});

// Random mails, some of them broken in ways a real mailbox could produce.
function randomRow(next, now) {
  const pick = (list) => list[Math.floor(next() * list.length)];
  const age = pick([0, 1, 59, 3600, 86399, 86400, 86401, 7 * 86400, -3600, -86400 * 3]) * 1000 + Math.floor(next() * 5000);
  return pick([
    () => ({ from_name: pick(['A', null, '', 'Name <a@b.c>']), subject: pick(['S', null]), category: pick(['finance', 'work', 'other', 'weird', null, undefined]), summary: 'x', urgency: pick(['high', 'low', 'normal', null, 'HIGH', 'urgent', undefined]), suggested_action: pick([null, '', '  ', 'do it', 5]), received_at: new Date(now.getTime() - age).toISOString() }),
    () => ({ received_at: pick(['garbage', '', null, undefined, 12345, {}, '2026-13-45T99:99:99Z']) }),
    () => pick([null, undefined, 5, 'str', [], {}]),
  ])();
}

test('dailySummary invariants hold for 2000 random mailboxes (including broken rows and clock-skewed dates)', () => {
  const now = new Date('2026-10-12T09:00:00Z');
  const next = rng(2026);
  for (let n = 0; n < 2000; n++) {
    const rows = Array.from({ length: Math.floor(next() * 60) }, () => randomRow(next, now));
    const s = dailySummary(rows, now, 200);
    assert.ok(s.total >= 0 && s.total <= rows.length);
    assert.ok(s.urgentCount <= s.total, 'urgent mails are a subset of the mails');
    assert.ok(s.urgent.length <= 5 && s.urgent.length === Math.min(5, s.urgentCount));
    assert.equal(s.urgentMore, s.urgentCount - s.urgent.length);
    assert.equal(s.byCategory.reduce((sum, entry) => sum + entry.count, 0), s.total, 'every counted mail is in exactly one category');
    assert.ok(s.actionCount <= s.total);
    for (let i = 1; i < s.byCategory.length; i++) assert.ok(s.byCategory[i - 1].count >= s.byCategory[i].count, 'biggest category first');
    const times = s.urgent.map((row) => new Date(row.received_at).getTime());
    for (let i = 1; i < times.length; i++) assert.ok(times[i - 1] >= times[i], 'newest first');
    for (const row of s.urgent) assert.equal(row.urgency, 'high');
    assert.equal(typeof summaryHeadline(s.total), 'string');
  }
});

test('dailySummary does not depend on the order of the rows (metamorphic check)', () => {
  const now = new Date('2026-10-12T09:00:00Z');
  const next = rng(99);
  for (let n = 0; n < 300; n++) {
    const rows = Array.from({ length: 30 }, () => randomRow(next, now)).filter((row) => row && typeof row === 'object');
    const shuffled = rows.map((row) => [next(), row]).sort((a, b) => a[0] - b[0]).map((pair) => pair[1]);
    const a = dailySummary(rows, now, 200); const b = dailySummary(shuffled, now, 200);
    assert.equal(a.total, b.total); assert.equal(a.urgentCount, b.urgentCount); assert.equal(a.actionCount, b.actionCount);
    assert.deepEqual(a.byCategory, b.byCategory);
  }
});

test('dailySummary: the 24 hour edge is exact, in every season, and the input is never changed', () => {
  for (const nowText of ['2026-03-27T23:59:59.999Z', '2026-10-25T01:30:00Z', '2028-02-29T00:00:00Z', '2026-12-31T23:59:59Z']) {
    const now = new Date(nowText);
    const at = (msAgo) => ({ category: 'work', summary: 'x', received_at: new Date(now.getTime() - msAgo).toISOString() });
    const rows = [at(86399999), at(86400000), at(86400001), at(0), at(-1)];
    const copy = JSON.parse(JSON.stringify(rows));
    assert.equal(dailySummary(rows, now).total, 3, nowText + ': 24h minus 1 ms counts, exactly 24h does not; "now" and a clock-skewed future mail count');
    assert.deepEqual(rows, copy, 'the rows were not modified');
  }
});

test('dailySummary: a 100000-mail mailbox is summarized fast', () => {
  const now = new Date('2026-10-12T09:00:00Z');
  const rows = Array.from({ length: 100000 }, (_, i) => ({ category: 'work', summary: 's', urgency: i % 9 === 0 ? 'high' : 'normal', received_at: new Date(now.getTime() - (i % 200000) * 1000).toISOString() }));
  const started = Date.now();
  const s = dailySummary(rows, now, 200);
  assert.ok(Date.now() - started < 2000, 'under 2 seconds');
  assert.ok(s.total > 0);
});
// ---- On-demand scan (issue #15): what the page decides ----
test('scanErrorMessage: every code the server can send has a Hebrew sentence; unknown codes are Hebrew too', () => {
  for (const code of ['consent_required', 'bad_dates', 'period_too_long', 'nothing_to_search', 'not_connected', 'needs_reconnect', 'scan_in_progress', 'daily_scan_limit', 'invalid_query', 'daily_budget', 'could_not_start', 'bad_request', 'not_found', 'weird', '', null, undefined, 5]) {
    const text = scanErrorMessage(code);
    assert.ok(typeof text === 'string' && text.length > 5);
    assert.doesNotMatch(text.replace(/Gmail/g, ''), /[A-Za-z]/, String(code));
  }
});

test('parseItemsText: one item per line, cleaned, no duplicates, at most 100', () => {
  assert.deepEqual(parseItemsText('  INV-1 \n\ninv-1\nAcme Ltd\r\n   \nשלום'), ['INV-1', 'Acme Ltd', 'שלום']);
  assert.equal(parseItemsText(Array.from({ length: 300 }, (_, i) => 'i' + i).join('\n')).length, 100);
  assert.deepEqual(parseItemsText(''), []);
  assert.deepEqual(parseItemsText(null), []);
  assert.deepEqual(parseItemsText('a\u202Eb\u200Bc'), ['abc']);
  assert.ok(parseItemsText('x'.repeat(5000))[0].length <= 120);
});

test('validateScanForm: the same rules as the server, in Hebrew, before anything is sent', () => {
  const today = '2026-10-12';
  const ok = { from: '2026-01-01', to: '2026-01-31', query: 'invoice', itemsText: 'INV-1', consent: true };
  assert.equal(validateScanForm(ok, today), null);
  assert.match(validateScanForm({ ...ok, consent: false }, today), /הסכמה/);
  assert.match(validateScanForm({ ...ok, from: '' }, today), /תאריכ/);
  assert.match(validateScanForm({ ...ok, from: '2026-02-30' }, today), /תאריכ/);
  assert.match(validateScanForm({ ...ok, to: '2026-10-13' }, today), /תאריכ/);
  assert.match(validateScanForm({ ...ok, from: '2026-02-01', to: '2026-01-01' }, today), /תאריכ/);
  assert.match(validateScanForm({ ...ok, from: '2025-01-01', to: '2026-01-31' }, today), /שנה/);
  assert.match(validateScanForm({ ...ok, query: '  ', itemsText: ' \n ' }, today), /לחפש/);
  assert.equal(validateScanForm({ ...ok, from: '2028-01-01', to: '2028-12-31' }, '2029-12-31'), null, 'a leap year fits');
  for (const garbage of [null, undefined, {}, 5]) assert.equal(typeof validateScanForm(garbage, today), 'string');
});

test('scanProgressText says what is happening, in Hebrew', () => {
  assert.match(scanProgressText({ status: 'queued', processed: 0, total: 0 }), /מתחיל|ממתין/);
  assert.match(scanProgressText({ status: 'running', processed: 30, total: 75 }), /30.*75/);
  assert.match(scanProgressText({ status: 'done', processed: 75, total: 75 }), /הסתיימה.*75/);
  assert.match(scanProgressText({ status: 'done', processed: 0, total: 0 }), /לא נמצאו/);
  assert.match(scanProgressText({ status: 'paused', processed: 10, total: 40, error: 'daily_budget' }), /מחר/);
  assert.match(scanProgressText({ status: 'failed', processed: 3, total: 9, error: 'needs_reconnect' }), /חבר/);
  assert.match(scanProgressText({ status: 'cancelled', processed: 3, total: 9 }), /בוטלה/);
  for (const garbage of [null, undefined, {}, { status: 'zzz' }]) assert.equal(typeof scanProgressText(garbage), 'string');
});

test('rollupItems: for every item, the mails that matched it; invalid indexes are ignored; order is the order of the list', () => {
  const items = ['INV-1', 'Acme', 'nothing'];
  const hits = [
    { gmail_message_id: 'a', matches: [0, 1], subject: 's1' },
    { gmail_message_id: 'b', matches: [1], subject: 's2' },
    { gmail_message_id: 'c', matches: [], subject: 's3' },
    { gmail_message_id: 'd', matches: [7, -1, 1.5, '0', null], subject: 's4' },
    { gmail_message_id: 'e' },
  ];
  const result = rollupItems(items, hits);
  assert.deepEqual(result.map((r) => [r.item, r.hits.map((h) => h.gmail_message_id)]), [['INV-1', ['a']], ['Acme', ['a', 'b']], ['nothing', []]]);
  assert.deepEqual(rollupItems([], hits), []);
  assert.deepEqual(rollupItems(items, null).map((r) => r.hits.length), [0, 0, 0]);
  assert.deepEqual(rollupItems(null, hits), []);
});

test('rollupItems: 1000 random results - counts are consistent and nothing throws', () => {
  const next = rng(5);
  for (let n = 0; n < 1000; n++) {
    const items = Array.from({ length: Math.floor(next() * 6) }, (_, i) => 'item' + i);
    const hits = Array.from({ length: Math.floor(next() * 30) }, (_, i) => ({ gmail_message_id: 'm' + i, matches: Array.from({ length: Math.floor(next() * 5) }, () => Math.floor(next() * 9) - 2) }));
    const result = rollupItems(items, hits);
    assert.equal(result.length, items.length);
    result.forEach((entry, index) => {
      const expected = hits.filter((h) => h.matches.includes(index)).length;
      assert.equal(entry.hits.length, expected);
    });
  }
});

test('lastFullMonth: the previous calendar month, in every kind of month', () => {
  assert.deepEqual(lastFullMonth(new Date(2026, 9, 12)), { from: '2026-09-01', to: '2026-09-30' });
  assert.deepEqual(lastFullMonth(new Date(2026, 0, 5)), { from: '2025-12-01', to: '2025-12-31' }, 'January looks back into December of the previous year');
  assert.deepEqual(lastFullMonth(new Date(2028, 2, 1)), { from: '2028-02-01', to: '2028-02-29' }, 'leap February');
  assert.deepEqual(lastFullMonth(new Date(2026, 2, 31)), { from: '2026-02-01', to: '2026-02-28' });
});
// ---- Morning briefing (issue #16): what the page decides ----
const BNOW = new Date('2026-10-12T09:00:00Z');
const bAgo = (hours) => new Date(BNOW.getTime() - hours * 3600 * 1000).toISOString();
const brow = (over) => ({ from_name: 'Dana', subject: 's', summary: 'x', category: 'work', urgency: 'normal', received_at: bAgo(30), due_date: null, needs_reply: null, ...over });

test('deadlineLabel: Hebrew wording for overdue, today, tomorrow and later', () => {
  assert.equal(deadlineLabel(0), 'היום');
  assert.equal(deadlineLabel(1), 'מחר');
  assert.equal(deadlineLabel(5), 'בעוד 5 ימים');
  assert.equal(deadlineLabel(-1), 'באיחור של יום');
  assert.equal(deadlineLabel(-12), 'באיחור של 12 ימים');
  for (const n of [-40, -1, 0, 1, 2, 7, 30]) assert.doesNotMatch(deadlineLabel(n), /[A-Za-z]/);
});

test('greeting follows the hour', () => {
  const at = (h) => greeting(new Date(2026, 9, 12, h, 0, 0));
  assert.equal(at(7), 'בוקר טוב'); assert.equal(at(13), 'צהריים טובים'); assert.equal(at(18), 'ערב טוב'); assert.equal(at(23), 'לילה טוב'); assert.equal(at(2), 'לילה טוב');
  assert.equal(greeting(null), 'שלום');
});

test('localDay is the member\'s own calendar day', () => {
  assert.equal(localDay(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
  assert.equal(localDay(new Date(2028, 1, 29, 0, 1)), '2028-02-29');
});

test('morningBriefing: deadlines from 30 days overdue to 7 days ahead, soonest first, overdue labelled', () => {
  const today = '2026-10-12';
  const rows = [
    brow({ subject: 'in 7', due_date: '2026-10-19' }), brow({ subject: 'in 8', due_date: '2026-10-20' }),
    brow({ subject: 'today', due_date: '2026-10-12' }), brow({ subject: 'tomorrow', due_date: '2026-10-13' }),
    brow({ subject: 'late 1', due_date: '2026-10-11' }), brow({ subject: 'late 30', due_date: '2026-09-12' }), brow({ subject: 'late 31', due_date: '2026-09-11' }),
    brow({ subject: 'no date' }), brow({ subject: 'bad date', due_date: '2026-02-30' }),
  ];
  const b = morningBriefing(rows, BNOW, null, today);
  assert.deepEqual(b.deadlines.map((d) => d.row.subject), ['late 30', 'late 1', 'today', 'tomorrow', 'in 7']);
  assert.deepEqual(b.deadlines.map((d) => d.label), ['באיחור של 30 ימים', 'באיחור של יום', 'היום', 'מחר', 'בעוד 7 ימים']);
  assert.equal(b.empty, false);
});

test('morningBriefing: at most 5 of each list, and it says how many more', () => {
  const today = '2026-10-12';
  const rows = [];
  for (let i = 0; i < 9; i++) rows.push(brow({ subject: 'd' + i, due_date: `2026-10-${String(12 + (i % 7)).padStart(2, '0')}`, needs_reply: true, received_at: bAgo(20 + i) }));
  const b = morningBriefing(rows, BNOW, null, today);
  assert.equal(b.deadlines.length, 5); assert.equal(b.deadlineMore, 4);
  assert.equal(b.replies.length, 5); assert.equal(b.replyMore, 4);
});

test('morningBriefing: "waiting for my answer" = flagged true, at least 12 hours old, within 14 days, oldest first', () => {
  const rows = [
    brow({ subject: 'fresh', needs_reply: true, received_at: bAgo(11) }),
    brow({ subject: 'half a day', needs_reply: true, received_at: bAgo(12) }),
    brow({ subject: 'two days', needs_reply: true, received_at: bAgo(50) }),
    brow({ subject: 'two weeks', needs_reply: true, received_at: bAgo(24 * 14) }),
    brow({ subject: 'too old', needs_reply: true, received_at: bAgo(24 * 14 + 1) }),
    brow({ subject: 'answered', needs_reply: false, received_at: bAgo(60) }),
    brow({ subject: 'unknown', needs_reply: null, received_at: bAgo(60) }),
    brow({ subject: 'text true', needs_reply: 'true', received_at: bAgo(60) }),
    brow({ subject: 'bad date', needs_reply: true, received_at: 'garbage' }),
  ];
  const b = morningBriefing(rows, BNOW, null, '2026-10-12');
  assert.deepEqual(b.replies.map((r) => r.row.subject), ['two weeks', 'two days', 'half a day']);
  assert.deepEqual(b.replies.map((r) => r.label), ['לפני 14 ימים', 'לפני 2 ימים', 'לפני כמה שעות']);
});

test('morningBriefing: a mail marked as handled leaves both lists but still counts as new since the last visit', () => {
  const rows = [
    brow({ subject: 'open reply', needs_reply: true, received_at: bAgo(50) }),
    brow({ subject: 'done reply', needs_reply: true, received_at: bAgo(50), handled_at: '2026-10-12T08:00:00Z' }),
    brow({ subject: 'open deadline', due_date: '2026-10-13', received_at: bAgo(3) }),
    brow({ subject: 'done deadline', due_date: '2026-10-13', received_at: bAgo(3), handled_at: '2026-10-12T08:00:00Z' }),
  ];
  const b = morningBriefing(rows, BNOW, BNOW.getTime() - 6 * 3600 * 1000, '2026-10-12');
  assert.deepEqual(b.replies.map((r) => r.row.subject), ['open reply']);
  assert.deepEqual(b.deadlines.map((r) => r.row.subject), ['open deadline']);
  assert.equal(b.newSince, 2);
  const allDone = morningBriefing(rows.filter((r) => r.handled_at), BNOW, null, '2026-10-12');
  assert.equal(allDone.empty, true);
});

test('morningBriefing: "new since my last visit" counts mails after that moment; unknown when there was no visit', () => {
  const rows = [brow({ received_at: bAgo(1) }), brow({ received_at: bAgo(5) }), brow({ received_at: bAgo(50) }), brow({ received_at: 'garbage' })];
  assert.equal(morningBriefing(rows, BNOW, BNOW.getTime() - 6 * 3600 * 1000, '2026-10-12').newSince, 2);
  assert.equal(morningBriefing(rows, BNOW, BNOW.getTime(), '2026-10-12').newSince, 0);
  assert.equal(morningBriefing(rows, BNOW, null, '2026-10-12').newSince, null);
  assert.equal(morningBriefing(rows, BNOW, NaN, '2026-10-12').newSince, null);
});

test('morningBriefing: empty and garbage input give an empty briefing, never an exception', () => {
  for (const rows of [null, undefined, [], [null], [{}], 'x', 5, [5, 'x', []]]) {
    const b = morningBriefing(rows, BNOW, null, '2026-10-12');
    assert.equal(b.empty, true); assert.deepEqual(b.deadlines, []); assert.deepEqual(b.replies, []);
  }
});

test('morningBriefing: 2000 random mailboxes - lists respect the rules, sizes, and order; the order of the rows does not matter', () => {
  const next = rng(88); const today = '2026-10-12';
  const pick = (list) => list[Math.floor(next() * list.length)];
  for (let n = 0; n < 2000; n++) {
    const rows = Array.from({ length: Math.floor(next() * 40) }, () => pick([
      () => brow({ due_date: pick([null, '2026-10-05', '2026-10-12', '2026-10-15', '2026-10-25', '2026-02-30', 'x', '2026-09-01']), needs_reply: pick([true, false, null, 'true']), received_at: pick([bAgo(1), bAgo(13), bAgo(100), bAgo(24 * 20), 'bad']) }),
      () => pick([null, 5, {}]),
    ])());
    const b = morningBriefing(rows, BNOW, pick([null, BNOW.getTime() - 3600000, BNOW.getTime() - 86400000 * 3]), today);
    assert.ok(b.deadlines.length <= 5 && b.replies.length <= 5);
    assert.ok(b.deadlineMore >= 0 && b.replyMore >= 0);
    for (const d of b.deadlines) assert.ok(d.diff >= -30 && d.diff <= 7);
    for (let i = 1; i < b.deadlines.length; i++) assert.ok(b.deadlines[i - 1].diff <= b.deadlines[i].diff);
    for (const r of b.replies) assert.strictEqual(r.row.needs_reply, true);
    for (let i = 1; i < b.replies.length; i++) assert.ok(Date.parse(b.replies[i - 1].row.received_at) <= Date.parse(b.replies[i].row.received_at));
    assert.equal(b.empty, b.deadlines.length === 0 && b.replies.length === 0);
    const valid = rows.filter((r) => r && typeof r === 'object');
    const shuffled = valid.map((r) => [next(), r]).sort((x, y) => x[0] - y[0]).map((x) => x[1]);
    const c = morningBriefing(shuffled, BNOW, null, today); const a = morningBriefing(valid, BNOW, null, today);
    assert.equal(a.deadlines.length + a.deadlineMore, c.deadlines.length + c.deadlineMore);
    assert.equal(a.replies.length + a.replyMore, c.replies.length + c.replyMore);
  }
});

// ---- calendar and tasks in the briefing (issue #20). Dates are built in LOCAL time, so the tests do not depend on the machine's zone.
const L = (day, hour, minute = 0) => new Date(2026, 9, day, hour, minute); // October 2026
const AN = L(12, 9, 30);
const ATODAY = '2026-10-12';
const ev = (id, start, end, over = {}) => ({ kind: 'event', external_id: id, title: 'E' + id, all_day: false, starts_at: start && start.toISOString(), ends_at: end && end.toISOString(), day: null, ...over });
const adayEv = (id, day) => ({ kind: 'event', external_id: id, title: 'D' + id, all_day: true, starts_at: null, ends_at: null, day });
const tk = (id, day) => ({ kind: 'task', external_id: id, title: 'T' + id, all_day: false, starts_at: null, ends_at: null, day });

test('agendaBriefing: today and tomorrow, sorted by time, all-day first, labelled in Hebrew', () => {
  const rows = [ev('late', L(12, 17), L(12, 18)), adayEv('trip', '2026-10-12'), ev('morning', L(12, 10), L(12, 11)), ev('next', L(13, 8, 5), L(13, 9)), ev('later', L(14, 9), L(14, 10)), adayEv('tomorrow-all', '2026-10-13')];
  const b = agendaBriefing(rows, AN, ATODAY);
  assert.deepEqual(b.events.map((e) => e.row.external_id), ['trip', 'morning', 'late', 'tomorrow-all', 'next'].sort((x, y) => ['trip', 'morning', 'late', 'tomorrow-all', 'next'].indexOf(x) - ['trip', 'morning', 'late', 'tomorrow-all', 'next'].indexOf(y)));
  assert.deepEqual(b.events.map((e) => e.label), ['היום · כל היום', 'היום · 10:00', 'היום · 17:00', 'מחר · כל היום', 'מחר · 08:05']);
});

test('agendaBriefing: an event that already ended is gone, one that is running says "now", one without an end lasts an hour', () => {
  const rows = [ev('over', L(12, 8), L(12, 9)), ev('running', L(12, 9), L(12, 10, 30)), ev('noend-recent', L(12, 9), null), ev('noend-old', L(12, 8), null)];
  const b = agendaBriefing(rows, AN, ATODAY);
  assert.deepEqual(b.events.map((e) => e.row.external_id), ['running', 'noend-recent']);
  assert.equal(b.events[0].label, 'עכשיו · עד 10:30');
});

test('agendaBriefing: tasks from 30 days overdue to 7 days ahead, soonest first; the rest is counted', () => {
  const rows = [tk('far', '2026-10-20'), tk('edge', '2026-10-19'), tk('today', '2026-10-12'), tk('overdue', '2026-10-10'), tk('ancient', '2026-09-11'), tk('edge-old', '2026-09-12')];
  const b = agendaBriefing(rows, AN, ATODAY);
  assert.deepEqual(b.tasks.map((t) => t.row.external_id), ['edge-old', 'overdue', 'today', 'edge']);
  assert.deepEqual(b.tasks.map((t) => t.label), ['באיחור של 30 ימים', 'באיחור של יומיים'.replace('יומיים', '2 ימים'), 'היום', 'בעוד 7 ימים']);
  const many = Array.from({ length: 9 }, (_, i) => tk('t' + i, '2026-10-13'));
  const c = agendaBriefing(many, AN, ATODAY);
  assert.equal(c.tasks.length, 5); assert.equal(c.taskMore, 4);
});

test('agendaBriefing: garbage never throws and gives an empty result', () => {
  for (const rows of [null, undefined, [], [null], [{}], 'x', 5, [5, 'x', []], [{ kind: 'event', all_day: false, starts_at: 'garbage' }], [{ kind: 'event', all_day: true, day: '2026-02-30' }], [{ kind: 'task', day: 'x' }]]) {
    const b = agendaBriefing(rows, AN, ATODAY);
    assert.equal(b.empty, true, JSON.stringify(rows));
  }
  assert.doesNotThrow(() => agendaBriefing([], 'not a date', ATODAY));
});

test('agendaBriefing: a day boundary - 23:30 tonight is today, 00:10 is tomorrow', () => {
  const rows = [ev('tonight', L(12, 23, 30), L(12, 23, 55)), ev('after-midnight', L(13, 0, 10), L(13, 1))];
  const b = agendaBriefing(rows, AN, ATODAY);
  assert.deepEqual(b.events.map((e) => e.label), ['היום · 23:30', 'מחר · 00:10']);
});

// ---- plans and payment (issue #22)
const PNOW = new Date(2026, 9, 13, 9, 0);
const proSub = (over = {}) => ({ status: 'active', current_period_end: new Date(2026, 10, 13).toISOString(), cancel_at_period_end: false, source: 'polar', ...over });
test('planView: while billing is not enforced everybody sees "beta" and no payment buttons', () => {
  for (const sub of [null, undefined, proSub(), { status: 'canceled' }]) {
    const v = planView(false, sub, PNOW);
    assert.deepEqual([v.mode, v.canUpgrade, v.canManage, v.locked], ['beta', false, false, false]);
  }
  for (const odd of [undefined, null, 'true', 1]) assert.equal(planView(odd, null, PNOW).mode, 'beta', String(odd));
});

test('planView: enforced - Free sees the upgrade button and locked features; Pro sees the manage button and the renewal date; cancelled shows the end date', () => {
  const free = planView(true, null, PNOW, BILL);
  assert.deepEqual([free.mode, free.canUpgrade, free.canManage, free.locked], ['free', true, false, true]);
  assert.ok(free.text.includes('סיכום יומי'));
  const pro = planView(true, proSub(), PNOW);
  assert.deepEqual([pro.mode, pro.canUpgrade, pro.canManage, pro.locked], ['pro', false, true, false]);
  assert.ok(pro.text.includes('13.11.2026'), pro.text);
  const cancelled = planView(true, proSub({ cancel_at_period_end: true }), PNOW);
  assert.ok(cancelled.text.includes('בוטל') && cancelled.text.includes('13.11.2026'));
  assert.ok(planView(true, proSub({ status: 'past_due' }), PNOW).text.includes('נכשל'));
  const manual = planView(true, proSub({ source: 'manual', current_period_end: null }), PNOW);
  assert.deepEqual([manual.mode, manual.canManage], ['pro', false]);
  assert.equal(planView(true, { status: 'canceled', current_period_end: proSub().current_period_end }, PNOW).mode, 'free');
  assert.equal(planView(true, proSub({ current_period_end: new Date(2026, 8, 1).toISOString() }), PNOW).mode, 'free', 'a lapsed subscription');
});

test('the page rule for Pro equals the server rule (entitlement.ts), 3000 random rows and times', async () => {
  globalThis.Deno ??= { env: { get: () => undefined } };
  const { isPro } = await import('./../supabase/functions/gmail-sync/entitlement.ts');
  let seed = 9;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const statuses = ['active', 'trialing', 'past_due', 'canceled', 'unpaid', 'incomplete', 'vip', null, 5];
  for (let n = 0; n < 3000; n++) {
    const now = Date.UTC(2026, 9, 13) + Math.floor((rnd() - 0.5) * 120 * 86400_000);
    const end = rnd() < 0.2 ? null : rnd() < 0.1 ? 'garbage' : new Date(Date.UTC(2026, 9, 13) + Math.floor((rnd() - 0.5) * 100 * 86400_000)).toISOString();
    const row = { status: statuses[Math.floor(rnd() * statuses.length)], current_period_end: end };
    assert.equal(isProRow(row, now), isPro(row, now), JSON.stringify(row) + ' ' + now);
  }
});

test('payment messages and addresses: every server reason has Hebrew text; only https addresses are followed', () => {
  for (const code of ['not_configured', 'already_subscribed', 'checkout_failed', 'portal_failed', 'no_subscription']) assert.ok(/[\u0590-\u05FF]/.test(billingErrorMessage(code)), code);
  assert.ok(/[\u0590-\u05FF]/.test(billingErrorMessage('something_new')));
  assert.equal(isPayUrl('https://sandbox.polar.sh/checkout/abc'), true);
  assert.equal(isPayUrl('https://polar.sh/org/portal?customer_session_token=abc'), true);
  assert.equal(isPayUrl('https://checkout.polar.sh/x'), true);
  for (const bad of ['http://x.example', 'javascript:alert(1)', 'data:text/html,x', '//evil.example', 'https://a b.example', '', null, undefined, 5, 'https://' + 'x'.repeat(2100), 'https://evil.example/polar.sh', 'https://polar.sh.evil.example/x', 'https://notpolar.sh/x', 'https://polar.sh@evil.example/x']) assert.equal(isPayUrl(bad), false, String(bad).slice(0, 40));
});

test('scan messages: the Pro-required and undecidable-access reasons have their own Hebrew text', () => {
  const generic = scanErrorMessage('something_unknown');
  for (const code of ['pro_required', 'access_unknown']) { assert.notEqual(scanErrorMessage(code), generic, code); assert.ok(/[\u0590-\u05FF]/.test(scanErrorMessage(code))); }
});

test('agendaBriefing: an event that started yesterday evening and is still running at 00:30 is shown as "now"; one that ended is not', () => {
  const now = L(13, 0, 30);
  const b = agendaBriefing([ev('night', L(12, 22), L(13, 2)), ev('over', L(12, 21), L(13, 0, 10)), ev('days', L(11, 9), L(14, 18))], now, '2026-10-13');
  assert.deepEqual(b.events.map((e) => e.row.external_id).sort(), ['days', 'night']);
  assert.ok(b.events.every((e) => e.label.startsWith('עכשיו')));
});

// ---- issue #24: the plan card shows the real price and follows the environment the SERVER reports ----
const BILL = { environment: 'sandbox', price: { amount: 1900, currency: 'ILS', interval: 'month' } };
test('priceText: a short Hebrew price line from the facts Polar gave, empty for anything odd', () => {
  assert.equal(priceText({ amount: 1900, currency: 'ILS', interval: 'month' }), '19 ₪ לחודש');
  assert.equal(priceText({ amount: 1950, currency: 'ILS', interval: 'month' }), '19.50 ₪ לחודש');
  assert.equal(priceText({ amount: 500, currency: 'USD', interval: 'month' }), '5 $ לחודש');
  assert.equal(priceText({ amount: 19000, currency: 'ILS', interval: 'year' }), '190 ₪ לשנה');
  assert.equal(priceText({ amount: 900, currency: 'CHF', interval: 'week' }), '9 CHF לשבוע');
  for (const odd of [null, undefined, 5, 'x', [], {}, { amount: 0, currency: 'ILS', interval: 'month' }, { amount: -1, currency: 'ILS', interval: 'month' }, { amount: 1.5, currency: 'ILS', interval: 'month' }, { amount: '1900', currency: 'ILS', interval: 'month' }, { amount: 1900, currency: 'shekel', interval: 'month' }, { amount: 1900, currency: 'ILS', interval: 'decade' }, { amount: 1e12, currency: 'ILS', interval: 'month' }]) assert.equal(priceText(odd), '', JSON.stringify(odd));
});

test('planView: Free sees the real price line; the "test payment" note follows the environment the server reports, never a guess', () => {
  const sandbox = planView(true, null, PNOW, BILL);
  assert.deepEqual([sandbox.mode, sandbox.canUpgrade, sandbox.sandbox, sandbox.unavailable], ['free', true, true, false]);
  assert.ok(sandbox.priceLine.includes('19 ₪ לחודש'), sandbox.priceLine);
  const production = planView(true, null, PNOW, { ...BILL, environment: 'production' });
  assert.deepEqual([production.canUpgrade, production.sandbox], [true, false], 'no "no real charge" claim in production');
  assert.ok(production.priceLine.includes('19 ₪ לחודש'));
});

test('planView: when the server could not tell the environment or the price, Free cannot start a payment and is told so; Pro can still manage; beta says nothing', () => {
  for (const unknown of [null, undefined, { environment: 'sandbox', price: null }, { environment: 'live', price: BILL.price }, { price: BILL.price }, 'x', 5]) {
    const v = planView(true, null, PNOW, unknown);
    assert.deepEqual([v.mode, v.canUpgrade, v.unavailable, v.locked, v.sandbox], ['free', false, true, true, false], JSON.stringify(unknown));
    assert.equal(v.priceLine, '');
  }
  const pro = planView(true, proSub(), PNOW, null);
  assert.deepEqual([pro.mode, pro.canManage, pro.sandbox, pro.unavailable], ['pro', true, false, false], 'a paying member can always reach the portal, and nothing false is claimed about the environment');
  const beta = planView(false, null, PNOW, null);
  assert.deepEqual([beta.mode, beta.canUpgrade, beta.unavailable, beta.priceLine], ['beta', false, false, '']);
});

// ---- issue #26: delete my account ----
test('deleteAccountConfirmText: the member is told what is lost, that it cannot be undone, and (when paying) that the subscription ends', () => {
  const plain = deleteAccountConfirmText(false);
  assert.ok(plain.includes('מחק') && plain.includes('אי אפשר לשחזר'), plain);
  const paying = deleteAccountConfirmText(true);
  assert.ok(paying.includes('מנוי') && paying.includes('אי אפשר לשחזר'), paying);
  assert.notEqual(plain, paying);
  for (const odd of [undefined, null, 'x', 5]) assert.equal(typeof deleteAccountConfirmText(odd), 'string');
});

test('deleteAccountMessage: every server answer has a Hebrew text; a failed Polar step says the account was NOT deleted', () => {
  const polar = deleteAccountMessage('customer_delete_failed');
  assert.ok(polar.includes('לא נמחק') && polar.includes('מנוי'), polar);
  assert.ok(deleteAccountMessage('delete_failed').includes('נסה שוב'));
  assert.ok(deleteAccountMessage('read_failed').includes('נסה שוב'));
  assert.ok(deleteAccountMessage('not_configured').includes('לא זמינה'));
  for (const code of ['', undefined, null, 'unexpected', 'Invalid JWT', 5, {}]) {
    const text = deleteAccountMessage(code);
    assert.ok(/[א-ת]/.test(text) && !/[A-Za-z]/.test(text), String(code) + ' -> ' + text);
  }
});
// Google sign-in (issue 7): when the sign-in comes back with an error the page must say so, not silently show the login again.
test('oauthReturnMessage explains a failed Google sign-in (query form)', () => {
  const text = oauthReturnMessage('?error=server_error&error_code=unexpected_failure&error_description=Unable+to+exchange+external+code', '');
  assert.match(text, /Google/);
  assert.match(text, /אימייל וסיסמה/);
  assert.doesNotMatch(text.replace(/Google/g, ''), /[A-Za-z]/);
});

test('oauthReturnMessage reads the hash form too, and tells a cancel from a failure', () => {
  const failed = oauthReturnMessage('', '#error=server_error&error_description=bad');
  const cancelled = oauthReturnMessage('?error=access_denied&error_description=User+cancelled', '');
  assert.notEqual(failed, '');
  assert.notEqual(cancelled, '');
  assert.notEqual(failed, cancelled);
  assert.match(cancelled, /בוטל/);
});

test('oauthReturnMessage stays silent when there is no sign-in error', () => {
  assert.equal(oauthReturnMessage('', ''), '');
  assert.equal(oauthReturnMessage('?gmail=connected', ''), '');
  assert.equal(oauthReturnMessage('?billing=success', '#access_token=abc'), '');
  assert.equal(oauthReturnMessage(undefined, undefined), '');
  assert.equal(oauthReturnMessage(null, null), '');
});

test('oauthReturnMessage never shows the raw server text', () => {
  const text = oauthReturnMessage('?error=server_error&error_description=SECRET+internal+detail', '');
  assert.doesNotMatch(text, /SECRET|internal|detail/);
});
