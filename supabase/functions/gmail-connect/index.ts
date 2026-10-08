// Starts the "Connect Gmail" flow: returns the Google consent URL for the signed-in member.
// Separate from sign-in on purpose: only the read-only Gmail scope is requested, with offline access
// (a refresh token) so the agent can check for new emails in the background.
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

  const url = Deno.env.get('SUPABASE_URL')!;
  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const token = (req.headers.get('Authorization') ?? '').replace(/^bearer /i, '');
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) return reply(401, { error: 'not signed in' });

  const clientId = Deno.env.get('GOOGLE_CLIENT_ID');
  if (!clientId) return reply(500, { error: 'GOOGLE_CLIENT_ID is not set' });

  // A random one-time value ties the Google answer back to this member (and expires after 10 minutes).
  const state = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
  await admin.from('gmail_oauth_states').delete().lt('created_at', new Date(Date.now() - 10 * 60 * 1000).toISOString());
  const { error: insertError } = await admin.from('gmail_oauth_states').insert({ state, user_id: data.user.id });
  if (insertError) return reply(500, { error: 'could not start' });

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${url}/functions/v1/gmail-callback`,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/gmail.readonly openid email',
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return reply(200, { url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
});
