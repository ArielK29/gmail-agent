// Google sends the browser here after the member approves. Exchanges the one-time code for a refresh token,
// stores it (server side only) and sends the member back to the page. Deployed WITHOUT jwt verification
// because the redirect comes from Google, not from our page; the one-time `state` identifies the member.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { backUrlFor, consentOutcome, optionalScopes } from './logic.ts';

// Back to the web page, or to the mobile app's deep link when the member started the connection from the app (issue 32).
function back(appUrl: string, result: string, target?: unknown): Response {
  return new Response(null, { status: 302, headers: { Location: backUrlFor(target, appUrl, Deno.env.get('APP_DEEP_LINK') ?? undefined, result) } });
}

Deno.serve(async (req: Request) => {
  const appUrl = Deno.env.get('APP_URL') ?? '';
  if (!appUrl) return new Response('APP_URL is not set', { status: 500 });
  const search = new URL(req.url).searchParams;
  const code = search.get('code');
  const state = search.get('state');
  if (!state) return back(appUrl, 'cancelled');

  const url = Deno.env.get('SUPABASE_URL')!;
  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

  const { data: row } = await admin
    .from('gmail_oauth_states')
    .select('user_id, created_at, target')
    .eq('state', state)
    .maybeSingle();
  if (!row) return back(appUrl, search.get('error') || !code ? 'cancelled' : 'error');
  await admin.from('gmail_oauth_states').delete().eq('state', state); // one use only
  if (Date.now() - new Date(row.created_at).getTime() > 10 * 60 * 1000) return back(appUrl, 'expired', row.target);
  if (search.get('error') || !code) return back(appUrl, 'cancelled', row.target);

  // Google being unreachable, or answering with something that is not JSON, must end on the page with a message, not on a blank error.
  let response: Response;
  let tokens: any;
  try {
    response = await fetch('https://oauth2.googleapis.com/token', {
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
    tokens = await response.json().catch(() => ({}));
  } catch {
    return back(appUrl, 'error', row.target);
  }
  const outcome = consentOutcome(response.ok, tokens);
  if (outcome === 'error') return back(appUrl, 'error', row.target);
  if (outcome === 'missing_scope') {
    // Google lets the member untick single permissions on the consent screen. Without the Gmail permission the agent can
    // never read anything, so do not store a connection that looks alive but fails on every run: undo the grant and say why.
    await fetch('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: tokens.refresh_token }),
    }).catch(() => null);
    return back(appUrl, 'missing_scope', row.target);
  }
  // The e-mail address comes straight from Google's answer (id_token payload) over TLS.
  let email: string | null = null;
  try {
    email = JSON.parse(atob(String(tokens.id_token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).email ?? null;
  } catch {
    email = null;
  }

  // Connecting a DIFFERENT Google account: the summaries of the old account must not stay mixed with the new one.
  const { data: existing } = await admin.from('gmail_connections').select('google_email').eq('user_id', row.user_id).maybeSingle();
  if (existing?.google_email && email && existing.google_email.toLowerCase() !== email.toLowerCase()) {
    const wipe = await admin.from('gmail_digest').delete().eq('user_id', row.user_id);
    if (wipe.error) return back(appUrl, 'error', row.target); // never mix two accounts: stop before storing the new connection
    const wipeAgenda = await admin.from('gmail_agenda').delete().eq('user_id', row.user_id);
    if (wipeAgenda.error) return back(appUrl, 'error', row.target);
  }
  // The optional permissions the member kept: what was not granted is switched off and its saved rows are removed.
  const extra = optionalScopes(tokens);
  for (const [granted, kind] of [[extra.calendar, 'event'], [extra.tasks, 'task']] as Array<[boolean, string]>) {
    if (granted) continue;
    const dropped = await admin.from('gmail_agenda').delete().eq('user_id', row.user_id).eq('kind', kind);
    if (dropped.error) return back(appUrl, 'error', row.target);
  }

  const { error } = await admin.from('gmail_connections').upsert({
    user_id: row.user_id,
    google_email: email,
    refresh_token: tokens.refresh_token,
    status: 'active',
    history_id: null, // start fresh: the first run looks at the last 2 days
    last_checked_at: null,
    has_calendar: extra.calendar,
    has_tasks: extra.tasks,
    agenda_checked_at: null,
    connected_at: new Date().toISOString(),
  });
  return back(appUrl, error ? 'error' : 'connected', row.target);
});
