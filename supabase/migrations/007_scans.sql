-- On-demand scan and cross-check (issue #15). Job table + one row per scanned mail. Written only by the Edge Functions
-- (service role); the member can read and delete his own rows. Internal columns (pending_ids, claimed_until, listed) are not readable.
create table public.gmail_scans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  status text not null default 'queued' check (status in ('queued', 'running', 'paused', 'done', 'failed', 'cancelled')),
  period_start date not null,
  period_end date not null,
  query_text text not null default '' check (char_length(query_text) <= 200),
  items jsonb not null default '[]'::jsonb check (jsonb_typeof(items) = 'array' and jsonb_array_length(items) <= 100),
  consent_at timestamptz not null,
  pending_ids jsonb not null default '[]'::jsonb check (jsonb_typeof(pending_ids) = 'array' and jsonb_array_length(pending_ids) <= 200),
  listed boolean not null default false,
  total int not null default 0 check (total between 0 and 200),
  processed int not null default 0 check (processed >= 0),
  error text check (char_length(error) <= 60),
  claimed_until timestamptz,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  expires_at timestamptz not null default now() + interval '30 days',
  check (period_start <= period_end),
  check (period_end - period_start <= 365)
);
create index gmail_scans_user_idx on public.gmail_scans (user_id, created_at desc);

create table public.gmail_scan_hits (
  scan_id uuid not null references public.gmail_scans (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  gmail_message_id text not null,
  from_name text check (char_length(from_name) <= 200),
  subject text check (char_length(subject) <= 300),
  received_at timestamptz,
  summary text not null check (char_length(summary) <= 400),
  matches jsonb not null default '[]'::jsonb check (jsonb_typeof(matches) = 'array' and jsonb_array_length(matches) <= 100),
  primary key (scan_id, gmail_message_id)
);
create index gmail_scan_hits_user_idx on public.gmail_scan_hits (user_id);

alter table public.gmail_scans enable row level security;
alter table public.gmail_scan_hits enable row level security;
revoke all on public.gmail_scans, public.gmail_scan_hits from anon, authenticated;
grant select (id, user_id, status, period_start, period_end, query_text, items, total, processed, error, created_at, finished_at, expires_at) on public.gmail_scans to authenticated;
grant delete on public.gmail_scans to authenticated;
grant select, delete on public.gmail_scan_hits to authenticated;
create policy gmail_scans_select_own on public.gmail_scans for select to authenticated using ((select auth.uid()) = user_id);
create policy gmail_scans_delete_own on public.gmail_scans for delete to authenticated using ((select auth.uid()) = user_id);
create policy gmail_scan_hits_select_own on public.gmail_scan_hits for select to authenticated using ((select auth.uid()) = user_id);
create policy gmail_scan_hits_delete_own on public.gmail_scan_hits for delete to authenticated using ((select auth.uid()) = user_id);