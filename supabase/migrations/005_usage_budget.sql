-- How many emails the agent summarized for a member today (UTC date). Service role only: the browser never touches it.
create table public.gmail_usage (
  user_id uuid not null references auth.users (id) on delete cascade,
  day date not null,
  emails integer not null default 0 check (emails >= 0),
  primary key (user_id, day)
);
alter table public.gmail_usage enable row level security;
revoke all on public.gmail_usage from anon, authenticated;
