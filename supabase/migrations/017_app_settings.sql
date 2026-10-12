-- Global settings the owner flips with one SQL line (the browser can read them, nobody but the owner and the Edge Functions can write).
-- billing_enforced = false (the testers phase): every member gets every feature for free; true: Free and Pro are enforced.
create table public.app_settings (
  key text primary key check (char_length(key) <= 60),
  value jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.app_settings enable row level security;
revoke all on public.app_settings from anon, authenticated;
grant select on public.app_settings to authenticated;
create policy app_settings_select on public.app_settings for select to authenticated using (true);
insert into public.app_settings (key, value) values ('billing_enforced', 'false'::jsonb);
