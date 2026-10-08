// Google sends the browser here after the member approves. Exchanges the one-time code for a refresh token,
// stores it (server side only) and sends the member back to the page. Deployed WITHOUT jwt verification
// because the redirect comes from Google, not from our page; the one-time `state` identifies the member.
import { createClient } from 'npm:@supabase/supabase-js@2';

function back(appUrl: string, result: string): Response {
  return new Response(null, { status: 302, headers: { Location: `${appUrl}${appUrl.includes('?') ? '&' : '?'}gmail=${result}` } });
}

Deno.serve(async (req: Request) => {
  const appUrl = Deno.env.get('APP_URL') ?? '';
  if (!appUrl) return new Response('APP_URL is not set', { status: 500 });
  const search = new URL(req.url).searchParams;
  const code = search.get('code');
  const state = search.get('state');
  if (search.get('error') || !code || !state) return back(appUrl, 'cancelled');

  const url = Deno.env.get('SUPABASE_URL')!;
  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

  const { data: row } = await admin
    .from('gmail_oauth_states')
    .select('user_id, created_at')
    .eq('state', state)
    .maybeSingle();
  if (!row) return back(appUrl, 'error');
  await admin.from('gmail_oauth_states').delete().eq('state', state); // one use only
  if (Date.now() - new Date(row.created_at).getTime() > 10 * 60 * 1000) return back(appUrl, 'expired');

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: Deno.env.get('GOOGLE_CLIENT_ID')!,
      client_secret: Deno.env.get('GOOGLE_CLIENT_SECRET')!,
      redirect_uri: `${url}/functions/v1/gmail-callback`,
      grant_type: 'authorization_code',
    }),
  });
  const tokens = await response.json();
  if (!response.ok || !tokens.refresh_token) return back(appUrl, 'error');

  // The e-mail address comes straight from Google's answer (id_token payload) over TLS.
  let email: string | null = null;
  try {
    email = JSON.parse(atob(String(tokens.id_token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).email ?? null;
  } catch {
    email = null;
  }

  const { error } = await admin.from('gmail_connections').upsert({
    user_id: row.user_id,
    google_email: email,
    refresh_token: tokens.refresh_token,
    history_id: null, // start fresh: the first run looks at the last 2 days
    last_checked_at: null,
    connected_at: new Date().toISOString(),
  });
  return back(appUrl, error ? 'error' : 'connected');
});
