-- Throw-away member for browser end-to-end runs of the Gmail agent page. Run each block on its own through the
-- Supabase MCP execute_sql (or the SQL editor). NEVER type a password on the live site: sign in only on
-- http://localhost:5174 (node dev-server.js). Ask the owner before any test that spends model quota or touches real rows.
--
-- Fixed ids on purpose, so the cleanup block can only ever remove this one member:
--   user id  00000000-0000-4000-8000-0000000000bb
--   e-mail   e2e-browser-test@invalid.example

-- 1. SEED. Replace <PASSWORD> with a fresh random value for every run (never reuse, never commit a real one).
with u as (
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change)
  values ('00000000-0000-4000-8000-0000000000bb', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'e2e-browser-test@invalid.example', extensions.crypt('<PASSWORD>', extensions.gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', '')
  returning id),
i as (
  insert into auth.identities (id, user_id, identity_data, provider, provider_id, created_at, updated_at, last_sign_in_at)
  select gen_random_uuid(), id, json_build_object('sub', id::text, 'email', 'e2e-browser-test@invalid.example', 'email_verified', true)::jsonb, 'email', id::text, now(), now(), now() from u
  returning 1),
c as (
  insert into public.gmail_connections (user_id, google_email, refresh_token, status, last_checked_at, history_id)
  select id, 'e2e-browser-test@invalid.example', 'bogus-refresh-token-for-e2e-test', 'active', now() - interval '1 hour', '1' from u
  returning 1),
d as (
  insert into public.gmail_digest (user_id, gmail_message_id, from_name, subject, category, summary, urgency, suggested_action, received_at)
  select u.id, x.mid, x.sender, x.subj, x.cat, x.summ, x.urg, x.act, now() - x.age
  from u, (values
    ('e2e-1', 'בנק בדיקה <bank@example.com>', 'חיוב חריג', 'finance', 'חיוב חריג בכרטיס האשראי.', 'high', 'בדוק את החיוב', interval '0 hours'),
    ('e2e-2', 'חנות <promo@example.com>', 'מבצע', 'promotion', 'מבצע על מוצרים.', 'low', null, interval '1 hour'),
    ('e2e-3', 'חבר <friend@example.com>', 'נפגשים?', 'personal', 'חבר שואל אם נפגשים.', null, null, interval '2 hours')
  ) as x(mid, sender, subj, cat, summ, urg, act, age)
  returning 1)
select (select count(*) from u) as member, (select count(*) from i) as identity, (select count(*) from c) as connection, (select count(*) from d) as digest_rows;

-- 2. CLEANUP. Always run at the end (it cascades to the connection, digest and usage rows of this member only).
delete from auth.users where id = '00000000-0000-4000-8000-0000000000bb' and email = 'e2e-browser-test@invalid.example';

-- 3. CHECK that nothing is left. Expected: users = 1 (the owner), connections = 1, owner's digest rows unchanged,
--    no leftover test trigger or function (some runs create e2e_block / e2e_block_delete to make deletes fail on purpose).
select (select count(*) from auth.users) as users,
       (select count(*) from public.gmail_connections) as connections,
       (select count(*) from public.gmail_digest) as digest_rows,
       (select count(*) from pg_trigger where tgname = 'e2e_block') as leftover_trigger,
       (select count(*) from pg_proc where proname = 'e2e_block_delete') as leftover_function;

-- OPTIONAL. Make deletes of digest rows fail on purpose (to test that the page and the function report a failed delete).
-- Create it only while the test runs and DROP it right away: it also blocks the owner's own deletes while it exists.
--   create function public.e2e_block_delete() returns trigger language plpgsql as $$ begin raise exception 'e2e: delete blocked on purpose'; end $$;
--   create trigger e2e_block before delete on public.gmail_digest for each row execute function public.e2e_block_delete();
--   drop trigger e2e_block on public.gmail_digest; drop function public.e2e_block_delete();
