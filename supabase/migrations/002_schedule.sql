-- Scheduled check for new emails, every 10 minutes (pg_cron calls the gmail-sync function with the shared secret).
-- Replace PROJECT_REF before running.
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'gmail-sync-every-10-min',
  '*/10 * * * *',
  $$
  select net.http_post(
    url := 'https://PROJECT_REF.supabase.co/functions/v1/gmail-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select value from public.agent_secrets where name = 'cron')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000 -- the agent needs more than the 5 s default
  );
  $$
);
