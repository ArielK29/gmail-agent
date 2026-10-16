// Pure decisions of the OAuth callback (no Deno, no network): tested with `node --test`.
export const GMAIL_READONLY = 'https://www.googleapis.com/auth/gmail.readonly';

export type ConsentOutcome = 'ok' | 'error' | 'missing_scope';

// Google lets the member untick single permissions on the consent screen. A connection without the Gmail permission can
// never read anything, so it must not be stored.
export function consentOutcome(responseOk: boolean, tokens: any): ConsentOutcome {
  if (!responseOk || !tokens || typeof tokens.refresh_token !== 'string' || tokens.refresh_token === '') return 'error';
  const granted = String(tokens.scope ?? '').split(/\s+/).filter(Boolean);
  return granted.includes(GMAIL_READONLY) ? 'ok' : 'missing_scope';
}

// Where the member goes back to. The result is one of a fixed list, so nothing from the request can end up in the address.
const RESULTS = new Set(['connected', 'cancelled', 'expired', 'error', 'missing_scope']);
export function backUrl(appUrl: string, result: string): string {
  const safe = RESULTS.has(result) ? result : 'error';
  return `${appUrl}${appUrl.includes('?') ? '&' : '?'}gmail=${safe}`;
}
export const GOOGLE_CALENDAR = 'https://www.googleapis.com/auth/calendar.readonly';
export const GOOGLE_TASKS = 'https://www.googleapis.com/auth/tasks.readonly';
// The optional permissions the member kept ticked on Google's screen. Only these exact scopes count.
export function optionalScopes(tokens: any): { calendar: boolean; tasks: boolean } {
  const granted = String(tokens?.scope ?? '').split(/\s+/).filter(Boolean);
  return { calendar: granted.includes(GOOGLE_CALENDAR), tasks: granted.includes(GOOGLE_TASKS) };
}
// Issue 32: the app can come back to a deep link instead of the web page. The address comes from the server's own setting
// (APP_DEEP_LINK), never from the request, and only a custom app scheme counts (never http, javascript, data, file...).
const APP_LINK = /^[a-z][a-z0-9+.-]*:\/\/\S*$/i;
const NOT_AN_APP = /^(https?|javascript|data|file|ftp|blob|about|vbscript):/i;
export function backUrlFor(target: unknown, webUrl: string, appLink: string | undefined, result: string): string {
  const useApp = target === 'app' && typeof appLink === 'string' && APP_LINK.test(appLink) && !NOT_AN_APP.test(appLink);
  return backUrl(useApp ? (appLink as string) : webUrl, result);
}