-- Which Polar world the payment buttons talk to, so the page can say "test payment, no real charge" (issue #22). Data row only.
insert into public.app_settings (key, value) values ('polar_environment', '"sandbox"'::jsonb) on conflict (key) do nothing;
