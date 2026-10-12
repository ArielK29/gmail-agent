// Sends the morning briefing by e-mail to members who switched it on (issue #14). Called at the end of every scheduled run.
//
// Rules: one mail per member per local day (the day is CLAIMED with one conditional update before anything is sent, so two
// overlapping runs cannot both send); the recipient is only the member's own connected Google address; an empty briefing
// sends nothing; a failure gives the day back so it is tried again, and after MAX_FAILURES permanent refusals in a row the
// agent stops trying; without a configured sending service nothing happens at all (no failure is counted).
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { MAX_FAILURES, buildBrief, composeEmail, composeTestEmail, isDeliverable, isDueForDigest, localParts, safeTz } from './briefing.ts';

export type SendResult = { ok: true } | { skip: 'not_configured' } | { fail: 'transient' | 'permanent' };
export type Sender = (message: { to: string; subject: string; html: string; text: string; key: string }) => Promise<SendResult>;

// Resend (https://resend.com). The key is a Supabase secret (RESEND_API_KEY); EMAIL_FROM is optional (a verified sender).
export const sendEmail: Sender = async ({ to, subject, html, text, key }) => {
  const apiKey = Deno.env.get('RESEND_API_KEY');
  if (!apiKey) return { skip: 'not_configured' };
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify({ from: Deno.env.get('EMAIL_FROM') ?? 'סוכן Gmail <onboarding@resend.dev>', to: [to], subject, html, text }),
    });
    if (response.ok) return { ok: true };
    return { fail: response.status === 429 || response.status >= 500 ? 'transient' : 'permanent' };
  } catch {
    return { fail: 'transient' };
  }
};

export interface DigestRun { sent: number; empty: number; failed: number; notConfigured: number }

export async function sendDigests(admin: SupabaseClient, nowMs: number, send: Sender = sendEmail, max = 50): Promise<DigestRun> {
  const run: DigestRun = { sent: 0, empty: 0, failed: 0, notConfigured: 0 };
  const { data: connections } = await admin
    .from('gmail_connections')
    .select('user_id, google_email, status, digest_email, digest_tz, digest_last_sent_on, digest_failures')
    .eq('digest_email', true)
    .eq('status', 'active')
    .limit(max);
  for (const connection of (connections ?? []) as any[]) {
    if (!isDueForDigest(connection, nowMs)) continue;
    const tz = safeTz(connection.digest_tz);
    const day = localParts(nowMs, tz).day;
    // Claim the day: whoever changes the row first sends, the other run finds 0 rows and does nothing.
    const claim = await admin
      .from('gmail_connections')
      .update({ digest_last_sent_on: day })
      .eq('user_id', connection.user_id)
      .eq('digest_email', true)
      .or(`digest_last_sent_on.is.null,digest_last_sent_on.lt.${day}`)
      .select('user_id');
    if ((claim.data ?? []).length !== 1) continue;
    const giveBack = (extra: Record<string, unknown> = {}) =>
      admin.from('gmail_connections').update({ digest_last_sent_on: connection.digest_last_sent_on ?? null, ...extra }).eq('user_id', connection.user_id).eq('digest_last_sent_on', day);
    try {
      const mails = await admin.from('gmail_digest').select('from_name, subject, category, received_at, due_date, needs_reply, handled_at').eq('user_id', connection.user_id).order('received_at', { ascending: false }).limit(200);
      const agenda = await admin.from('gmail_agenda').select('kind, title, starts_at, ends_at, all_day, day').eq('user_id', connection.user_id).limit(200);
      if (mails.error || agenda.error) { await giveBack(); continue; }
      const composed = composeEmail(buildBrief(mails.data, agenda.data, nowMs, tz));
      if (!composed) { run.empty++; continue; } // nothing to say today: the day stays claimed
      const result = await send({ to: connection.google_email, subject: composed.subject, html: composed.html, text: composed.text, key: `digest-${connection.user_id}-${day}` });
      if ('ok' in result) {
        run.sent++;
        if ((connection.digest_failures ?? 0) > 0) await admin.from('gmail_connections').update({ digest_failures: 0 }).eq('user_id', connection.user_id);
      } else if ('skip' in result) {
        run.notConfigured++;
        await giveBack();
      } else {
        run.failed++;
        await giveBack(result.fail === 'permanent' ? { digest_failures: Math.min(MAX_FAILURES, (connection.digest_failures ?? 0) + 1) } : {});
      }
    } catch {
      try { await giveBack(); } catch { /* the next run finds the day claimed and waits for tomorrow: better than a second mail */ } // never leaves a day claimed without a mail when the database is fine
    }
  }
  return run;
}

// ---------------------------------------------------------------- "send me a test e-mail now"
export const TEST_COOLDOWN_MS = 10 * 60 * 1000;

// Called with the member's own session. Sends the briefing (or a short note) to the member's own Google address, at most once
// per 10 minutes (the time is claimed with one conditional update, so a double click or two tabs send once).
export async function sendTestDigest(admin: SupabaseClient, userId: string, nowMs: number, send: Sender = sendEmail): Promise<{ status: number; body: Record<string, unknown> }> {
  const { data: connection } = await admin.from('gmail_connections').select('user_id, google_email, status, digest_tz, digest_test_at').eq('user_id', userId).maybeSingle();
  if (!connection) return { status: 409, body: { error: 'not_connected' } };
  if (connection.status === 'needs_reconnect') return { status: 409, body: { error: 'needs_reconnect' } };
  if (typeof connection.google_email !== 'string' || !isDeliverable(connection.google_email)) return { status: 409, body: { error: 'no_address' } };
  const before = connection.digest_test_at ?? null;
  const stamp = new Date(nowMs).toISOString();
  const claim = await admin
    .from('gmail_connections')
    .update({ digest_test_at: stamp })
    .eq('user_id', userId)
    .or(`digest_test_at.is.null,digest_test_at.lt.${new Date(nowMs - TEST_COOLDOWN_MS).toISOString()}`)
    .select('user_id');
  if ((claim.data ?? []).length !== 1) return { status: 429, body: { error: 'too_soon' } };
  const revert = async () => { try { await admin.from('gmail_connections').update({ digest_test_at: before }).eq('user_id', userId).eq('digest_test_at', stamp); } catch { /* the cooldown simply runs out */ } };
  try {
    const tz = safeTz(connection.digest_tz);
    const mails = await admin.from('gmail_digest').select('from_name, subject, category, received_at, due_date, needs_reply, handled_at').eq('user_id', userId).order('received_at', { ascending: false }).limit(200);
    const agenda = await admin.from('gmail_agenda').select('kind, title, starts_at, ends_at, all_day, day').eq('user_id', userId).limit(200);
    if (mails.error || agenda.error) { await revert(); return { status: 500, body: { error: 'read_failed' } }; }
    const composed = composeTestEmail(buildBrief(mails.data, agenda.data, nowMs, tz));
    const result = await send({ to: connection.google_email, subject: composed.subject, html: composed.html, text: composed.text, key: `digest-test-${userId}-${nowMs}` });
    if ('ok' in result) return { status: 200, body: { ok: true } };
    await revert();
    return 'skip' in result ? { status: 503, body: { error: 'not_configured' } } : { status: 502, body: { error: 'send_failed' } };
  } catch {
    await revert();
    return { status: 500, body: { error: 'failed' } };
  }
}