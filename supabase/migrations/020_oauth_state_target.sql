-- Issue 32: the Gmail consent can return to the mobile app's deep link instead of the web page.
-- The one-time state remembers where to return to: only the two fixed values below (the deep link itself is a server secret/setting,
-- never stored here and never taken from a request). Service role only, as before (RLS on, no policies).
alter table public.gmail_oauth_states
  add column if not exists target text not null default 'web' check (target in ('web', 'app'));