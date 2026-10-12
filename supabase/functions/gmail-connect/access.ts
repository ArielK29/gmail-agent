// Who may use the Pro features, as the server sees it (issue #22). While billing is not enforced (the testers phase,
// `app_settings.billing_enforced` = false) everybody has everything. A failed read means "cannot decide" (null): a member's own
// request is refused with a clear message, a background job simply skips that member this time. Nothing is ever deleted or
// granted because of a failed read.
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { hasProAccess, liveRow } from './entitlement.ts';

// Which Polar environment this deployment talks to (a row written for the other one never counts, see entitlement.ts).
const currentServer = (): string | undefined => (globalThis as any).Deno?.env?.get?.('POLAR_SERVER');

async function billingEnforced(admin: SupabaseClient): Promise<boolean | null> {
  const { data, error } = await admin.from('app_settings').select('value').eq('key', 'billing_enforced').maybeSingle();
  if (error) return null;
  return data?.value === true;
}

export async function memberHasPro(admin: SupabaseClient, userId: string, nowMs: number): Promise<boolean | null> {
  const enforced = await billingEnforced(admin);
  if (enforced === null) return null;
  if (!enforced) return true;
  const { data, error } = await admin.from('subscriptions').select('status, current_period_end, source, polar_server').eq('user_id', userId).maybeSingle();
  if (error) return null;
  return hasProAccess(true, liveRow(data, currentServer()), nowMs);
}

export async function membersWithPro(admin: SupabaseClient, userIds: string[], nowMs: number): Promise<Set<string> | null> {
  const enforced = await billingEnforced(admin);
  if (enforced === null) return null;
  if (!enforced) return new Set(userIds);
  if (userIds.length === 0) return new Set();
  const { data, error } = await admin.from('subscriptions').select('user_id, status, current_period_end, source, polar_server').in('user_id', userIds);
  if (error) return null;
  const server = currentServer();
  return new Set((data ?? []).filter((row: { status: string; current_period_end: string | null; source?: string; polar_server?: string }) => hasProAccess(true, liveRow(row, server), nowMs)).map((row: { user_id: string }) => row.user_id));
}