// "Delete my account" (issue #26). Order matters, and nothing irreversible happens before the step that could fail for reasons outside
// our control:
//  1. read what we hold about the member's Polar customer (a failed read stops everything: we could not tell whether somebody is billed)
//  2. delete the Polar customer FIRST, anonymized (Polar then also ends the subscription, so nobody is billed after they are gone);
//     "already gone" (404) counts as done; any other answer stops the whole deletion and nothing is deleted
//  3. the Gmail data (summaries, scans, calendar and tasks, the connection) and the subscription row
//  4. the Google token (best effort: the answer tells whether Google confirmed)
//  5. the member
// Every step can simply be tried again after a failure: a customer that is already gone is fine, deletes of nothing are fine.
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

export interface Answer { status: number; body: Record<string, unknown> }
export interface AccountEnv { token?: string; server?: string }
export interface Deps { fetchFn?: typeof fetch; deleteUser: (id: string) => Promise<{ error: unknown }>; revokeGoogle?: (token: string) => Promise<boolean> }

// Same rule as in the billing function (a test compares them): sandbox unless the server setting is exactly `production`.
export const polarBase = (server: string | undefined): string => (server === 'production' ? 'https://api.polar.sh/v1' : 'https://sandbox-api.polar.sh/v1');

const revokeAtGoogle = (token: string): Promise<boolean> =>
  fetch('https://oauth2.googleapis.com/revoke', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }) })
    .then((response) => response.ok)
    .catch(() => false);

const DATA_TABLES = ['gmail_digest', 'gmail_scans', 'gmail_agenda', 'gmail_connections', 'subscriptions'];

export async function deleteAccount(admin: SupabaseClient, user: { id: string }, body: unknown, env: AccountEnv, deps: Deps): Promise<Answer> {
  if (!body || typeof body !== 'object' || (body as { confirm?: unknown }).confirm !== true) return { status: 400, body: { error: 'confirm_required' } };
  const fetchFn = deps.fetchFn ?? fetch;

  const { data: subscription, error: readError } = await admin.from('subscriptions').select('source, polar_customer_id').eq('user_id', user.id).maybeSingle();
  if (readError) { console.error('delete account: could not read the subscription'); return { status: 500, body: { error: 'read_failed' } }; }
  const { data: connection } = await admin.from('gmail_connections').select('refresh_token').eq('user_id', user.id).maybeSingle();

  // 2. the Polar customer (only a paying member's Polar subscription row has one; the owner's manual grant never touches Polar)
  const customerId = subscription?.source === 'polar' && typeof subscription.polar_customer_id === 'string' && subscription.polar_customer_id.trim() !== '' ? subscription.polar_customer_id.trim() : null;
  if (customerId) {
    const token = env.token?.trim();
    if (!token) return { status: 503, body: { error: 'not_configured' } };
    try {
      const response = await fetchFn(`${polarBase(env.server)}/customers/${encodeURIComponent(customerId)}?anonymize=true`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok && response.status !== 404) {
        console.error(`delete account: Polar refused to delete the customer (${response.status})`); // never the answer, never a header
        return { status: 502, body: { error: 'customer_delete_failed' } };
      }
    } catch {
      console.error('delete account: Polar could not be reached'); // the error text can quote the header with the token, so it is left out
      return { status: 502, body: { error: 'customer_delete_failed' } };
    }
  }

  // 3. the member's data (a failure stops here: the member stays, so the deletion can be retried)
  for (const table of DATA_TABLES) {
    const removed = await admin.from(table).delete().eq('user_id', user.id);
    if (removed.error) { console.error(`delete account: could not delete ${table}`); return { status: 500, body: { error: 'delete_failed' } }; }
  }

  // 4. the Google token
  const revoked = connection?.refresh_token ? await (deps.revokeGoogle ?? revokeAtGoogle)(connection.refresh_token) : true;

  // 5. the member
  const gone = await deps.deleteUser(user.id);
  if (gone.error) { console.error('delete account: could not delete the member'); return { status: 500, body: { error: 'delete_failed' } }; }
  return { status: 200, body: { ok: true, revoked } };
}
