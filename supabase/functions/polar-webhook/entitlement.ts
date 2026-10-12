// Who may use the Pro features (issue #22). Pure, no Deno and no network. THE SAME FILE lives in gmail-sync, polar-webhook and
// polar-billing (a function can only import its own folder); the test in polar-webhook/webhook.test.ts fails when the copies differ.
export const GRACE_MS = 3 * 24 * 3600 * 1000; // a late renewal message never cuts a paying member off at midnight

export interface SubscriptionLike { status?: unknown; current_period_end?: unknown }

const DAY_END = (value: unknown): number => (typeof value === 'string' ? Date.parse(value) : NaN);

// Pro = a live subscription. `active` and `trialing` count until the period end plus the grace (so a missed "revoked" message
// cannot keep somebody Pro forever); `past_due` (a failed payment being retried) only inside the grace; everything else is Free.
// A row with no period end (a manual grant by the owner) never runs out.
export function isPro(row: SubscriptionLike | null | undefined, nowMs: number): boolean {
  if (!row || typeof row !== 'object') return false;
  const end = DAY_END(row.current_period_end);
  const inside = !Number.isFinite(end) || nowMs <= end + GRACE_MS;
  if (row.status === 'active' || row.status === 'trialing') return inside;
  if (row.status === 'past_due') return Number.isFinite(end) && nowMs <= end + GRACE_MS;
  return false;
}

// While billing is not enforced (the testers phase) everybody has everything. Only a real `true` switches enforcement on.
export function hasProAccess(billingEnforced: unknown, row: SubscriptionLike | null | undefined, nowMs: number): boolean {
  return billingEnforced !== true || isPro(row, nowMs);
}

// Which Polar world a subscription row belongs to. Only the exact word `production` means production (a typo falls to the safe
// side: sandbox). Rows written by the webhook carry this tag in `polar_server`; a row without a tag came from before the tag existed,
// when only the sandbox was in use.
export type PolarKind = 'sandbox' | 'production';
export const serverKind = (server: string | undefined | null): PolarKind => (server === 'production' ? 'production' : 'sandbox');

// A subscription row written for the OTHER Polar environment is not a subscription here (sandbox test data must never give Pro
// in production, and the reverse). The owner's manual grants (`source = 'manual'`) count everywhere.
export function liveRow<T extends { source?: unknown; polar_server?: unknown }>(row: T | null | undefined, server: string | undefined | null): T | null {
  if (!row || typeof row !== 'object') return null;
  if (row.source === 'manual') return row;
  const tagged: PolarKind = row.polar_server === 'production' ? 'production' : 'sandbox';
  return tagged === serverKind(server) ? row : null;
}