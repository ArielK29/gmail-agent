-- Issue #24: the outcome of every finished Polar webhook message, and the Polar environment a subscription row comes from.
-- Server only: no policy and no grant for members (RLS stays on, `polar_events` has no grants for anon/authenticated).
alter table public.polar_events
  add column if not exists outcome text check (outcome in ('applied', 'ignored')),
  add column if not exists reason text check (char_length(reason) <= 100),
  add column if not exists user_id uuid references auth.users (id) on delete set null,
  add column if not exists subscription_status text check (char_length(subscription_status) <= 40),
  add column if not exists current_period_end timestamptz;
create index if not exists polar_events_user_idx on public.polar_events (user_id);

-- Which Polar world wrote the row: only the exact words below. A row from the other world never gives access (entitlement.ts).
-- Rows that already exist were all written in the sandbox (production was never connected).
alter table public.subscriptions add column if not exists polar_server text check (polar_server in ('sandbox', 'production'));
update public.subscriptions set polar_server = 'sandbox' where source = 'polar' and polar_server is null;
-- Members still read only their own row and only the columns granted in migration 016 (polar_server is NOT one of them).