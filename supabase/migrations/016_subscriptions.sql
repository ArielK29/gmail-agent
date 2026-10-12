-- Subscriptions with Polar (issue #22). `subscriptions` is written ONLY by the polar-webhook Edge Function (service role) and, for
-- manual grants to the owner or testers, by the owner through SQL (source = 'manual': a webhook never overwrites such a row).
-- A member may read only their own row and only the columns below (never the Polar ids).
create table public.subscriptions (
  user_id uuid primary key references auth.users (id) on delete cascade,
  source text not null default 'polar' check (source in ('polar', 'manual')),
  plan text not null default 'pro' check (plan in ('pro')),
  status text not null check (status in ('incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid')),
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  polar_customer_id text check (char_length(polar_customer_id) <= 100),
  polar_subscription_id text unique check (char_length(polar_subscription_id) <= 100),
  polar_modified_at timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.subscriptions enable row level security;
revoke all on public.subscriptions from anon, authenticated;
grant select (user_id, plan, status, current_period_end, cancel_at_period_end, source) on public.subscriptions to authenticated;
create policy subscriptions_select_own on public.subscriptions for select to authenticated using (user_id = (select auth.uid()));

-- Webhook ids already processed (Polar may deliver the same event more than once). Server only.
create table public.polar_events (
  webhook_id text primary key check (char_length(webhook_id) between 1 and 200),
  type text not null check (char_length(type) <= 100),
  received_at timestamptz not null default now()
);
alter table public.polar_events enable row level security;
revoke all on public.polar_events from anon, authenticated;
create index polar_events_received_idx on public.polar_events (received_at);
