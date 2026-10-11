// Pure decisions of the Gmail agent. No Deno, no network: this file is tested with `node --test`.
export const CATEGORIES = ['important', 'personal', 'work', 'finance', 'newsletter', 'promotion', 'notification', 'other'];
export const URGENCIES = ['high', 'normal', 'low'];

export interface Classified {
  category: string;
  summary: string;
  urgency: string;
  action: string;
}

// The model's words come from untrusted email text: links are removed and the length is cut.
export function cleanText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return stripControls(value).replace(/(https?:\/\/|www\.)\S+/gi, '').replace(/\s+/g, ' ').trim().slice(0, max).trim(); // cut first, trim again: the cut may end on a space
}

// Text that comes from other people must not be able to rearrange what the member reads: bidi overrides / embeddings /
// isolates (they can make "invoice<RLO>fdp.exe" look like a PDF), zero-width characters, the byte-order mark and control
// characters are removed. Hebrew and English letters, digits, emoji and the harmless direction marks (LRM / RLM) stay.
export function stripControls(value: string): string {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200D\u2060\u202A-\u202E\u2066-\u2069\uFEFF]/g, '');
}

// Old Hebrew emails often use windows-1255 / iso-8859-8: the part's own charset is honored, UTF-8 if unknown.
export function decodeBytes(bytes: Uint8Array, contentType: string): string {
  const charset = /charset="?([^";\s]+)/i.exec(contentType)?.[1] ?? 'utf-8';
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

// Reads the model's JSON answer. Anything that is not valid becomes "missing", never an exception:
// the caller gives missing emails a fallback row so a bad answer cannot block a run.
export function parseModelAnswer(text: string, knownIds: Set<string>): Map<string, Classified> {
  const result = new Map<string, Classified>();
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  let items: unknown = [];
  try {
    if (start >= 0 && end > start) items = JSON.parse(text.slice(start, end + 1));
  } catch {
    return result;
  }
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item.id !== 'string' || !knownIds.has(item.id) || result.has(item.id)) continue;
    const summary = cleanText(item.summary, 300);
    if (!summary) continue;
    const urgency = typeof item.urgency === 'string' && URGENCIES.includes(item.urgency.toLowerCase()) ? item.urgency.toLowerCase() : 'normal';
    result.set(item.id, {
      category: CATEGORIES.includes(item.category) ? item.category : 'other',
      summary,
      urgency,
      action: cleanText(item.action, 200),
    });
  }
  return result;
}

// Rate limits (429) and server errors (5xx) of the model are temporary: retry with growing pauses.
export const isRetryable = (status: number): boolean => status === 429 || (status >= 500 && status <= 599);
export const backoffMs = (attempt: number): number => Math.min(8000, 500 * 2 ** attempt);

// Daily budget per member: how many emails may still be summarized today (the day is the UTC date).
export const remainingBudget = (used: number, cap: number): number => Math.max(0, cap - used);
export const utcDay = (date: Date): string => date.toISOString().slice(0, 10);

// Calls the model and retries temporary failures (429 / 5xx) up to `maxRetries` times with growing pauses.
// `doFetch` and `sleep` are passed in so the loop can be tested with a fake model and a fake clock.
export async function callWithRetry<T extends { status: number }>(
  doFetch: () => Promise<T>,
  sleep: (ms: number) => Promise<void>,
  maxRetries = 3
): Promise<T> {
  let response = await doFetch();
  for (let attempt = 0; attempt < maxRetries && isRetryable(response.status); attempt++) {
    await sleep(backoffMs(attempt));
    response = await doFetch();
  }
  return response;
}

// Which emails to summarize now. `behind` = some are left waiting (per-run limit or the daily budget), so the Gmail
// history position must NOT move forward.
export function planBatch(pending: string[], maxPerRun: number, allowed: number): { batch: string[]; behind: boolean } {
  const batch = pending.slice(0, Math.max(0, Math.min(maxPerRun, allowed)));
  return { batch, behind: pending.length > batch.length };
}

// Only Google's 400 "invalid_grant" means the access is really gone (revoked, expired after 7 days in Testing mode,
// password change). Everything else (network, 5xx, 429, a wrong client) is temporary or our own problem and must never
// touch the member's connection.
export type TokenOutcome = { kind: 'ok'; token: string } | { kind: 'revoked' } | { kind: 'failed'; reason: string };
export function classifyTokenResponse(status: number, body: { access_token?: string; error?: string }): TokenOutcome {
  if (status >= 200 && status < 300 && body.access_token) return { kind: 'ok', token: body.access_token };
  if (status === 400 && body.error === 'invalid_grant') return { kind: 'revoked' };
  return { kind: 'failed', reason: 'Google token: ' + (body.error ?? status) };
}

// "Check now" cooldown. An ATTEMPT counts as much as a success: when the model keeps failing, last_checked_at never moves,
// and without this the button could be pressed again and again (each press = up to 4 model calls).
export function isThrottled(lastCheckedAt: string | null, lastAttemptAt: string | null, now: number, cooldownMs: number): boolean {
  const times = [lastCheckedAt, lastAttemptAt].map((value) => (value ? new Date(value).getTime() : NaN)).filter((time) => Number.isFinite(time));
  if (times.length === 0) return false;
  return now - Math.max(...times) < cooldownMs;
}

// Gmail history ids are big numbers in text form: compare them as numbers. A value that is not a number never wins.
export function maxHistoryId(a: string | null | undefined, b: string | null | undefined): string | null {
  const valid = (value: string | null | undefined): value is string => typeof value === 'string' && /^\d+$/.test(value);
  if (valid(a) && valid(b)) return BigInt(a) >= BigInt(b) ? a : b;
  if (valid(a)) return a;
  if (valid(b)) return b;
  return null;
}
// ======================= On-demand scan and cross-check (issue #15): pure logic =======================
export const MAX_SCAN_MAILS = 200; // mails read by one scan
export const SCAN_SLICE = 30; // mails per call of the "step" action
const MAX_SCAN_ITEMS = 100;
const MAX_ITEM_CHARS = 120;
const MAX_QUERY_CHARS = 200;
const MAX_PERIOD_DAYS = 365; // end minus start, so at most 366 calendar days (a leap year fits)
const MAX_ITEMS_IN_QUERY = 20;

// "2026-02-30" is not a day: the text must survive a round trip through a real date.
export function isRealDay(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00Z');
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export function addDays(day: string, days: number): string {
  const date = new Date(day + 'T00:00:00Z');
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
const dayNumber = (day: string): number => Date.parse(day + 'T00:00:00Z') / 86400000;

// The member's search text goes into a Gmail search. It cannot hide anything (no control or bidi characters), cannot open
// a group or a sub-query (no parentheses or braces) and cannot leave a quote open.
export function sanitizeQuery(value: unknown): string {
  if (typeof value !== 'string') return '';
  const balanced = (text: string) => ((text.match(/"/g) ?? []).length % 2 === 0 ? text : text.replace(/"/g, ''));
  let text = balanced(stripControls(value).replace(/[(){}]/g, '').replace(/\s+/g, ' ').trim());
  text = balanced(text.slice(0, MAX_QUERY_CHARS)).trim();
  return text;
}

// The list of things to look for: cleaned, no empty entries, no duplicates (any letter case), at most 100.
export function parseItems(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const items: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const item = stripControls(entry).replace(/\s+/g, ' ').trim().slice(0, MAX_ITEM_CHARS).trim();
    if (!item || seen.has(item.toLowerCase())) continue;
    seen.add(item.toLowerCase());
    items.push(item);
    if (items.length === MAX_SCAN_ITEMS) break;
  }
  return items;
}

export interface ScanRequest { periodStart: string; periodEnd: string; queryText: string; items: string[] }
export type ScanValidation = { ok: true; value: ScanRequest } | { ok: false; error: string };

export function validateScanRequest(body: any, today: string): ScanValidation {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'bad_request' };
  if (body.consent !== true) return { ok: false, error: 'consent_required' }; // explicit consent, never assumed
  const { periodStart, periodEnd } = body;
  if (!isRealDay(periodStart) || !isRealDay(periodEnd) || periodStart < '2000-01-01' || periodStart > periodEnd || periodEnd > today) return { ok: false, error: 'bad_dates' };
  if (dayNumber(periodEnd) - dayNumber(periodStart) > MAX_PERIOD_DAYS) return { ok: false, error: 'period_too_long' };
  const queryText = sanitizeQuery(body.query);
  const items = parseItems(body.items);
  if (!queryText && items.length === 0) return { ok: false, error: 'nothing_to_search' }; // never read a whole period blindly
  return { ok: true, value: { periodStart, periodEnd, queryText, items } };
}

// Gmail's "before:" is exclusive, so the day AFTER the end is used. Without search text the items become the search.
export function buildGmailQuery(periodStart: string, periodEnd: string, queryText: string, items: string[]): string {
  const range = `after:${periodStart.replace(/-/g, '/')} before:${addDays(periodEnd, 1).replace(/-/g, '/')}`;
  if (queryText) return `${range} ${queryText}`;
  if (items.length === 0) return range;
  return `${range} {${items.slice(0, MAX_ITEMS_IN_QUERY).map((item) => `"${item.replace(/"/g, '')}"`).join(' ')}}`;
}

export interface ScanMatch { matches: number[]; summary: string }

// The model's answer for one chunk of mails: which of the member's items each mail mentions, and one sentence about it.
export function parseMatchAnswer(text: string, knownIds: Set<string>, itemCount: number): Map<string, ScanMatch> {
  const result = new Map<string, ScanMatch>();
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  let items: unknown = [];
  try {
    if (start >= 0 && end > start) items = JSON.parse(text.slice(start, end + 1));
  } catch {
    return result;
  }
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item.id !== 'string' || !knownIds.has(item.id) || result.has(item.id)) continue;
    const raw: unknown[] = Array.isArray(item.matches) ? item.matches : [];
    const matches = [...new Set(raw.filter((m): m is number => Number.isInteger(m) && (m as number) >= 0 && (m as number) < itemCount))].sort((a, b) => a - b);
    result.set(item.id, { matches, summary: cleanText(item.summary, 300) });
  }
  return result;
}

// Exact text matches found without the model (cheap and certain). Items shorter than 3 characters are too vague for this.
export function localMatches(text: string, items: string[]): number[] {
  const normal = (value: string) => value.toLowerCase().replace(/\s+/g, ' ');
  const haystack = normal(text);
  const found: number[] = [];
  items.forEach((item, index) => {
    const needle = normal(item).trim();
    if (needle.length >= 3 && haystack.includes(needle)) found.push(index);
  });
  return found;
}