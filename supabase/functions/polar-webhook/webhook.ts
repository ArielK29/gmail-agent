// Polar webhooks (issue #22): signature check (Standard Webhooks, HMAC-SHA256 over "id.timestamp.body") and the translation of a
// subscription event into the row we store. Pure apart from WebCrypto; tested with `node --test`.
const TEXT = new TextEncoder();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const TOLERANCE_SECONDS = 300;

function fromBase64(value: string): Uint8Array | null {
  try {
    const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

// Polar documents two ways of reading the secret: the standard one (the part after `whsec_` is base64) and its older one (the
// whole text, UTF-8). Either may be the one in use, so both keys are tried.
function candidateKeys(secret: string): Uint8Array[] {
  const keys: Uint8Array[] = [TEXT.encode(secret)];
  if (secret.startsWith('whsec_')) {
    const decoded = fromBase64(secret.slice('whsec_'.length));
    if (decoded && decoded.length > 0) keys.unshift(decoded);
  }
  return keys;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function sign(key: Uint8Array, text: string): Promise<Uint8Array> {
  const imported = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', imported, TEXT.encode(text)));
}

export interface WebhookHeaders { id: string | null; timestamp: string | null; signature: string | null }

// true only for a message signed with our secret, not older (or newer) than five minutes, with the body exactly as received.
export async function verifySignature(secret: string, headers: WebhookHeaders, rawBody: string, nowMs: number): Promise<boolean> {
  if (typeof secret !== 'string' || secret.trim() === '' || typeof rawBody !== 'string') return false;
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature || id.length > 200 || signature.length > 2000) return false;
  if (!/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > TOLERANCE_SECONDS) return false;
  const given = signature
    .split(' ')
    .map((part) => part.trim().split(','))
    .filter((pair) => pair.length === 2 && pair[0] === 'v1')
    .map((pair) => fromBase64(pair[1]))
    .filter((bytes): bytes is Uint8Array => bytes !== null);
  if (given.length === 0) return false;
  const signedText = `${id}.${timestamp}.${rawBody}`;
  for (const key of candidateKeys(secret.trim())) {
    const expected = await sign(key, signedText);
    if (given.some((candidate) => sameBytes(candidate, expected))) return true;
  }
  return false;
}

// ---------------------------------------------------------------- the subscription row
const STATUSES = ['incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid'];
export interface StoredSubscription {
  status: string;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  polar_customer_id: string | null;
  polar_subscription_id: string;
  polar_modified_at: string | null;
}
export type Parsed = { kind: 'ignore'; reason: string } | { kind: 'subscription'; userId: string; row: StoredSubscription };

const iso = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};
const shortText = (value: unknown): string | null => (typeof value === 'string' && value.length >= 1 && value.length <= 100 ? value : null);

// Which member does a Polar subscription belong to? The id we gave Polar when the checkout was created (`external_customer_id`,
// and the same id in the metadata). Anything that is not a UUID is not ours.
export function parseSubscriptionEvent(payload: unknown): Parsed {
  const event = payload as any;
  if (!event || typeof event !== 'object' || typeof event.type !== 'string') return { kind: 'ignore', reason: 'not_an_event' };
  if (!event.type.startsWith('subscription.')) return { kind: 'ignore', reason: 'not_a_subscription_event' };
  const data = event.data;
  if (!data || typeof data !== 'object') return { kind: 'ignore', reason: 'no_data' };
  const subscriptionId = shortText(data.id);
  if (!subscriptionId) return { kind: 'ignore', reason: 'no_subscription_id' };
  if (typeof data.status !== 'string' || !STATUSES.includes(data.status)) return { kind: 'ignore', reason: 'unknown_status' };
  const candidates = [data.customer?.external_id, data.metadata?.user_id];
  const userId = candidates.find((value) => typeof value === 'string' && UUID.test(value));
  if (typeof userId !== 'string') return { kind: 'ignore', reason: 'no_member' };
  return {
    kind: 'subscription',
    userId: userId.toLowerCase(),
    row: {
      status: data.status,
      current_period_end: iso(data.current_period_end),
      cancel_at_period_end: data.cancel_at_period_end === true,
      polar_customer_id: shortText(data.customer?.id) ?? shortText(data.customer_id),
      polar_subscription_id: subscriptionId,
      polar_modified_at: iso(data.modified_at) ?? iso(data.created_at),
    },
  };
}