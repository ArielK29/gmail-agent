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

  return { authMessage, validateCredentials, problemMessage, emptyStateText, dailySummary, summaryHeadline, urgentHeadline };
});

