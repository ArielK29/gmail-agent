// What happens when Polar calls us (issue #22). `subscriptions` is written ONLY here (service role).
//
// Order of the checks, and why:
//  1. no secret configured          -> 503 (Polar retries later; nothing is trusted without a secret)
//  2. signature wrong / too old     -> 403 (a forged message changes nothing)
//  3. a message we already finished -> 200 "duplicate" (cheap shortcut; only FINISHED messages are recorded, so a crash in the
//     middle never turns Polar's retry into a "duplicate" that hides a lost payment)
//  4. not a subscription event / not one of our members / manual grant / older than what we hold / a cancelled OLD subscription
//     of a member who has a newer live one -> 200, ignored
//  5. save with an ORDER-SAFE write (an existing row is only replaced by a message that is not older, the same message applied twice
//     gives the same row); when saving fails we answer 500 and record nothing, so Polar sends the message again and a payment
//     is never lost
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { isPro } from './entitlement.ts';
import { parseSubscriptionEvent, verifySignature, type WebhookHeaders } from './webhook.ts';

export interface WebhookRequest { headers: WebhookHeaders; rawBody: string }
export interface WebhookAnswer { status: number; body: Record<string, unknown> }
const EVENT_KEEP_MS = 30 * 24 * 3600 * 1000;
export const MAX_BODY_BYTES = 256 * 1024; // a real subscription message is a few kilobytes; nothing bigger is even read

export async function handleWebhook(admin: SupabaseClient, request: WebhookRequest, rawSecret: string | undefined, nowMs = Date.now()): Promise<WebhookAnswer> {
  const secret = rawSecret?.trim(); // a secret pasted into a dashboard may carry a trailing newline or space, which would make every signature fail
  if (!secret) return { status: 503, body: { error: 'not_configured' } };
  if (request.rawBody.length > MAX_BODY_BYTES) return { status: 413, body: { error: 'too_large' } };
  if (!(await verifySignature(secret, request.headers, request.rawBody, nowMs))) return { status: 403, body: { error: 'invalid_signature' } };
  let payload: any;
  try {
    payload = JSON.parse(request.rawBody);
  } catch {
    return { status: 400, body: { error: 'invalid_json' } };
  }
  const webhookId = request.headers.id as string;

  const seen = await admin.from('polar_events').select('webhook_id').eq('webhook_id', webhookId).maybeSingle();
  if (!seen.error && seen.data) return { status: 200, body: { duplicate: true } };

  // Remember a finished message (best effort: when this fails the worst case is that the same message is processed once more).
  const finish = async (body: Record<string, unknown>): Promise<WebhookAnswer> => {
    try {
      await admin.from('polar_events').insert({ webhook_id: webhookId, type: typeof payload?.type === 'string' ? payload.type.slice(0, 100) : 'unknown' });
      await admin.from('polar_events').delete().lt('received_at', new Date(nowMs - EVENT_KEEP_MS).toISOString());
    } catch { /* later */ }
    return { status: 200, body };
  };

  try {
    const parsed = parseSubscriptionEvent(payload);
    if (parsed.kind === 'ignore') return await finish({ ignored: parsed.reason });

    const { data: existing, error: readError } = await admin.from('subscriptions').select('user_id, source, status, current_period_end, polar_subscription_id, polar_modified_at').eq('user_id', parsed.userId).maybeSingle();
    if (readError) { console.error('polar webhook: could not read the subscription'); return { status: 500, body: { error: 'read_failed' } }; }
    if (existing?.source === 'manual') return await finish({ ignored: 'manual_grant' }); // the owner's own grant is never overwritten
    const held = existing?.polar_modified_at ? Date.parse(existing.polar_modified_at) : NaN;
    const incoming = parsed.row.polar_modified_at ? Date.parse(parsed.row.polar_modified_at) : NaN;
    if (Number.isFinite(held) && Number.isFinite(incoming) && incoming < held) return await finish({ ignored: 'older_than_stored' });
    // A member who cancelled subscription A and later bought B: a late message about the end of A must not switch off B.
    if (existing?.polar_subscription_id && existing.polar_subscription_id !== parsed.row.polar_subscription_id && isPro(existing, nowMs) && !isPro(parsed.row, nowMs)) return await finish({ ignored: 'other_subscription_still_active' });

    // The write itself keeps the order: an existing row is only replaced by a message that is not older (one conditional update, so
    // two messages arriving at the same moment cannot leave the older one on top); a new row is inserted, and when another message
    // inserted it first the same conditional update is used.
    const fields = { source: 'polar', plan: 'pro', ...parsed.row, updated_at: new Date(nowMs).toISOString() };
    const update = async () => {
      let query = admin.from('subscriptions').update(fields).eq('user_id', parsed.userId);
      if (parsed.row.polar_modified_at) query = query.or(`polar_modified_at.is.null,polar_modified_at.lte.${parsed.row.polar_modified_at}`);
      return await query.select('user_id');
    };
    let result: { error: unknown; data?: unknown[] | null };
    if (existing) {
      result = await update();
    } else {
      result = await admin.from('subscriptions').insert({ user_id: parsed.userId, ...fields });
      if (result.error && (result.error as { code?: string }).code === '23505') {
        const { data: now } = await admin.from('subscriptions').select('user_id').eq('user_id', parsed.userId).maybeSingle();
        if (!now) return await finish({ ignored: 'subscription_of_another_member' }); // that Polar subscription already belongs to someone else
        result = await update(); // another message created the row a moment ago
      }
    }
    if (result.error) {
      const code = (result.error as { code?: string }).code;
      if (code === '23503') return await finish({ ignored: 'unknown_member' }); // the member was deleted: nothing to keep
      if (code === '23505') return await finish({ ignored: 'subscription_of_another_member' });
      console.error('polar webhook: could not save the subscription');
      return { status: 500, body: { error: 'save_failed' } };
    }
    if (Array.isArray(result.data) && result.data.length === 0) return await finish({ ignored: 'older_than_stored' }); // the conditional update found a newer row
    return await finish({ applied: true });
  } catch {
    console.error('polar webhook: unexpected failure');
    return { status: 500, body: { error: 'failed' } };
  }
}