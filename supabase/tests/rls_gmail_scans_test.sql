-- Permission test for the scan tables (gmail_scans, gmail_scan_hits): two throw-away members and a stranger in ONE transaction
-- that ends with an exception, so NOTHING is kept. Every line must say good / ok or match "expect".
-- Run it with the Supabase MCP execute_sql (or the SQL editor) after ANY change to these tables, grants or policies.
do $$
declare
  a uuid := '00000000-0000-4000-8000-0000000000a3';
  b uuid := '00000000-0000-4000-8000-0000000000a4';
  sa uuid := gen_random_uuid();
  sb uuid := gen_random_uuid();
  res text := '';
  n int;
  t text;
begin
  insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at)
  select x, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', x::text || '@test.invalid', now(), now() from unnest(array[a, b]) as x;
  insert into public.gmail_scans (id, user_id, status, period_start, period_end, query_text, items, consent_at, pending_ids, total, processed)
    values (sa, a, 'running', '2026-01-01', '2026-01-31', 'invoice', '["INV-1"]', now(), '["m1","m2"]', 2, 0), (sb, b, 'done', '2026-01-01', '2026-01-31', 'x', '[]', now(), '[]', 1, 1);
  insert into public.gmail_scan_hits (scan_id, user_id, gmail_message_id, summary, matches) values (sa, a, 'm1', 'for a', '[0]'), (sb, b, 'mb', 'for b', '[]');

  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.gmail_scans;
  res := res || '1 a reads scans (expect 1, only own): ' || n || E'\n';
  select count(*) into n from public.gmail_scan_hits;
  res := res || '2 a reads hits (expect 1, only own): ' || n || E'\n';
  select status into t from public.gmail_scans;
  res := res || '3 a reads own status (expect running): ' || t || E'\n';
  begin perform pending_ids from public.gmail_scans; res := res || '4 a reads pending_ids: ALLOWED (BAD)' || E'\n';
  exception when others then res := res || '4 a reads pending_ids: denied (good)' || E'\n'; end;
  begin perform claimed_until from public.gmail_scans; res := res || '5 a reads claimed_until: ALLOWED (BAD)' || E'\n';
  exception when others then res := res || '5 a reads claimed_until: denied (good)' || E'\n'; end;
  begin perform consent_at from public.gmail_scans; res := res || '6 a reads consent_at: ALLOWED (BAD)' || E'\n';
  exception when others then res := res || '6 a reads consent_at: denied (good)' || E'\n'; end;
  begin perform * from public.gmail_scans; res := res || '7 a does select *: ALLOWED (BAD)' || E'\n';
  exception when others then res := res || '7 a does select *: denied (good)' || E'\n'; end;
  begin insert into public.gmail_scans (user_id, period_start, period_end, consent_at) values (a, '2026-01-01', '2026-01-02', now()); res := res || '8 a starts a scan directly (skipping the function and the consent check): ALLOWED (BAD)' || E'\n';
  exception when others then res := res || '8 a starts a scan directly: denied (good)' || E'\n'; end;
  begin update public.gmail_scans set status = 'done', processed = 999; res := res || '9 a edits own scan: ALLOWED (BAD)' || E'\n';
  exception when others then res := res || '9 a edits own scan: denied (good)' || E'\n'; end;
  begin insert into public.gmail_scan_hits (scan_id, user_id, gmail_message_id, summary) values (sa, a, 'forged', 'x'); res := res || '10 a writes a hit: ALLOWED (BAD)' || E'\n';
  exception when others then res := res || '10 a writes a hit: denied (good)' || E'\n'; end;
  begin update public.gmail_scan_hits set summary = 'edited'; res := res || '11 a edits a hit: ALLOWED (BAD)' || E'\n';
  exception when others then res := res || '11 a edits a hit: denied (good)' || E'\n'; end;
  delete from public.gmail_scans where id = sb;
  get diagnostics n = row_count;
  res := res || '12 a deletes the scan of b (expect 0 rows): ' || n || E'\n';
  delete from public.gmail_scan_hits where gmail_message_id = 'mb';
  get diagnostics n = row_count;
  res := res || '13 a deletes the hit of b (expect 0 rows): ' || n || E'\n';

  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', b, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.gmail_scans where user_id = a;
  res := res || '14 b sees a''s scan (expect 0): ' || n || E'\n';
  select count(*) into n from public.gmail_scan_hits where user_id = a;
  res := res || '15 b sees a''s hits (expect 0): ' || n || E'\n';
  select count(*) into n from public.gmail_scans;
  res := res || '16 b still sees own scan (expect 1): ' || n || E'\n';

  reset role;
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;
  begin perform count(*) from public.gmail_scans; res := res || '17 anon reads scans: ALLOWED (BAD)' || E'\n';
  exception when others then res := res || '17 anon reads scans: denied (good)' || E'\n'; end;
  begin perform count(*) from public.gmail_scan_hits; res := res || '18 anon reads hits: ALLOWED (BAD)' || E'\n';
  exception when others then res := res || '18 anon reads hits: denied (good)' || E'\n'; end;
  reset role;

  -- the tables' own limits (what the function could do wrongly)
  begin insert into public.gmail_scans (user_id, period_start, period_end, consent_at) values (a, '2026-02-01', '2026-01-01', now()); res := res || '19 end before start accepted (BAD)' || E'\n';
  exception when others then res := res || '19 end before start: refused (good)' || E'\n'; end;
  begin insert into public.gmail_scans (user_id, period_start, period_end, consent_at, status) values (a, '2024-12-31', '2026-01-01', now(), 'done'); res := res || '20 366-day gap (367 calendar days) accepted (BAD)' || E'\n';
  exception when others then res := res || '20 366-day gap (367 calendar days): refused (good)' || E'\n'; end;
  begin insert into public.gmail_scans (user_id, period_start, period_end, consent_at, items, status) values (a, '2026-01-01', '2026-01-02', now(), (select jsonb_agg('i' || g) from generate_series(1, 101) g), 'done'); res := res || '21 101 items accepted (BAD)' || E'\n';
  exception when others then res := res || '21 101 items: refused (good)' || E'\n'; end;
  begin insert into public.gmail_scans (user_id, period_start, period_end, consent_at, status) values (a, '2026-01-01', '2026-01-02', null, 'done'); res := res || '22 a scan without consent accepted (BAD)' || E'\n';
  exception when others then res := res || '22 a scan without a consent stamp: refused (good)' || E'\n'; end;
  begin insert into public.gmail_scans (user_id, period_start, period_end, consent_at, status) values (a, '2026-01-01', '2026-01-02', now(), 'hacked'); res := res || '23 unknown status accepted (BAD)' || E'\n';
  exception when others then res := res || '23 unknown status: refused (good)' || E'\n'; end;
  begin insert into public.gmail_scans (user_id, period_start, period_end, consent_at) values (a, '2026-03-01', '2026-03-02', now()); res := res || '23b a second ACTIVE scan for the same member accepted (BAD)' || E'\n';
  exception when unique_violation then res := res || '23b a second active scan for the same member: refused by the database (good)' || E'\n'; end;

  delete from public.gmail_scans where id = sa;
  select count(*) into n from public.gmail_scan_hits where scan_id = sa;
  res := res || '24 hits of a deleted scan are gone (expect 0): ' || n || E'\n';
  delete from auth.users where id = b;
  select (select count(*) from public.gmail_scans where user_id = b) + (select count(*) from public.gmail_scan_hits where user_id = b) into n;
  res := res || '25 after b deleted the account, rows of b left (expect 0): ' || n || E'\n';

  raise exception E'RLS_GMAIL_SCANS_TEST_RESULTS\n%', res;
end $$;