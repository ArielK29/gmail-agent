// The page calls this with the member's own session: action "checkout" (returns the Polar payment page address) or "portal"
// (returns the customer-portal address where the member can see invoices, change the card or cancel).
import { createClient } from 'npm:@supabase/supabase-js@2';
import { createCheckout, createPortal } from './billing.ts';

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
  const env = { token: Deno.env.get('POLAR_ACCESS_TOKEN'), productId: Deno.env.get('POLAR_PRODUCT_ID'), server: Deno.env.get('POLAR_SERVER'), appUrl: Deno.env.get('APP_URL') };
  const user = { id: data.user.id, email: data.user.email };
  const answer = body?.action === 'portal' ? await createPortal(admin, user, env) : body?.action === 'checkout' ? await createCheckout(admin, user, body.plan, env) : { status: 400, body: { error: 'unknown_action' } };
  return reply(answer.status, answer.body);
});