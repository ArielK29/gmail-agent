// Starting a payment and opening the customer portal (issue #22). The member's own session is the only way in; the Polar access
// token stays on the server. The id we give Polar as `external_customer_id` is the member's own id, so the webhook can find the
// member again. Card details never reach us: the member pays on Polar's page.
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { isPro, liveRow, serverKind } from './entitlement.ts';

export interface BillingEnv { token?: string; productId?: string; server?: string; appUrl?: string }
export interface Answer { status: number; body: Record<string, unknown> }
type Fetch = typeof fetch;

// Sandbox is the default on purpose: real money needs a deliberate POLAR_SERVER=production.
export const polarBase = (server: string | undefined): string => (server === 'production' ? 'https://api.polar.sh/v1' : 'https://sandbox-api.polar.sh/v1');
const configured = (env: BillingEnv): boolean => Boolean(env.token && env.productId && env.appUrl && /^https:\/\//.test(env.appUrl));
// A secret pasted into a dashboard often carries a trailing newline or space; as an HTTP header value it makes `fetch` throw
// (found in the first sandbox payment test, 2026-10-12), so every value is trimmed before use.
const clean = (env: BillingEnv): BillingEnv => ({ token: env.token?.trim(), productId: env.productId?.trim(), server: env.server, appUrl: env.appUrl?.trim() });
const withParam = (url: string, param: string): string => `${url}${url.includes('?') ? '&' : '?'}${param}`;
const validEmail = (value: unknown): value is string => typeof value === 'string' && value.length <= 254 && /^[^\s@,;<>()"']+@[^\s@,;<>()"']+\.[^\s@,;<>()"']+$/.test(value);
// Only https addresses of polar.sh (checkout.polar.sh, sandbox.polar.sh, polar.sh) are handed to the page.
const httpsUrl = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length > 2083 || !/^https:\/\/[^\s]+$/.test(value)) return false;
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === 'polar.sh' || host.endsWith('.polar.sh');
  } catch {
    return false;
  }
};

async function callPolar(env: BillingEnv, path: string, body: unknown, fetchFn: Fetch): Promise<{ ok: boolean; data: any }> {
  try {
    const response = await fetchFn(`${polarBase(env.server)}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) console.error(`polar ${path} failed: ${response.status} ${describeError(data)}`); // never the request, never a header
    return { ok: response.ok, data };
  } catch (err) {
    // The error text is left out on purpose (it can quote the header with the token); only its kind and the SHAPE of the token are logged.
    console.error(`polar ${path} failed: network error (${(err as Error)?.name ?? 'unknown'}; token ${describeToken(env.token)})`);
    return { ok: false, data: {} };
  }
}

// A short, secret-free description of Polar's error answer (its validation messages name fields, never values we sent).
function describeError(data: any): string {
  const detail = data?.detail;
  const text = Array.isArray(detail) ? detail.map((d: any) => `${Array.isArray(d?.loc) ? d.loc.join('.') : ''}: ${d?.msg ?? ''}`).join('; ') : typeof detail === 'string' ? detail : typeof data?.error === 'string' ? data.error : '';
  return String(text).slice(0, 200);
}

// Length and character classes of a secret, never a character of it (to tell "pasted wrongly" from "Polar unreachable").
function describeToken(value: string | undefined): string {
  if (!value) return 'missing';
  const odd = [...value].filter((c) => c.charCodeAt(0) < 33 || c.charCodeAt(0) > 126).length;
  return `length ${value.length}, ${odd} unusual characters, starts like a Polar token: ${/^polar_oat_/.test(value)}`;
}

// Only the protocol and host of an address (never the path, which holds the checkout secret) for the log.
function describeAddress(value: unknown): string {
  if (typeof value !== 'string') return `no address (${typeof value})`;
  try { const u = new URL(value); return `${u.protocol}//${u.hostname}`; } catch { return 'not an address'; }
}

export async function createCheckout(admin: SupabaseClient, user: { id: string; email?: string | null }, plan: unknown, rawEnv: BillingEnv, nowMs = Date.now(), fetchFn: Fetch = fetch): Promise<Answer> {
  const env = clean(rawEnv);
  if (plan !== 'pro') return { status: 400, body: { error: 'unknown_plan' } }; // only plans we know; the member cannot pick a product or a price
  if (!configured(env)) return { status: 503, body: { error: 'not_configured' } };
  const { data: current, error } = await admin.from('subscriptions').select('status, current_period_end, source, polar_server').eq('user_id', user.id).maybeSingle();
  if (error) return { status: 500, body: { error: 'read_failed' } };
  // Anyone who still has a live subscription (also trialing, or past_due while the card is being retried) must not buy a second one;
  // they manage the existing one in the portal.
  if (isPro(liveRow(current, env.server), nowMs)) return { status: 409, body: { error: 'already_subscribed' } }; // a row of the other Polar environment does not count
  const result = await callPolar(
    env,
    '/checkouts/',
    {
      products: [env.productId],
      external_customer_id: user.id,
      ...(validEmail(user.email) ? { customer_email: user.email } : {}),
      success_url: withParam(env.appUrl!, 'billing=success'),
      return_url: env.appUrl,
      metadata: { user_id: user.id },
    },
    fetchFn
  );
  if (result.ok && !httpsUrl(result.data?.url)) console.error(`polar checkout answered without a usable address: ${describeAddress(result.data?.url)}`);
  if (!result.ok || !httpsUrl(result.data?.url)) return { status: 502, body: { error: 'checkout_failed' } };
  return { status: 200, body: { url: result.data.url } };
}

export async function createPortal(admin: SupabaseClient, user: { id: string }, rawEnv: BillingEnv, fetchFn: Fetch = fetch): Promise<Answer> {
  const env = clean(rawEnv);
  if (!configured(env)) return { status: 503, body: { error: 'not_configured' } };
  const { data: row, error } = await admin.from('subscriptions').select('polar_customer_id, source').eq('user_id', user.id).maybeSingle();
  if (error) return { status: 500, body: { error: 'read_failed' } };
  if (!row || row.source !== 'polar' || typeof row.polar_customer_id !== 'string' || row.polar_customer_id === '') return { status: 409, body: { error: 'no_subscription' } };
  const result = await callPolar(env, '/customer-sessions/', { customer_id: row.polar_customer_id, return_url: env.appUrl }, fetchFn);
  if (!result.ok || !httpsUrl(result.data?.customer_portal_url)) return { status: 502, body: { error: 'portal_failed' } };
  return { status: 200, body: { url: result.data.customer_portal_url } };
}

// ---- The facts the page needs before it offers a payment: which Polar world this is, and what Pro costs (issue #24). ----
// Read from Polar itself (never typed in the page), remembered for five minutes per product and environment; a failure is never remembered.
export interface PriceFacts { amount: number; currency: string; interval: 'day' | 'week' | 'month' | 'year' }
const INFO_KEEP_MS = 5 * 60 * 1000;
const INTERVALS = ['day', 'week', 'month', 'year'];
const INFO_CACHE = new Map<string, { at: number; price: PriceFacts | null }>();

// The first price that is not archived and has a fixed amount; anything odd gives null (never a made-up price).
function readPrice(product: any): PriceFacts | null {
  const prices = Array.isArray(product?.prices) ? product.prices : [];
  for (const price of prices) {
    if (!price || typeof price !== 'object' || price.is_archived === true || price.amount_type !== 'fixed') continue;
    const amount = price.price_amount;
    const currency = price.price_currency;
    const interval = price.recurring_interval ?? product?.recurring_interval;
    if (!Number.isInteger(amount) || amount <= 0 || amount > 100_000_000) continue;
    if (typeof currency !== 'string' || !/^[A-Za-z]{3}$/.test(currency)) continue;
    if (!INTERVALS.includes(interval)) continue;
    return { amount, currency: currency.toUpperCase(), interval };
  }
  return null;
}

export async function createInfo(rawEnv: BillingEnv, fetchFn: Fetch = fetch, nowMs = Date.now(), cache: Map<string, { at: number; price: PriceFacts | null }> = INFO_CACHE): Promise<Answer> {
  const env = clean(rawEnv);
  if (!env.token || !env.productId) return { status: 503, body: { error: 'not_configured' } };
  const environment = serverKind(env.server);
  const key = `${environment}:${env.productId}`;
  const known = cache.get(key);
  if (known && nowMs - known.at <= INFO_KEEP_MS) return { status: 200, body: { environment, price: known.price } };
  let product: unknown;
  try {
    const response = await fetchFn(`${polarBase(env.server)}/products/${encodeURIComponent(env.productId)}`, { method: 'GET', headers: { Authorization: `Bearer ${env.token}` } });
    if (!response.ok) { console.error(`polar product lookup failed: ${response.status}`); return { status: 502, body: { error: 'info_failed' } }; }
    product = await response.json().catch(() => null);
  } catch {
    console.error('polar product lookup failed: network error'); // the error text can quote the header with the token, so it is left out
    return { status: 502, body: { error: 'info_failed' } };
  }
  const price = readPrice(product);
  cache.set(key, { at: nowMs, price });
  return { status: 200, body: { environment, price } };
}