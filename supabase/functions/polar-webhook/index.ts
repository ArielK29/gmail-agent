// Polar calls this address (deployed WITHOUT jwt verification: the proof is the signature, not a login).
import { createClient } from 'npm:@supabase/supabase-js@2';
import { handleWebhook, MAX_BODY_BYTES } from './handler.ts';

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'method not allowed' }), { status: 405 });
  if (Number(req.headers.get('content-length') ?? '0') > MAX_BODY_BYTES) return new Response(JSON.stringify({ error: 'too_large' }), { status: 413 });
  const rawBody = await req.text(); // the signature covers the exact bytes, so the body is read as text first
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const answer = await handleWebhook(
    admin,
    { headers: { id: req.headers.get('webhook-id'), timestamp: req.headers.get('webhook-timestamp'), signature: req.headers.get('webhook-signature') }, rawBody },
    Deno.env.get('POLAR_WEBHOOK_SECRET'),
    Date.now(),
    { productId: Deno.env.get('POLAR_PRODUCT_ID'), server: Deno.env.get('POLAR_SERVER') }
  );
  return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'Content-Type': 'application/json' } });
});
