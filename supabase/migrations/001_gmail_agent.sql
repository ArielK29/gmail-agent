-- Gmail agent (exercise). Tables for the Gmail connection and the digest of new emails.
-- Security: the Gmail refresh token and the secrets are never readable by the browser; only the Edge Functions
-- (service role) touch them. The browser can read its own digest and the connection status (no token column).

create table public.gmail_connections (
  user_id uuid primary key references auth.users (id) on delete cascade,
  google_email text,
  refresh_token text not null,
  history_id text,                 -- Gmail history position: everything after it is "new"
  last_checked_at timestamptz,
  connected_at timestamptz not null default now()
);

create table public.gmail_oauth_states (
  state text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

-- One row per email the agent looked at. Only metadata + the model's category and short summary are saved,
-- never the body of the email.
create table public.gmail_digest (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  gmail_message_id text not null,
  from_name text check (char_length(from_name) <= 200),
  subject text check (char_length(subject) <= 300),
  category text not null check (category in ('important', 'personal', 'work', 'finance', 'newsletter', 'promotion', 'notification', 'other')),
  summary text not null check (char_length(summary) <= 400),
  received_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, gmail_message_id)
);
create index gmail_digest_user_idx on public.gmail_digest (user_id, received_at desc);

-- Shared secret for the scheduled run (generated here, never leaves the database and the function).
create table public.agent_secrets (
  name text primary key,
  value text not null
);
insert into public.agent_secrets (name, value) values ('cron', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''));

alter table public.gmail_connections enable row level security;
alter table public.gmail_oauth_states enable row level security;
alter table public.gmail_digest enable row level security;
alter table public.agent_secrets enable row level security;

revoke all on public.gmail_connections, public.gmail_oauth_states, public.gmail_digest, public.agent_secrets from anon, authenticated;

-- Connection status for the page: no token column. Disconnecting goes through the gmail-disconnect function
-- (it also revokes the token at Google).
grant select (user_id, google_email, last_checked_at, connected_at) on public.gmail_connections to authenticated;
create policy gmail_connections_select_own on public.gmail_connections
  for select to authenticated using (user_id = (select auth.uid()));

grant select, delete on public.gmail_digest to authenticated;
create policy gmail_digest_select_own on public.gmail_digest
  for select to authenticated using (user_id = (select auth.uid()));
create policy gmail_digest_delete_own on public.gmail_digest
  for delete to authenticated using (user_id = (select auth.uid()));
-- gmail_oauth_states and agent_secrets: RLS on, no policies, no grants -> service role only.
