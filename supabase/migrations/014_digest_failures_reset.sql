-- Switching the e-mail briefing off and on again gives it a fresh start: the failure counter is reset by the database itself
-- (the member cannot write that column). Runs as the caller; it only changes the row being written.
create or replace function public.reset_digest_failures() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.digest_email is distinct from old.digest_email then
    new.digest_failures := 0;
  end if;
  return new;
end $$;
revoke execute on function public.reset_digest_failures() from public, anon, authenticated;
create trigger gmail_connections_reset_digest_failures
  before update of digest_email on public.gmail_connections
  for each row execute function public.reset_digest_failures();
