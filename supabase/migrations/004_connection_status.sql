-- A connection whose Google access died (revoked, or expired after 7 days in Testing mode) is kept and marked,
-- instead of being deleted, so the page can say what happened. The scheduled run only looks at 'active' connections.
alter table public.gmail_connections
  add column status text not null default 'active' check (status in ('active', 'needs_reconnect'));

grant select (status) on public.gmail_connections to authenticated;
