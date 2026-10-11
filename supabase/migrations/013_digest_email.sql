-- Morning briefing by e-mail (issue #14). The member switches it on from the page (two columns they may write); the rest is
-- written only by the Edge Function. The recipient is always the member's own connected Google address, never a typed one.
alter table public.gmail_connections
  add column if not exists digest_email boolean not null default false,
  add column if not exists digest_tz text check (digest_tz is null or (char_length(digest_tz) <= 64 and digest_tz ~ '^[A-Za-z_]+(/[A-Za-z0-9_+-]+){0,2}$')),
  add column if not exists digest_last_sent_on date,
  add column if not exists digest_failures integer not null default 0 check (digest_failures >= 0);
grant select (digest_email, digest_tz, digest_last_sent_on, digest_failures) on public.gmail_connections to authenticated;
grant update (digest_email, digest_tz) on public.gmail_connections to authenticated;
create policy gmail_connections_update_own on public.gmail_connections
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
