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
  return value.replace(/(https?:\/\/|www\.)\S+/gi, '').replace(/\s+/g, ' ').trim().slice(0, max);
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
