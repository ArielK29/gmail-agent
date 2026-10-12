// What happens when Polar calls us (issue #22). `subscriptions` is written ONLY here (service role).
//
// Order of the checks, and why:
//  1. no secret or no product id configured -> 503 (Polar retries later; nothing is trusted without them)
//  2. signature wrong / too old     -> 403 (a forged message changes nothing)
//  3. a message we already finished -> 200 "duplicate" (cheap shortcut; only FINISHED messages are recorded, so a crash in the
//     middle never turns Polar's retry into a "duplicate" that hides a lost payment)
//  4. not a subscription event / not one of our members / not OUR product (issue #24: the sandbox organization is shared with
//     another app) / manual grant / older than what we hold / a cancelled OLD subscription of a member who has a newer live one
//     -> 200, ignored
//  5. save with an ORDER-SAFE write (an existing row is only replaced by a message that is not older, the same message applied twice
//     gives the same row); when saving fails we answer 500 and record nothing, so Polar sends the message again and a payment
//     is never lost
// Every FINISHED message leaves one outcome row in `polar_events` (what happened and why: no payload, no e-mail, no name), so "why
// is this member Free?" can be answered from our own database.
// A row of the OTHER Polar environment (sandbox data in production or the reverse) is treated as not existing: the real message
// replaces it, whatever its dates say.
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { isPro, liveRow, serverKind } from './entitlement.ts';
import { parseSubscriptionEvent, verifySignature, type WebhookHeaders } from './webhook.ts';

export interface WebhookRequest { headers: WebhookHeaders; rawBody: string }
export interface WebhookAnswer { status: number; body: Record<string, unknown> }
// What this deployment is: OUR product (events about other products are ignored) and which Polar world it talks to.
export interface WebhookConfig { productId?: string; server?: string }
interface Outcome { outcome: 'applied' | 'ignored'; reason?: string; user_id?: string; subscription_status?: string; current_period_end?: string | null }
const EVENT_KEEP_MS = 30 * 24 * 3600 * 1000;
export const MAX_BODY_BYTES = 256 * 1024; // a real subscription message is a few kilobytes; nothing bigger is even read

export async function handleWebhook(admin: SupabaseClient, request: WebhookRequest, rawSecret: string | undefined, nowMs = Date.now(), config: WebhookConfig = {}): Promise<WebhookAnswer> {
  const secret = rawSecret?.trim(); // a secret pasted into a dashboard may carry a trailing newline or space, which would make every signature fail
  const productId = config?.productId?.trim();
  if (!secret || !productId) return { status: 503, body: { error: 'not_configured' } };
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

  // Remember a finished message and what came of it (best effort: when this fails the worst case is that the same message is
  // processed once more).
  const finish = async (body: Record<string, unknown>, outcome: Outcome): Promise<WebhookAnswer> => {
    try {
      const row: Record<string, unknown> = { webhook_id: webhookId, type: typeof payload?.type === 'string' ? payload.type.slice(0, 100) : 'unknown' };
      for (const [key, value] of Object.entries(outcome)) if (value !== undefined) row[key] = value;
      await admin.from('polar_events').insert(row);
      await admin.from('polar_events').delete().lt('received_at', new Date(nowMs - EVENT_KEEP_MS).toISOString());
    } catch { /* later */ }
    return { status: 200, body };
  };
  const ignored = (reason: string, extra: Partial<Outcome> = {}) => finish({ ignored: reason }, { outcome: 'ignored', reason, ...extra });

  try {
    const parsed = parseSubscriptionEvent(payload);
    if (parsed.kind === 'ignore') return await ignored(parsed.reason);
    const about = { user_id: parsed.userId, subscription_status: parsed.row.status, current_period_end: parsed.row.current_period_end };
    if (parsed.productId === null) return await ignored('no_product', about);
    if (parsed.productId !== productId) return await ignored('other_product', about); // exact match only: the id is ours, not a pattern

    const { data: existing, error: readError } = await admin.from('subscriptions').select('user_id, source, status, current_period_end, polar_subscription_id, polar_modified_at, polar_server').eq('user_id', parsed.userId).maybeSingle();
    if (readError) { console.error('polar webhook: could not read the subscription'); return { status: 500, body: { error: 'read_failed' } }; }
    if (existing?.source === 'manual') return await ignored('manual_grant', about); // the owner's own grant is never overwritten
    const existingLive = liveRow(existing, config.server); // a row of the other Polar environment does not exist for the rules below
    const stale = Boolean(existing) && !existingLive;
    const held = existingLive?.polar_modified_at ? Date.parse(existingLive.polar_modified_at) : NaN;
    const incoming = parsed.row.polar_modified_at ? Date.parse(parsed.row.polar_modified_at) : NaN;
    if (Number.isFinite(held) && Number.isFinite(incoming) && incoming < held) return await ignored('older_than_stored', about);
    // A member who cancelled subscription A and later bought B: a late message about the end of A must not switch off B.
    if (existingLive?.polar_subscription_id && existingLive.polar_subscription_id !== parsed.row.polar_subscription_id && isPro(existingLive, nowMs) && !isPro(parsed.row, nowMs)) return await ignored('other_subscription_still_active', about);

    // The write itself keeps the order: an existing row is only replaced by a message that is not older (one conditional update, so
    // two messages arriving at the same moment cannot leave the older one on top); a new row is inserted, and when another message
    // inserted it first the same conditional update is used. A row of the other environment is replaced without the condition.
    const fields = { source: 'polar', plan: 'pro', ...parsed.row, polar_server: serverKind(config.server), updated_at: new Date(nowMs).toISOString() };
    const update = async () => {
      let query = admin.from('subscriptions').update(fields).eq('user_id', parsed.userId);
      if (!stale && parsed.row.polar_modified_at) query = query.or(`polar_modified_at.is.null,polar_modified_at.lte.${parsed.row.polar_modified_at}`);
      return await query.select('user_id');
    };
    let result: { error: unknown; data?: unknown[] | null };
    if (existing) {
      result = await update();
    } else {
      result = await admin.from('subscriptions').insert({ user_id: parsed.userId, ...fields });
      if (result.error && (result.error as { code?: string }).code === '23505') {
        const { data: now } = await admin.from('subscriptions').select('user_id').eq('user_id', parsed.userId).maybeSingle();
        if (!now) return await ignored('subscription_of_another_member', about); // that Polar subscription already belongs to someone else
        result = await update(); // another message created the row a moment ago
      }
    }
    if (result.error) {
      const code = (result.error as { code?: string }).code;
      if (code === '23503') return await ignored('unknown_member', about); // the member was deleted: nothing to keep
      if (code === '23505') return await ignored('subscription_of_another_member', about);
      console.error('polar webhook: could not save the subscription');
      return { status: 500, body: { error: 'save_failed' } };
    }
    if (Array.isArray(result.data) && result.data.length === 0) return await ignored('older_than_stored', about); // the conditional update found a newer row
    return await finish({ applied: true }, { outcome: 'applied', ...about });
  } catch {
    console.error('polar webhook: unexpected failure');
    return { status: 500, body: { error: 'failed' } };
  }
}
