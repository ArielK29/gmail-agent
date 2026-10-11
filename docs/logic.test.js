const test = require('node:test');
const assert = require('node:assert/strict');
const { authMessage, validateCredentials, problemMessage, emptyStateText } = require('./logic.js');

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
