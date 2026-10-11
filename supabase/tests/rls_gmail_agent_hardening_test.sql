-- Permission test for the Gmail agent tables, in the same style as the DuoFit tests: two throw-away members and a stranger
-- inside ONE transaction that ends with an exception, so NOTHING is kept. Every line must say good / ok or match "expect".
-- Run it with the Supabase MCP execute_sql (or the SQL editor) after ANY change to the agent tables, grants or policies.
do $$
declare
  a uuid := '00000000-0000-4000-8000-0000000000a1';
  b uuid := '00000000-0000-4000-8000-0000000000a2';
  res text := '';
  n int;
  t text;
begin
  insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at)
  select x, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', x::text || '@test.invalid', now(), now() from unnest(array[a, b]) as x;
  -- as the service role (the Edge Functions): both members have a connection, digest rows, a usage row and a pending OAuth state
  insert into public.gmail_connections (user_id, google_email, refresh_token, status, history_id, last_checked_at, last_attempt_at) values
    (a, 'a@test.invalid', 'secret-token-a', 'active', '111', now(), now()), (b, 'b@test.invalid', 'secret-token-b', 'active', '222', now(), now());
  insert into public.gmail_digest (user_id, gmail_message_id, category, summary) values (a, 'ma1', 'work', 'for a'), (a, 'ma2', 'other', 'for a'), (b, 'mb1', 'work', 'for b');
  insert into public.gmail_usage (user_id, day, emails) values (a, current_date, 5), (b, current_date, 7);
  insert into public.gmail_oauth_states (state, user_id) values ('state-of-a', a);

  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.gmail_digest;
  res := res || '1 a reads the digest (expect 2, only own): ' || n || E'\n';
  select count(*) into n from public.gmail_connections;
  res := res || '2 a reads connections (expect 1, only own): ' || n || E'\n';
  select status into t from public.gmail_connections;
  res := res || '3 a reads own status column (expect active): ' || t || E'\n';
  begin perform refresh_token from public.gmail_connections; res := res || '4 a reads the refresh token: ALLOWED (BAD)' || E'\n';
  exception when others then res := res || '4 a reads the refresh token: denied (good)' || E'\n'; end;
  begin perform history_id from public.gmail_connections; res := res || '5 a reads history_id: ALLOWED (BAD)' || E'\n';
  exception when others then res := res || '5 a reads history_id: denied (good)' || E'\n'; end;
  begin perform last_attempt_at from public.gmail_connections; res := res || '6 a reads last_attempt_at: ALLOWED (BAD)' || E'\n';
  exception when others then res := res || '6 a reads last_attempt_at: denied (good)' || E'\n'; end;
  begin perform * from public.gmail_connections; res := res || '7 a does select * on connections: ALLOWED (BAD, would expose the token)' || E'\n';
  exception when others then res := res || '7 a does select * on connections: denied (good)' || E'\n'; end;
  begin update public.gmail_connections set status = 'needs_reconnect' where user_id = a; res := res || '8 a edits own connection: ALLOWED (BAD)' || E'\n';
  exception when others then res := res || '8 a edits own connection: denied (good)' || E'\n'; end;
  begin update public.gmail_connections set refresh_token = 'mine'; res := res || '9 a swaps the refresh token: ALLOWED (BAD)' || E'\n';
  exception when others then res := res || '9 a swaps the refresh token: denied (good)' || E'\n'; end;
  begin insert into public.gmail_connections (user_id, refresh_token) values (gen_random_uuid(), 'x'); res := res || '10 a creates a connection: ALLOWED (BAD)' || E'\n';
  exception when others then res := res || '10 a creates a connection: denied (good)' || E'\n'; end;
  begin delete from public.gmail_connections; res := res || '11 a deletes a connection: ALLOWED (BAD)' || E'\n';
  exception when others then res := res || '11 a deletes a connection: denied (good)' || E'\n'; end;
  begin insert into public.gmail_digest (user_id, gmail_message_id, category, summary) values (a, 'forged', 'other', 'x'); res := res || '12 a writes a digest row: ALLOWED (BAD)' || E'\n';
  exception when others then res := res || '12 a writes a digest row: denied (good)' || E'\n'; end;
  begin update public.gmail_digest set summary = 'edited'; res := res || '13 a edits a digest row: ALLOWED (BAD)' || E'\n';
  exception when others then res := res || '13 a edits a digest row: denied (good)' || E'\n'; end;
  begin perform * from public.gmail_usage; res := res || '14 a reads usage: ALLOWED (BAD)' || E'\n';
  exception when others then res := res || '14 a reads usage: denied (good)' || E'\n'; end;
  begin perform * from public.gmail_oauth_states; res := res || '15 a reads OAuth states: ALLOWED (BAD)' || E'\n';
  exception when others then res := res || '15 a reads OAuth states: denied (good)' || E'\n'; end;
  begin perform value from public.agent_secrets; res := res || '16 a reads the cron secret: ALLOWED (BAD)' || E'\n';
  exception when others then res := res || '16 a reads the cron secret: denied (good)' || E'\n'; end;
  delete from public.gmail_digest where gmail_message_id = 'mb1';
  get diagnostics n = row_count;
  res := res || '17 a deletes the digest row of b (expect 0 rows): ' || n || E'\n';
  delete from public.gmail_digest where gmail_message_id = 'ma1';
  get diagnostics n = row_count;
  res := res || '18 a deletes own digest row (expect 1 row): ' || n || E'\n';

  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', b, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.gmail_digest where user_id = a;
  res := res || '19 b sees a''s digest rows (expect 0): ' || n || E'\n';
  select count(*) into n from public.gmail_connections where user_id = a;
  res := res || '20 b sees a''s connection (expect 0): ' || n || E'\n';
  select count(*) into n from public.gmail_digest;
  res := res || '21 b still sees own digest (expect 1): ' || n || E'\n';

  reset role;
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;
  begin perform count(*) from public.gmail_digest; res := res || '22 anon reads the digest: ALLOWED (BAD)' || E'\n';
  exception when others then res := res || '22 anon reads the digest: denied (good)' || E'\n'; end;
  begin perform count(*) from public.gmail_connections; res := res || '23 anon reads connections: ALLOWED (BAD)' || E'\n';
  exception when others then res := res || '23 anon reads connections: denied (good)' || E'\n'; end;
  begin perform value from public.agent_secrets; res := res || '24 anon reads the cron secret: ALLOWED (BAD)' || E'\n';
  exception when others then res := res || '24 anon reads the cron secret: denied (good)' || E'\n'; end;
  reset role;

  -- a member leaves: everything of his goes with him, nothing of the other member is touched
  delete from auth.users where id = a;
  select (select count(*) from public.gmail_connections where user_id = a) + (select count(*) from public.gmail_digest where user_id = a)
       + (select count(*) from public.gmail_usage where user_id = a) + (select count(*) from public.gmail_oauth_states where user_id = a) into n;
  res := res || '25 after a deleted the account, rows of a left (expect 0): ' || n || E'\n';
  select count(*) into n from public.gmail_connections where user_id = b;
  res := res || '26 and the connection of b is untouched (expect 1): ' || n || E'\n';

  raise exception E'RLS_GMAIL_AGENT_TEST_RESULTS\n%', res;
end $$;