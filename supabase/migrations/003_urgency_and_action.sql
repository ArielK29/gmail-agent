-- Urgency and a suggested action for each summarized email (both written by the agent, never the email body).
-- Older rows stay without them (null): the page shows them as "not rated".
alter table public.gmail_digest
  add column urgency text check (urgency in ('high', 'normal', 'low')),
  add column suggested_action text check (char_length(suggested_action) <= 200);

-- Table-level select/delete grants from 001 already cover the new columns; RLS policies are unchanged (own rows only).
