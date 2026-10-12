// What happens when Polar calls us (issue #22). `subscriptions` is written ONLY here (service role).
//
// Order of the checks, and why:
//  1. no secret configured          -> 503 (Polar retries later; nothing is trusted without a secret)
//  2. signature wrong / too old     -> 403 (a forged message changes nothing)
//  3. the webhook id is CLAIMED      -> a second delivery of the same message answers 200 "duplicate" and does nothing
//  4. not a subscription event / not one of our members / manual grant / older than what we hold -> 200, ignored
//  5. save; when saving fails the claim is given back and we answer 500, so Polar sends the message again (a payment is never lost)
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { parseSubscriptionEvent, verifySignature, type WebhookHeaders } from './webhook.ts';

export interface WebhookRequest { headers: WebhookHeaders; rawBody: string }
export interface WebhookAnswer { status: number; body: Record<string, unknown> }
const EVENT_KEEP_MS = 30 * 24 * 3600 * 1000;

export async function handleWebhook(admin: SupabaseClient, request: WebhookRequest, secret: string | undefined, nowMs = Date.now()): Promise<WebhookAnswer> {
  if (!secret || secret.trim() === '') return { status: 503, body: { error: 'not_configured' } };
  if (!(await verifySignature(secret, request.headers, request.rawBody, nowMs))) return { status: 403, body: { error: 'invalid_signature' } };
  let payload: any;
  try {
    payload = JSON.parse(request.rawBody);
  } catch {
    return { status: 400, body: { error: 'invalid_json' } };
  }
  const webhookId = request.headers.id as string;

  const claim = await admin.from('polar_events').insert({ webhook_id: webhookId, type: typeof payload?.type === 'string' ? payload.type.slice(0, 100) : 'unknown' });
  if (claim.error) {
    if ((claim.error as { code?: string }).code === '23505') return { status: 200, body: { duplicate: true } };
    return { status: 500, body: { error: 'could_not_record' } };
  }
  const giveBack = async () => { try { await admin.from('polar_events').delete().eq('webhook_id', webhookId); } catch { /* the next delivery finds the id claimed: nothing better to do */ } };

  try {
    const parsed = parseSubscriptionEvent(payload);
    if (parsed.kind === 'ignore') return { status: 200, body: { ignored: parsed.reason } };

    const { data: existing, error: readError } = await admin.from('subscriptions').select('user_id, source, polar_modified_at').eq('user_id', parsed.userId).maybeSingle();
    if (readError) { await giveBack(); return { status: 500, body: { error: 'read_failed' } }; }
    if (existing?.source === 'manual') return { status: 200, body: { ignored: 'manual_grant' } }; // the owner's own grant is never overwritten
    const held = existing?.polar_modified_at ? Date.parse(existing.polar_modified_at) : NaN;
    const incoming = parsed.row.polar_modified_at ? Date.parse(parsed.row.polar_modified_at) : NaN;
    if (Number.isFinite(held) && Number.isFinite(incoming) && incoming < held) return { status: 200, body: { ignored: 'older_than_stored' } };

    const saved = await admin.from('subscriptions').upsert(
      { user_id: parsed.userId, source: 'polar', plan: 'pro', ...parsed.row, updated_at: new Date(nowMs).toISOString() },
      { onConflict: 'user_id' }
    );
    if (saved.error) {
      const code = (saved.error as { code?: string }).code;
      if (code === '23503') return { status: 200, body: { ignored: 'unknown_member' } }; // the member was deleted: nothing to keep
      if (code === '23505') return { status: 200, body: { ignored: 'subscription_of_another_member' } };
      await giveBack();
      return { status: 500, body: { error: 'save_failed' } };
    }
    // housekeeping, best effort: old webhook ids are not needed any more
    try { await admin.from('polar_events').delete().lt('received_at', new Date(nowMs - EVENT_KEEP_MS).toISOString()); } catch { /* later */ }
    return { status: 200, body: { applied: true } };
  } catch {
    await giveBack();
    return { status: 500, body: { error: 'failed' } };
  }
}