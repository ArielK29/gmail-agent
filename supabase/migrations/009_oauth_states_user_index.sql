-- Covering index for the foreign key flagged by the performance advisor (speeds up the cascade when a member is deleted).
create index if not exists gmail_oauth_states_user_idx on public.gmail_oauth_states (user_id);
