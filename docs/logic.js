// Pure UI decisions of the Gmail agent page. Loaded by index.html (window.AgentLogic) and tested with `node --test`.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AgentLogic = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const GENERIC = 'משהו השתבש. נסה שוב בעוד רגע.';

  // First match wins. The text is the lower-cased code + message of the Supabase auth error.
  const AUTH_RULES = [
    [/invalid login credentials/, 'האימייל או הסיסמה שגויים.'],
    [/missing email|anonymous sign-ins are disabled/, 'יש למלא אימייל וסיסמה.'],
    [/email not confirmed/, 'צריך לאשר את כתובת האימייל. בדוק את תיבת הדואר.'],
    [/already registered|already been registered/, 'כבר קיים חשבון עם האימייל הזה. נסה להתחבר.'],
    [/password should be at least/, 'הסיסמה קצרה מדי (לפחות 6 תווים).'],
    [/unable to validate email|invalid email/, 'כתובת האימייל לא תקינה.'],
    [/rate limit|too many requests/, 'נשלחו יותר מדי ניסיונות. נסה שוב בעוד כמה דקות.'],
    [/failed to fetch|networkerror|load failed/, 'אין חיבור לאינטרנט. נסה שוב.'],
  ];

  function authMessage(error) {
    const text = ((error && error.code) || '') + ' ' + ((error && error.message) || '');
    const lower = text.toLowerCase();
    for (const [pattern, message] of AUTH_RULES) if (pattern.test(lower)) return message;
    return GENERIC;
  }

  function validateCredentials(email, password) {
    const e = String(email || '').trim();
    if (!e) return 'יש להכניס אימייל.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return 'כתובת האימייל לא תקינה.';
    if (!password) return 'יש להכניס סיסמה.';
    return null;
  }

  // The sync function reports short English reasons (useful in logs); the page shows Hebrew.
  function problemMessage(text) {
    const t = String(text || '');
    if (t.startsWith('access was revoked')) return 'החיבור ל-Gmail פג. חבר את Gmail מחדש.';
    if (t.startsWith('Gemini:')) return 'שירות הסיכום לא זמין כרגע או הגיע למכסה. ננסה שוב אוטומטית.';
    if (t.startsWith('Gmail:')) return 'Gmail לא ענה כרגע. ננסה שוב אוטומטית.';
    if (t.startsWith('Google token')) return 'לא הצלחנו להתחבר ל-Google כרגע. ננסה שוב אוטומטית.';
    if (t.startsWith('could not save usage')) return 'הסיכומים נשמרו, אבל לא הצלחנו לעדכן את מונה השימוש. ננסה שוב אוטומטית.';
    if (t.startsWith('could not save')) return 'לא הצלחנו לשמור את הסיכומים. ננסה שוב אוטומטית.';
    return GENERIC;
  }

  function emptyStateText(state) {
    if (!state.connected) return 'חבר את Gmail כדי להתחיל לקבל סיכומים.';
    if (state.expired) return 'החיבור פג. חבר שוב כדי להמשיך.';
    return 'עוד אין מיילים. לחץ "בדוק מיילים חדשים עכשיו".';
  }

  // ---- Daily summary: what happened in the last 24 hours, computed from the saved digest (no model call). ----
  const DAY_MS = 24 * 60 * 60 * 1000;
  const MAX_URGENT_SHOWN = 5;

  function dailySummary(rows, now, loadedLimit) {
    const list = Array.isArray(rows) ? rows : [];
    const nowMs = (now instanceof Date ? now : new Date()).getTime();
    const received = (row) => (row && row.received_at ? new Date(row.received_at).getTime() : NaN);
    const inWindow = list
      .filter((row) => Number.isFinite(received(row)) && nowMs - received(row) < DAY_MS)
      .sort((a, b) => received(b) - received(a));

    const urgentAll = inWindow.filter((row) => row.urgency === 'high');
    const counts = new Map();
    for (const row of inWindow) counts.set(row.category || 'other', (counts.get(row.category || 'other') || 0) + 1);
    const byCategory = [...counts.entries()]
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));

    // The page loads only the newest `loadedLimit` rows. If that page is full and still has no row older than a day,
    // there may be more mails inside the window than we can see.
    const limit = Number.isFinite(loadedLimit) ? loadedLimit : Infinity;
    const reachesOlder = list.some((row) => Number.isFinite(received(row)) && nowMs - received(row) >= DAY_MS);
    const incomplete = list.length >= limit && !reachesOlder;

    return {
      total: inWindow.length,
      urgentCount: urgentAll.length,
      urgent: urgentAll.slice(0, MAX_URGENT_SHOWN),
      urgentMore: Math.max(0, urgentAll.length - MAX_URGENT_SHOWN),
      actionCount: inWindow.filter((row) => typeof row.suggested_action === 'string' && row.suggested_action.trim()).length,
      byCategory,
      incomplete,
    };
  }

  function summaryHeadline(total) {
    if (total <= 0) return 'אין מיילים חדשים ב-24 השעות האחרונות.';
    if (total === 1) return 'מייל אחד חדש ב-24 השעות האחרונות.';
    return `${total} מיילים חדשים ב-24 השעות האחרונות.`;
  }

  function urgentHeadline(count) {
    if (count <= 0) return 'אין מיילים דחופים.';
    if (count === 1) return 'מייל דחוף אחד:';
    return `${count} מיילים דחופים:`;
  }

  // Same rule as the server (stripControls in logic.ts): text written by other people cannot reorder what is shown.
  function safeText(value) {
    if (typeof value !== 'string') return '';
    return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200D\u2060\u202A-\u202E\u2066-\u2069\uFEFF]/g, '');
  }

  // ---- On-demand scan and cross-check (issue #15) ----
  const SCAN_ERRORS = {
    consent_required: 'כדי לסרוק צריך לסמן את ההסכמה.',
    bad_dates: 'התאריכים לא תקינים. ההתחלה חייבת להיות לפני הסוף, והסוף לא יכול להיות בעתיד.',
    period_too_long: 'אפשר לסרוק עד שנה בכל פעם.',
    nothing_to_search: 'כתוב מה לחפש: טקסט לחיפוש, או רשימת דברים (אחד בכל שורה).',
    not_connected: 'Gmail עדיין לא מחובר. חבר אותו ואז נסה שוב.',
    needs_reconnect: 'החיבור ל-Gmail פג. חבר מחדש ואז נסה שוב.',
    scan_in_progress: 'כבר רצה סריקה. חכה שתסתיים, או בטל אותה.',
    daily_scan_limit: 'אפשר להריץ עד 3 סריקות ביום. נסה שוב מחר.',
    invalid_query: 'Gmail לא הבין את החיפוש. נסה לנסח אותו אחרת.',
    daily_budget: 'הגעת למכסה היומית של המיילים. הסריקה תמשיך מחר.',
    could_not_start: 'לא הצלחנו להתחיל את הסריקה. נסה שוב.',
    bad_request: 'הבקשה לא תקינה. רענן את הדף ונסה שוב.',
    not_found: 'הסריקה לא נמצאה.',
  };
  function scanErrorMessage(code) {
    return Object.prototype.hasOwnProperty.call(SCAN_ERRORS, code) ? SCAN_ERRORS[code] : GENERIC;
  }

  // One item per line; the same cleaning as the server (control and bidi characters out, no duplicates, 100 items, 120 characters).
  function parseItemsText(text) {
    if (typeof text !== 'string') return [];
    const seen = new Set();
    const items = [];
    for (const line of text.split(/\r?\n/)) {
      const item = safeText(line).replace(/\s+/g, ' ').trim().slice(0, 120).trim();
      if (!item || seen.has(item.toLowerCase())) continue;
      seen.add(item.toLowerCase());
      items.push(item);
      if (items.length === 100) break;
    }
    return items;
  }

  const isRealDay = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
  const dayNumber = (day) => Date.parse(day + 'T00:00:00Z') / 86400000;

  // The same rules as the server, so the member hears about a mistake before anything is sent. Returns a Hebrew sentence or null.
  function validateScanForm(form, today) {
    if (!form || typeof form !== 'object') return SCAN_ERRORS.bad_request;
    if (form.consent !== true) return SCAN_ERRORS.consent_required;
    if (!isRealDay(form.from) || !isRealDay(form.to) || form.from < '2000-01-01' || form.from > form.to || form.to > today) return SCAN_ERRORS.bad_dates;
    if (dayNumber(form.to) - dayNumber(form.from) > 365) return SCAN_ERRORS.period_too_long;
    const hasQuery = typeof form.query === 'string' && safeText(form.query).replace(/[(){}\s]/g, '') !== '';
    if (!hasQuery && parseItemsText(form.itemsText).length === 0) return SCAN_ERRORS.nothing_to_search;
    return null;
  }

  function scanProgressText(scan) {
    if (!scan || typeof scan !== 'object') return 'אין סריקה.';
    const done = Number(scan.processed) || 0;
    const total = Number(scan.total) || 0;
    switch (scan.status) {
      case 'queued': return 'הסריקה מתחילה...';
      case 'running': return total > 0 ? `נסרקו ${done} מתוך ${total} מיילים...` : 'מחפש מיילים...';
      case 'paused': return scan.error === 'daily_budget' ? `${SCAN_ERRORS.daily_budget} (נסרקו ${done} מתוך ${total}).` : `הסריקה הושהתה (נסרקו ${done} מתוך ${total}).`;
      case 'done': return total === 0 ? 'הסריקה הסתיימה: לא נמצאו מיילים שמתאימים.' : `הסריקה הסתיימה: נסרקו ${total} מיילים.`;
      case 'cancelled': return 'הסריקה בוטלה.';
      case 'failed': return scan.error === 'needs_reconnect' ? 'הסריקה נעצרה: החיבור ל-Gmail פג. חבר מחדש.' : scan.error === 'invalid_query' ? SCAN_ERRORS.invalid_query : 'הסריקה נכשלה. נסה שוב.';
      default: return 'אין סריקה.';
    }
  }

  // For every item of the member's list: the scanned mails that matched it (matches holds positions in the list).
  function rollupItems(items, hits) {
    if (!Array.isArray(items)) return [];
    const rows = Array.isArray(hits) ? hits : [];
    return items.map((item, index) => ({
      item,
      hits: rows.filter((hit) => hit && Array.isArray(hit.matches) && hit.matches.some((m) => m === index)),
    }));
  }

  const pad = (n) => String(n).padStart(2, '0');
  // The previous calendar month as a pair of local days (the default period of the scan form).
  function lastFullMonth(now) {
    const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const last = new Date(now.getFullYear(), now.getMonth(), 0);
    const fmt = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    return { from: fmt(first), to: fmt(last) };
  }
  // ---- Morning briefing (issue #16) ----
  const BRIEF_MAX = 5;
  const localDay = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

  function greeting(now) {
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) return 'שלום';
    const hour = now.getHours();
    if (hour >= 5 && hour < 12) return 'בוקר טוב';
    if (hour >= 12 && hour < 17) return 'צהריים טובים';
    if (hour >= 17 && hour < 21) return 'ערב טוב';
    return 'לילה טוב';
  }

  function deadlineLabel(diff) {
    if (diff === 0) return 'היום';
    if (diff === 1) return 'מחר';
    if (diff > 1) return `בעוד ${diff} ימים`;
    if (diff === -1) return 'באיחור של יום';
    return `באיחור של ${-diff} ימים`;
  }

  function replyAgeLabel(hours) {
    const days = Math.floor(hours / 24);
    return days < 1 ? 'לפני כמה שעות' : days === 1 ? 'לפני יום' : `לפני ${days} ימים`;
  }

  // What to look at first, computed from the saved mails: deadlines (30 days overdue to 7 days ahead), mails that probably
  // wait for my answer (flagged by the server, at least 12 hours old, within 14 days) and what is new since my last visit.
  function morningBriefing(rows, now, lastVisitMs, today) {
    const list = Array.isArray(rows) ? rows.filter((row) => row && typeof row === 'object' && !Array.isArray(row)) : [];
    const nowMs = now instanceof Date ? now.getTime() : Date.now();
    const received = (row) => (row.received_at ? new Date(row.received_at).getTime() : NaN);

    const open = list.filter((row) => !row.handled_at); // a mail the member marked as handled leaves the briefing

    const deadlines = open
      .filter((row) => isRealDay(row.due_date))
      .map((row) => ({ row, diff: dayNumber(row.due_date) - dayNumber(today) }))
      .filter((entry) => entry.diff >= -30 && entry.diff <= 7)
      .sort((a, b) => a.diff - b.diff || received(b.row) - received(a.row))
      .map((entry) => ({ ...entry, label: deadlineLabel(entry.diff) }));

    const replies = open
      .filter((row) => row.needs_reply === true && Number.isFinite(received(row)) && nowMs - received(row) >= 12 * 3600 * 1000 && nowMs - received(row) <= 14 * 24 * 3600 * 1000)
      .sort((a, b) => received(a) - received(b))
      .map((row) => ({ row, label: replyAgeLabel((nowMs - received(row)) / 3600000) }));

    const newSince = Number.isFinite(lastVisitMs) ? list.filter((row) => Number.isFinite(received(row)) && received(row) > lastVisitMs).length : null;
    return {
      deadlines: deadlines.slice(0, BRIEF_MAX), deadlineMore: Math.max(0, deadlines.length - BRIEF_MAX),
      replies: replies.slice(0, BRIEF_MAX), replyMore: Math.max(0, replies.length - BRIEF_MAX),
      newSince, empty: deadlines.length === 0 && replies.length === 0,
    };
  }
  // ---- Calendar and tasks in the briefing (issue #20) ----
  const clock = (date) => `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  // Today's and tomorrow's events (the ones that have not ended yet) and the tasks due from 30 days ago to 7 days ahead.
  // Rows come from the server (gmail_agenda); anything malformed is ignored.
  function agendaBriefing(rows, now, today) {
    const list = Array.isArray(rows) ? rows.filter((row) => row && typeof row === 'object' && !Array.isArray(row)) : [];
    const nowDate = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
    const nowMs = nowDate.getTime();
    const tomorrow = localDay(new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate() + 1));
    const dayWord = (day) => (day === today ? 'היום' : 'מחר');

    const events = [];
    for (const row of list) {
      if (row.kind !== 'event') continue;
      if (row.all_day === true) {
        if (isRealDay(row.day) && (row.day === today || row.day === tomorrow)) events.push({ row, sort: dayNumber(row.day) * 1440 - 1, label: `${dayWord(row.day)} · כל היום` });
        continue;
      }
      const start = row.starts_at ? new Date(row.starts_at) : null;
      if (!start || Number.isNaN(start.getTime())) continue;
      const end = row.ends_at ? new Date(row.ends_at).getTime() : NaN;
      if (Number.isFinite(end) ? end <= nowMs : start.getTime() < nowMs - 3600000) continue; // already over
      const day = localDay(start);
      if (day !== today && day !== tomorrow) continue;
      const running = start.getTime() <= nowMs;
      events.push({ row, sort: start.getTime() / 60000, label: running ? `עכשיו · עד ${Number.isFinite(end) ? clock(new Date(end)) : '?'}` : `${dayWord(day)} · ${clock(start)}` });
    }
    events.sort((a, b) => a.sort - b.sort);

    const tasks = list
      .filter((row) => row.kind === 'task' && isRealDay(row.day))
      .map((row) => ({ row, diff: dayNumber(row.day) - dayNumber(today) }))
      .filter((entry) => entry.diff >= -30 && entry.diff <= 7)
      .sort((a, b) => a.diff - b.diff)
      .map((entry) => ({ ...entry, label: deadlineLabel(entry.diff) }));
    return { events: events.slice(0, BRIEF_MAX), eventMore: Math.max(0, events.length - BRIEF_MAX), tasks: tasks.slice(0, BRIEF_MAX), taskMore: Math.max(0, tasks.length - BRIEF_MAX), empty: events.length === 0 && tasks.length === 0 };
  }  // ---- Plans and payment (issue #22). The server decides; the page only explains and hides what would be refused. ----
  const GRACE_MS = 3 * 24 * 3600 * 1000;
  // The same rule as supabase/functions/*/entitlement.ts (a test compares them).
  function isProRow(row, nowMs) {
    if (!row || typeof row !== 'object') return false;
    const end = typeof row.current_period_end === 'string' ? Date.parse(row.current_period_end) : NaN;
    const inside = !Number.isFinite(end) || nowMs <= end + GRACE_MS;
    if (row.status === 'active' || row.status === 'trialing') return inside;
    if (row.status === 'past_due') return Number.isFinite(end) && nowMs <= end + GRACE_MS;
    return false;
  }
  const dateText = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`; };

  // What the plan card shows. `enforced` is the server switch (false = the testers phase, everything free); `sub` is the member's row.
  function planView(enforced, sub, now, environment) {
    const nowMs = now instanceof Date ? now.getTime() : Date.now();
    const sandbox = environment !== 'production'; // anything but a real production setting is a test payment
    if (enforced !== true) return { mode: 'beta', sandbox, title: 'גרסת ניסוי', text: 'בשלב הטסטרים כל התכונות פתוחות וחינמיות.', canUpgrade: false, canManage: false, locked: false };
    if (isProRow(sub, nowMs)) {
      const end = sub && sub.current_period_end ? dateText(sub.current_period_end) : '';
      const manual = Boolean(sub && sub.source === 'manual');
      const text = manual ? 'הגישה ל-Pro ניתנה לך ידנית.'
        : sub.cancel_at_period_end ? `המנוי בוטל וימשיך לעבוד עד ${end || 'סוף התקופה'}.`
        : sub.status === 'past_due' ? 'התשלום האחרון נכשל. עדכן את אמצעי התשלום בניהול המנוי.'
        : end ? `המנוי מתחדש ב-${end}.` : 'המנוי פעיל.';
      return { mode: 'pro', sandbox, title: manual ? 'Pro (הענקה ידנית)' : 'מנוי Pro פעיל', text, canUpgrade: false, canManage: !manual, locked: false };
    }
    return { mode: 'free', sandbox, title: 'המסלול החינמי', text: 'חינם: סיכום יומי ובריפינג. סריקה והצלבה, יומן ומשימות ומייל בוקר זמינים במנוי Pro.', canUpgrade: true, canManage: false, locked: true };
  }

  // The server's reason for a refused payment request, in Hebrew.
  function billingErrorMessage(code) {
    const texts = {
      not_configured: 'התשלום עדיין לא זמין. נסה שוב מאוחר יותר.',
      already_subscribed: 'יש לך כבר מנוי פעיל.',
      checkout_failed: 'לא הצלחנו לפתוח את דף התשלום. נסה שוב.',
      portal_failed: 'לא הצלחנו לפתוח את ניהול המנוי. נסה שוב.',
      no_subscription: 'אין לך מנוי לנהל.',
    };
    return texts[code] || 'משהו השתבש. נסה שוב.';
  }
  const isPayUrl = (value) => typeof value === 'string' && /^https:\/\/[^\s]+$/.test(value) && value.length <= 2083;  return { authMessage, validateCredentials, problemMessage, emptyStateText, dailySummary, summaryHeadline, urgentHeadline, safeText, scanErrorMessage, parseItemsText, validateScanForm, scanProgressText, rollupItems, lastFullMonth, morningBriefing, agendaBriefing, deadlineLabel, greeting, localDay, planView, isProRow, billingErrorMessage, isPayUrl };
});

