-- RLS / permission checks for the Gmail agent tables. Every block rolls back, nothing is changed.
-- Run each block on its own (the Supabase SQL editor or the MCP execute_sql). Replace <REAL_USER_ID> with a real auth user id.
-- Last run: 2026-10-11 on project ppkbuyiatkxpfeqmvwzb. All results matched the "expected" lines.

-- 1. anonymous user cannot read the digest. Expected: ERROR 42501 permission denied for table gmail_digest
begin; set local role anon; select count(*) from public.gmail_digest; rollback;

-- 2. a signed-in stranger sees nothing. Expected: 0 and 0
begin; set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid()::text, 'role', 'authenticated')::text, true);
select (select count(*) from public.gmail_digest) as other_user_digest_rows, (select count(*) from public.gmail_connections) as other_user_connection_rows;
rollback;

-- 3. the Gmail refresh token column is not readable by a member. Expected: ERROR 42501 permission denied for table gmail_connections
begin; set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', '<REAL_USER_ID>', 'role', 'authenticated')::text, true);
select refresh_token from public.gmail_connections;
rollback;

-- 4. a member sees only his own rows. Expected: own_digest_rows > 0, own_connection_rows = 1
begin; set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', '<REAL_USER_ID>', 'role', 'authenticated')::text, true);
select (select count(*) from public.gmail_digest) as own_digest_rows, (select count(*) from public.gmail_connections) as own_connection_rows;
rollback;

-- 5. the cron secret table is service-role only. Expected: ERROR 42501 permission denied for table agent_secrets
begin; set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', '<REAL_USER_ID>', 'role', 'authenticated')::text, true);
select value from public.agent_secrets;
rollback;

-- 6. a member cannot change his connection status or write digest rows himself. Expected: ERROR 42501 (UPDATE gmail_connections / INSERT gmail_digest)
begin; set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', '<REAL_USER_ID>', 'role', 'authenticated')::text, true);
update public.gmail_connections set status = 'active';
rollback;
begin; set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', '<REAL_USER_ID>', 'role', 'authenticated')::text, true);
insert into public.gmail_digest (user_id, gmail_message_id, category, summary) values ('<REAL_USER_ID>', 'fake', 'other', 'x');
rollback;

-- 7. the daily usage table is service-role only. Expected: ERROR 42501 permission denied for table gmail_usage (as anon and as a member)
begin; set local role anon; select * from public.gmail_usage; rollback;
begin; set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', '<REAL_USER_ID>', 'role', 'authenticated')::text, true);
select * from public.gmail_usage;
rollback;
