// The morning briefing as an e-mail (issue #14): pure decisions, no Deno and no network, tested with `node --test`.
// The same lists as the page (docs/logic.js), computed for the member's own time zone, written as plain Hebrew text and as
// small HTML. Everything that comes from other people (mail subjects, senders, calendar and task titles) is untrusted: it is
// cleaned of control characters and HTML-escaped, and never reaches the e-mail subject.
import { addDays, isRealDay, stripControls } from './logic.ts';

export const SEND_FROM_HOUR = 7; // the briefing is a MORNING mail: from 07:00 ...
export const SEND_UNTIL_HOUR = 12; // ... until noon of the member's own day
export const MAX_FAILURES = 3; // after this many failed sends in a row the agent stops trying until the member switches it off and on
export const DEFAULT_TZ = 'Asia/Jerusalem';
const MAX_EACH = 5;

// A time zone name comes from the member's browser: only a real IANA name is used, anything else becomes the default.
export function safeTz(value: unknown): string {
  if (typeof value !== 'string' || value.length > 64 || !/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(value)) return DEFAULT_TZ;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: value });
    return value;
  } catch {
    return DEFAULT_TZ;
  }
}

export interface LocalParts { day: string; hour: number; minute: number }
export function localParts(nowMs: number, tz: string): LocalParts {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(nowMs));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return { day: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')), minute: Number(get('minute')) };
}

export interface DigestConnection { status?: string; digest_email?: boolean; digest_tz?: string | null; digest_last_sent_on?: string | null; digest_failures?: number | null; google_email?: string | null }

// One send per member per local day, only in the morning window, only while switched on, alive and not failing.
export function isDueForDigest(connection: DigestConnection, nowMs: number): boolean {
  if (!connection || connection.digest_email !== true || connection.status !== 'active') return false;
  if (typeof connection.google_email !== 'string' || !isDeliverable(connection.google_email)) return false;
  if ((connection.digest_failures ?? 0) >= MAX_FAILURES) return false;
  const local = localParts(nowMs, safeTz(connection.digest_tz));
  if (local.hour < SEND_FROM_HOUR || local.hour >= SEND_UNTIL_HOUR) return false;
  return connection.digest_last_sent_on !== local.day;
}

// The recipient is the member's own Google address, which came from Google. It still must look like one plain address
// (no list, no name part, no line break) before it goes into a request.
export function isDeliverable(address: string): boolean {
  return address.length <= 254 && /^[^\s@,;<>()"']+@[^\s@,;<>()"']+\.[^\s@,;<>()"']+$/.test(address);
}

const dayNumber = (day: string): number => Date.parse(day + 'T00:00:00Z') / 86400000;
const pad = (n: number) => String(n).padStart(2, '0');

export function deadlineLabel(diff: number): string {
  if (diff === 0) return 'היום';
  if (diff === 1) return 'מחר';
  if (diff > 1) return `בעוד ${diff} ימים`;
  if (diff === -1) return 'באיחור של יום';
  return `באיחור של ${-diff} ימים`;
}
function replyAgeLabel(hours: number): string {
  const days = Math.floor(hours / 24);
  return days < 1 ? 'לפני כמה שעות' : days === 1 ? 'לפני יום' : `לפני ${days} ימים`;
}

export interface Brief {
  deadlines: Array<{ row: any; label: string }>; deadlineMore: number;
  replies: Array<{ row: any; label: string }>; replyMore: number;
  events: Array<{ row: any; label: string }>; eventMore: number;
  tasks: Array<{ row: any; label: string }>; taskMore: number;
  empty: boolean;
}

// The same rules as the page: deadlines 30 days overdue to 7 ahead, mails waiting for an answer (12 hours to 14 days, oldest
// first), today's and tomorrow's events that are not over, tasks 30 days overdue to 7 ahead. Mails marked as handled are out.
export function buildBrief(mails: unknown, agenda: unknown, nowMsIn: number, tz: string): Brief {
  const nowMs = Number.isFinite(nowMsIn) ? nowMsIn : Date.now();
  const mailRows: any[] = Array.isArray(mails) ? mails.filter((row) => row && typeof row === 'object' && !Array.isArray(row)) : [];
  const agendaRows: any[] = Array.isArray(agenda) ? agenda.filter((row) => row && typeof row === 'object' && !Array.isArray(row)) : [];
  const today = localParts(nowMs, tz).day;
  const tomorrow = addDays(today, 1);
  const dayOf = (ms: number) => localParts(ms, tz).day;
  const clockOf = (ms: number) => { const local = localParts(ms, tz); return `${pad(local.hour)}:${pad(local.minute)}`; };
  const received = (row: any) => (row.received_at ? new Date(row.received_at).getTime() : NaN);

  const open = mailRows.filter((row) => !row.handled_at);
  const deadlines = open
    .filter((row) => isRealDay(row.due_date))
    .map((row) => ({ row, diff: dayNumber(row.due_date) - dayNumber(today) }))
    .filter((entry) => entry.diff >= -30 && entry.diff <= 7)
    .sort((a, b) => a.diff - b.diff || received(b.row) - received(a.row))
    .map((entry) => ({ row: entry.row, label: deadlineLabel(entry.diff) }));
  const replies = open
    .filter((row) => row.needs_reply === true && Number.isFinite(received(row)) && nowMs - received(row) >= 12 * 3600_000 && nowMs - received(row) <= 14 * 24 * 3600_000)
    .sort((a, b) => received(a) - received(b))
    .map((row) => ({ row, label: replyAgeLabel((nowMs - received(row)) / 3600_000) }));

  const events: Array<{ row: any; sort: number; label: string }> = [];
  for (const row of agendaRows) {
    if (row.kind !== 'event') continue;
    const word = (day: string) => (day === today ? 'היום' : 'מחר');
    if (row.all_day === true) {
      if (isRealDay(row.day) && (row.day === today || row.day === tomorrow)) events.push({ row, sort: dayNumber(row.day) * 1440 - 1, label: `${word(row.day)} · כל היום` });
      continue;
    }
    const start = row.starts_at ? new Date(row.starts_at).getTime() : NaN;
    if (!Number.isFinite(start)) continue;
    const end = row.ends_at ? new Date(row.ends_at).getTime() : NaN;
    if (Number.isFinite(end) ? end <= nowMs : start < nowMs - 3600_000) continue;
    const day = dayOf(start);
    if (day !== today && day !== tomorrow) continue;
    events.push({ row, sort: start / 60000, label: start <= nowMs ? `עכשיו · עד ${Number.isFinite(end) ? clockOf(end) : '?'}` : `${word(day)} · ${clockOf(start)}` });
  }
  events.sort((a, b) => a.sort - b.sort);
  const tasks = agendaRows
    .filter((row) => row.kind === 'task' && isRealDay(row.day))
    .map((row) => ({ row, diff: dayNumber(row.day) - dayNumber(today) }))
    .filter((entry) => entry.diff >= -30 && entry.diff <= 7)
    .sort((a, b) => a.diff - b.diff)
    .map((entry) => ({ row: entry.row, label: deadlineLabel(entry.diff) }));

  const cut = <T,>(list: T[]) => [list.slice(0, MAX_EACH), Math.max(0, list.length - MAX_EACH)] as const;
  const [ev, evMore] = cut(events.map((e) => ({ row: e.row, label: e.label })));
  const [tk, tkMore] = cut(tasks);
  const [dl, dlMore] = cut(deadlines);
  const [rp, rpMore] = cut(replies);
  return { deadlines: dl, deadlineMore: dlMore, replies: rp, replyMore: rpMore, events: ev, eventMore: evMore, tasks: tk, taskMore: tkMore, empty: events.length + tasks.length + deadlines.length + replies.length === 0 };
}

// ---------------------------------------------------------------- the e-mail
export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
// Text of other people: control and bidi characters out, one line, cut.
const clean = (value: unknown, max: number): string => (typeof value === 'string' ? stripControls(value).replace(/\s+/g, ' ').trim().slice(0, max) : '');

export interface Composed { subject: string; text: string; html: string; count: number }

// null = nothing worth a mail today (the member is not bothered with an empty briefing).
export function composeEmail(brief: Brief): Composed | null {
  if (brief.empty) return null;
  const shown = brief.events.length + brief.tasks.length + brief.deadlines.length + brief.replies.length;
  const count = shown + brief.eventMore + brief.taskMore + brief.deadlineMore + brief.replyMore;
  const subject = `סיכום הבוקר: ${count === 1 ? 'דבר אחד' : `${count} דברים`} שכדאי לראות`; // numbers only: nothing from a mail reaches the subject
  const mailLine = (row: any, label: string) => `${clean(row.from_name, 80) || 'לא ידוע'} · ${clean(row.subject, 120) || '(ללא נושא)'} (${label})`;
  const sections: Array<{ title: string; lines: string[]; more: string }> = [
    { title: 'היום וגם מחר ביומן', lines: brief.events.map((e) => `${clean(e.row.title, 120) || '(ללא כותרת)'} (${e.label})`), more: brief.eventMore ? `ועוד ${brief.eventMore} אירועים ביומן.` : '' },
    { title: 'משימות שמחכות', lines: brief.tasks.map((t) => `${clean(t.row.title, 120) || '(ללא כותרת)'} (${t.label})`), more: brief.taskMore ? `ועוד ${brief.taskMore} משימות.` : '' },
    { title: 'מועדים קרובים', lines: brief.deadlines.map((d) => mailLine(d.row, d.label)), more: brief.deadlineMore ? `ועוד ${brief.deadlineMore} מועדים.` : '' },
    { title: 'ייתכן שצריך לענות', lines: brief.replies.map((r) => mailLine(r.row, r.label)), more: brief.replyMore ? `ועוד ${brief.replyMore} מיילים שממתינים לתשובה.` : '' },
  ].filter((section) => section.lines.length > 0);
  const footer = 'המייל נשלח אוטומטית מסוכן Gmail. כדי להפסיק לקבל אותו, בטל את הסימון "שלח לי את הבריפינג למייל כל בוקר" בדף.';
  const text = [...sections.flatMap((s) => [s.title, ...s.lines.map((l) => `- ${l}`), ...(s.more ? [s.more] : []), '']), footer].join('\n');
  const html = `<div dir="rtl" style="font-family:Arial,sans-serif;line-height:1.5;color:#222">${sections
    .map((s) => `<h3 style="margin:16px 0 4px">${escapeHtml(s.title)}</h3><ul style="margin:0;padding-inline-start:20px">${s.lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>${s.more ? `<p style="margin:4px 0">${escapeHtml(s.more)}</p>` : ''}`)
    .join('')}<p style="color:#777;font-size:12px;margin-top:20px">${escapeHtml(footer)}</p></div>`;
  return { subject, text, html, count };
}
