// Starting a payment and opening the customer portal (issue #22). The member's own session is the only way in; the Polar access
// token stays on the server. The id we give Polar as `external_customer_id` is the member's own id, so the webhook can find the
// member again. Card details never reach us: the member pays on Polar's page.
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { isPro } from './entitlement.ts';

export interface BillingEnv { token?: string; productId?: string; server?: string; appUrl?: string }
export interface Answer { status: number; body: Record<string, unknown> }
type Fetch = typeof fetch;

// Sandbox is the default on purpose: real money needs a deliberate POLAR_SERVER=production.
export const polarBase = (server: string | undefined): string => (server === 'production' ? 'https://api.polar.sh/v1' : 'https://sandbox-api.polar.sh/v1');
const configured = (env: BillingEnv): boolean => Boolean(env.token && env.productId && env.appUrl && /^https:\/\//.test(env.appUrl));
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
    return { ok: response.ok, data: await response.json().catch(() => ({})) };
  } catch {
    return { ok: false, data: {} };
  }
}

export async function createCheckout(admin: SupabaseClient, user: { id: string; email?: string | null }, plan: unknown, env: BillingEnv, nowMs = Date.now(), fetchFn: Fetch = fetch): Promise<Answer> {
  if (plan !== 'pro') return { status: 400, body: { error: 'unknown_plan' } }; // only plans we know; the member cannot pick a product or a price
  if (!configured(env)) return { status: 503, body: { error: 'not_configured' } };
  const { data: current, error } = await admin.from('subscriptions').select('status, current_period_end').eq('user_id', user.id).maybeSingle();
  if (error) return { status: 500, body: { error: 'read_failed' } };
  // Anyone who still has a live subscription (also trialing, or past_due while the card is being retried) must not buy a second one;
  // they manage the existing one in the portal.
  if (isPro(current, nowMs)) return { status: 409, body: { error: 'already_subscribed' } };
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
  if (!result.ok || !httpsUrl(result.data?.url)) return { status: 502, body: { error: 'checkout_failed' } };
  return { status: 200, body: { url: result.data.url } };
}

export async function createPortal(admin: SupabaseClient, user: { id: string }, env: BillingEnv, fetchFn: Fetch = fetch): Promise<Answer> {
  if (!configured(env)) return { status: 503, body: { error: 'not_configured' } };
  const { data: row, error } = await admin.from('subscriptions').select('polar_customer_id, source').eq('user_id', user.id).maybeSingle();
  if (error) return { status: 500, body: { error: 'read_failed' } };
  if (!row || row.source !== 'polar' || typeof row.polar_customer_id !== 'string' || row.polar_customer_id === '') return { status: 409, body: { error: 'no_subscription' } };
  const result = await callPolar(env, '/customer-sessions/', { customer_id: row.polar_customer_id, return_url: env.appUrl }, fetchFn);
  if (!result.ok || !httpsUrl(result.data?.customer_portal_url)) return { status: 502, body: { error: 'portal_failed' } };
  return { status: 200, body: { url: result.data.customer_portal_url } };
}