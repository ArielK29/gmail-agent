-- Calendar and tasks in the morning briefing (issue #20). Written only by the Edge Functions; the member can read and delete.
alter table public.gmail_connections
  add column if not exists has_calendar boolean not null default false,
  add column if not exists has_tasks boolean not null default false,
  add column if not exists agenda_checked_at timestamptz;
grant select (has_calendar, has_tasks, agenda_checked_at) on public.gmail_connections to authenticated;

create table public.gmail_agenda (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('event', 'task')),
  external_id text not null check (char_length(external_id) between 1 and 256),
  title text not null check (char_length(title) <= 200),
  starts_at timestamptz,            -- timed events
  ends_at timestamptz,
  all_day boolean not null default false,
  day date,                         -- all-day events and tasks (the due day)
  created_at timestamptz not null default now(),
  unique (user_id, kind, external_id),
  check ((kind = 'task' and day is not null) or (kind = 'event' and all_day and day is not null and starts_at is null) or (kind = 'event' and not all_day and starts_at is not null))
);
create index gmail_agenda_user_idx on public.gmail_agenda (user_id, kind, starts_at);

alter table public.gmail_agenda enable row level security;
revoke all on public.gmail_agenda from anon, authenticated;
grant select, delete on public.gmail_agenda to authenticated;
create policy gmail_agenda_select_own on public.gmail_agenda for select to authenticated using (user_id = (select auth.uid()));
create policy gmail_agenda_delete_own on public.gmail_agenda for delete to authenticated using (user_id = (select auth.uid()));
