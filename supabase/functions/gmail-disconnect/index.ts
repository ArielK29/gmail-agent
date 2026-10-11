// "Disconnect Gmail": deletes the member's saved digest and connection, then revokes the token at Google.
// Order matters: nothing is revoked until the deletes worked, so a failed delete can simply be retried.
// A failed delete is reported (never a silent "ok").
import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const reply = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return reply(405, { error: 'method not allowed' });

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  });
  const token = (req.headers.get('Authorization') ?? '').replace(/^bearer /i, '');
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) return reply(401, { error: 'not signed in' });
  const userId = data.user.id;

  const { data: connection } = await admin.from('gmail_connections').select('refresh_token').eq('user_id', userId).maybeSingle();

  // 1. the summaries first: if this fails the connection (and the token) stay, and the member can try again.
  const digest = await admin.from('gmail_digest').delete().eq('user_id', userId);
  if (digest.error) {
    console.error('disconnect: could not delete the digest');
    return reply(500, { error: 'delete_failed' });
  }
  // 1b. the results of on-demand scans (their rows go with them): they are mail-derived data too
  const scans = await admin.from('gmail_scans').delete().eq('user_id', userId);
  if (scans.error) {
    console.error('disconnect: could not delete the scans');
    return reply(500, { error: 'delete_failed' });
  }
  // 1c. the calendar events and tasks
  const agenda = await admin.from('gmail_agenda').delete().eq('user_id', userId);
  if (agenda.error) {
    console.error('disconnect: could not delete the agenda');
    return reply(500, { error: 'delete_failed' });
  }
  // 2. the connection
  const removed = await admin.from('gmail_connections').delete().eq('user_id', userId);
  if (removed.error) {
    console.error('disconnect: could not delete the connection');
    return reply(500, { error: 'delete_failed' });
  }

  // 3. revoke at Google (best effort; the answer tells the page whether Google confirmed it)
  let revoked = !connection?.refresh_token;
  if (connection?.refresh_token) {
    revoked = await fetch('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: connection.refresh_token }),
    })
      .then((response) => response.ok)
      .catch(() => false);
  }
  return reply(200, { ok: true, revoked });
});
