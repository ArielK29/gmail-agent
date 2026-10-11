-- "Handled" marking (agent 1, v2). The member may set ONLY handled_at on their own rows; everything else stays server-written.
alter table public.gmail_digest add column if not exists handled_at timestamptz;
grant update (handled_at) on public.gmail_digest to authenticated;
create policy gmail_digest_update_own on public.gmail_digest
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
