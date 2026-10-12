-- "Send me a test e-mail now" (issue #14): the time of the last test, written only by the Edge Function (limits the button to once per 10 minutes).
alter table public.gmail_connections add column if not exists digest_test_at timestamptz;
