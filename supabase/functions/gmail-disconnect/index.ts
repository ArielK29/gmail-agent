// "Disconnect Gmail": revokes the token at Google, then deletes the connection and the saved digest.
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
  // The local data is deleted either way, but the answer says whether Google confirmed the revoke, so the page can be honest.
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
  await admin.from('gmail_digest').delete().eq('user_id', userId);
  await admin.from('gmail_connections').delete().eq('user_id', userId);
  return reply(200, { ok: true, revoked });
});
