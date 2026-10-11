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
    if (t.startsWith('could not save')) return 'לא הצלחנו לשמור את הסיכומים. ננסה שוב אוטומטית.';
    return GENERIC;
  }

  function emptyStateText(state) {
    if (!state.connected) return 'חבר את Gmail כדי להתחיל לקבל סיכומים.';
    if (state.expired) return 'החיבור פג. חבר שוב כדי להמשיך.';
    return 'עוד אין מיילים. לחץ "בדוק מיילים חדשים עכשיו".';
  }

  return { authMessage, validateCredentials, problemMessage, emptyStateText };
});
