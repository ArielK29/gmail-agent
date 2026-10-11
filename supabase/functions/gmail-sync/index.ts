// The agent's HTTP entry point. The work for one member lives in sync.ts (tested with fakes in sync.test.ts).
//
// Two ways to call it:
//  * the page's "check now" button (the member's own session token): checks only that member;
//  * the scheduled job (a secret from the agent_secrets table): checks every connected member.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { syncOne, type Connection } from './sync.ts';
import { isThrottled } from './logic.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const reply = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const MANUAL_COOLDOWN_MS = 30_000; // the "check now" button cannot be hammered (protects the model quota)
const BATCH_SIZE = 5; // members checked in parallel by the scheduled run
const RUN_BUDGET_MS = 40_000; // stop starting new batches before the 60 s timeout of the scheduled call

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return reply(405, { error: 'method not allowed' });

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  });
  const token = (req.headers.get('Authorization') ?? '').replace(/^bearer /i, '');
  if (!token) return reply(401, { error: 'not signed in' });

  const { data: secret } = await admin.from('agent_secrets').select('value').eq('name', 'cron').maybeSingle();
  let query = admin.from('gmail_connections').select('user_id, refresh_token, history_id, last_checked_at, last_attempt_at, status');
  const scheduled = Boolean(secret) && token === secret!.value;
  if (scheduled) {
    // Scheduled run: every member whose connection is alive.
    // Ordered by the last ATTEMPT, so a member whose runs keep failing cannot hold the front of the line forever.
    query = query.eq('status', 'active').order('last_attempt_at', { ascending: true, nullsFirst: true }).limit(25);
  } else {
    const { data, error } = await admin.auth.getUser(token);
    if (error || !data.user) return reply(401, { error: 'not signed in' });
    query = query.eq('user_id', data.user.id); // the button: only the signed-in member
  }

  const { data: connections, error } = await query;
  if (error) return reply(500, { error: 'could not read connections' });
  if (!connections || connections.length === 0) return reply(200, { saved: 0, connected: false });

  const list = connections as Connection[];
  if (!scheduled && list[0].status === 'needs_reconnect') {
    return reply(200, { saved: 0, connected: true, needsReconnect: true, problems: [] });
  }
  if (!scheduled && isThrottled(list[0].last_checked_at, list[0].last_attempt_at, Date.now(), MANUAL_COOLDOWN_MS)) {
    return reply(200, { saved: 0, connected: true, throttled: true, problems: [] });
  }

  let saved = 0;
  const problems: string[] = [];
  const startedAt = Date.now();
  // Members are checked in parallel batches. Whoever is not reached before the time budget runs out is first in line
  // next time (the list is ordered by last_attempt_at), so nobody starves.
  for (let i = 0; i < list.length; i += BATCH_SIZE) {
    if (i > 0 && Date.now() - startedAt > RUN_BUDGET_MS) break;
    const batch = list.slice(i, i + BATCH_SIZE);
    // Stamp the attempt first: the cooldown must hold even when this run fails (best effort, never blocks the run).
    await admin.from('gmail_connections').update({ last_attempt_at: new Date().toISOString() }).in('user_id', batch.map((connection) => connection.user_id));
    const results = await Promise.allSettled(batch.map((connection) => syncOne(admin, connection)));
    for (const result of results) {
      if (result.status === 'fulfilled') {
        saved += result.value.saved;
        if (result.value.error) problems.push(result.value.error);
      } else {
        problems.push(result.reason instanceof Error ? result.reason.message : 'unknown error');
      }
    }
  }
  return reply(200, { saved, connected: true, problems });
});
