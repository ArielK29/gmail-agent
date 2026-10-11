-- Permission test for the e-mail briefing switch on gmail_connections: two throw-away members in ONE transaction that ends with an
-- exception, so NOTHING is kept. Every line must say good / ok or match "expect".
do $$
declare
  a uuid := '00000000-0000-4000-8000-0000000000d1';
  b uuid := '00000000-0000-4000-8000-0000000000d2';
  res text := '';
  n int;
  v text;
begin
  insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at)
  select x, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', x::text || '@test.invalid', now(), now() from unnest(array[a, b]) as x;
  insert into public.gmail_connections (user_id, google_email, refresh_token) values (a, 'a@test.invalid', 'secret-a'), (b, 'b@test.invalid', 'secret-b');

  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.gmail_connections set digest_email = true, digest_tz = 'Asia/Jerusalem';
  get diagnostics n = row_count;
  res := res || '1 a switches the e-mail on for self (expect 1 row, not b): ' || n || E'\n';
  select digest_email::text || digest_tz into v from public.gmail_connections;
  res := res || '2 a reads own switch (expect trueAsia/Jerusalem): ' || v || E'\n';
  update public.gmail_connections set digest_email = false where user_id = b;
  get diagnostics n = row_count;
  res := res || '3 a switches b (expect 0 rows): ' || n || E'\n';
  begin update public.gmail_connections set refresh_token = 'stolen'; res := res || '4 a edits the refresh token: ALLOWED (BAD)' || E'\n';
  exception when others then res := res || '4 a edits the refresh token: denied (good)' || E'\n'; end;
  begin update public.gmail_connections set digest_last_sent_on = current_date; res := res || '5 a edits digest_last_sent_on: ALLOWED (BAD)' || E'\n';
  exception when others then res := res || '5 a edits digest_last_sent_on: denied (good)' || E'\n'; end;
  begin update public.gmail_connections set digest_failures = 0; res := res || '6 a resets the failure counter: ALLOWED (BAD)' || E'\n';
  exception when others then res := res || '6 a resets the failure counter: denied (good)' || E'\n'; end;
  begin update public.gmail_connections set google_email = 'victim@example.com'; res := res || '7 a changes the recipient address: ALLOWED (BAD)' || E'\n';
  exception when others then res := res || '7 a changes the recipient address: denied (good)' || E'\n'; end;
  begin update public.gmail_connections set status = 'active', has_calendar = true, user_id = b; res := res || '8 a edits status / flags / owner: ALLOWED (BAD)' || E'\n';
  exception when others then res := res || '8 a edits status / flags / owner: denied (good)' || E'\n'; end;
  begin update public.gmail_connections set digest_tz = 'x; drop table y'; res := res || '9 a sets a bad time zone text: ALLOWED (BAD)' || E'\n';
  exception when check_violation then res := res || '9 a sets a bad time zone text: refused by the database (good)' || E'\n'; end;
  begin update public.gmail_connections set digest_tz = repeat('A', 65); res := res || '10 a sets a 65-character zone: ALLOWED (BAD)' || E'\n';
  exception when check_violation then res := res || '10 a sets a 65-character zone: refused (good)' || E'\n'; end;
  begin insert into public.gmail_connections (user_id, google_email, refresh_token) values (a, 'x@test.invalid', 'y'); res := res || '11 a inserts a connection: ALLOWED (BAD)' || E'\n';
  exception when others then res := res || '11 a inserts a connection: denied (good)' || E'\n'; end;
  begin delete from public.gmail_connections; res := res || '12 a deletes the connection directly: ALLOWED (BAD)' || E'\n';
  exception when others then res := res || '12 a deletes the connection directly: denied (good)' || E'\n'; end;
  begin perform refresh_token from public.gmail_connections; res := res || '13 a reads the refresh token: ALLOWED (BAD)' || E'\n';
  exception when others then res := res || '13 a reads the refresh token: denied (good)' || E'\n'; end;

  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', b, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.gmail_connections;
  res := res || '14 b sees only own connection (expect 1): ' || n || E'\n';
  select digest_email::text into v from public.gmail_connections;
  res := res || '15 b still switched off (expect false): ' || v || E'\n';

  reset role;
  set local role anon;
  begin update public.gmail_connections set digest_email = true; res := res || '16 anon switches the e-mail on: ALLOWED (BAD)' || E'\n';
  exception when others then res := res || '16 anon switches the e-mail on: denied (good)' || E'\n'; end;
  reset role;
  raise exception E'RESULT\n%', res;
end $$;
-- Lines 17-19 (the failure counter reset trigger) are in rls_gmail_digest_email_trigger_test.sql