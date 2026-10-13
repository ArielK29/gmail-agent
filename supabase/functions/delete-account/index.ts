// The page calls this with the member's own session: deletes the member's whole account (see account.ts for the order and why).
import { createClient } from 'npm:@supabase/supabase-js@2';
import { deleteAccount } from './account.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const reply = (status: number, body: Record<string, unknown>) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return reply(405, { error: 'method not allowed' });
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const token = (req.headers.get('Authorization') ?? '').replace(/^bearer /i, '');
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) return reply(401, { error: 'not signed in' });
  const body = await req.json().catch(() => ({}));
  const answer = await deleteAccount(
    admin,
    { id: data.user.id },
    body,
    { token: Deno.env.get('POLAR_ACCESS_TOKEN'), server: Deno.env.get('POLAR_SERVER') },
    { deleteUser: (id) => admin.auth.admin.deleteUser(id) }
  );
  return reply(answer.status, answer.body);
});
