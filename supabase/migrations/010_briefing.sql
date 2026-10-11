-- Morning briefing (issue #16). New facts about each saved mail, written only by the Edge Functions.
alter table public.gmail_digest
  add column if not exists thread_id text check (char_length(thread_id) <= 64),
  add column if not exists due_date date,
  add column if not exists needs_reply boolean,
  add column if not exists reply_checked_at timestamptz;
create index if not exists gmail_digest_due_idx on public.gmail_digest (user_id, due_date) where due_date is not null;
create index if not exists gmail_digest_reply_idx on public.gmail_digest (user_id, thread_id) where thread_id is not null;