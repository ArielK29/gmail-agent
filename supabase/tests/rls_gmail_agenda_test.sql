-- Permission test for gmail_agenda (calendar events and tasks) and the new connection flags: two throw-away members and a stranger in ONE
-- transaction that ends with an exception, so NOTHING is kept. Every line must say good / ok or match "expect".
do $$
declare
  a uuid := '00000000-0000-4000-8000-0000000000c1';
  b uuid := '00000000-0000-4000-8000-0000000000c2';
  res text := '';
  n int;
  v text;
begin
  insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at)
  select x, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', x::text || '@test.invalid', now(), now() from unnest(array[a, b]) as x;
  insert into public.gmail_connections (user_id, google_email, refresh_token, has_calendar, has_tasks) values (a, 'a@test.invalid', 'secret-a', true, false), (b, 'b@test.invalid', 'secret-b', false, true);
  insert into public.gmail_agenda (user_id, kind, external_id, title, starts_at) values (a, 'event', 'ea', 'meeting a', now()), (b, 'event', 'eb', 'meeting b', now());
  insert into public.gmail_agenda (user_id, kind, external_id, title, day) values (a, 'task', 'ta', 'task a', current_date), (b, 'task', 'tb', 'task b', current_date);

  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.gmail_agenda;
  res := res || '1 a reads the agenda (expect 2, only own): ' || n || E'\n';
  select has_calendar::text || has_tasks::text into v from public.gmail_connections;
  res := res || '2 a reads own flags (expect truefalse): ' || v || E'\n';
  begin perform refresh_token from public.gmail_connections; res := res || '3 a reads the refresh token: ALLOWED (BAD)' || E'\n';
  exception when others then res := res || '3 a reads the refresh token: denied (good)' || E'\n'; end;
  begin insert into public.gmail_agenda (user_id, kind, external_id, title, day) values (a, 'task', 'forged', 'x', current_date); res := res || '4 a inserts an agenda row: ALLOWED (BAD)' || E'\n';
  exception when others then res := res || '4 a inserts an agenda row: denied (good)' || E'\n'; end;
  begin update public.gmail_agenda set title = 'edited'; res := res || '5 a edits an agenda row: ALLOWED (BAD)' || E'\n';
  exception when others then res := res || '5 a edits an agenda row: denied (good)' || E'\n'; end;
  begin update public.gmail_connections set has_calendar = true, has_tasks = true; res := res || '6 a edits own flags: ALLOWED (BAD)' || E'\n';
  exception when others then res := res || '6 a edits own flags: denied (good)' || E'\n'; end;
  delete from public.gmail_agenda where external_id = 'eb';
  get diagnostics n = row_count;
  res := res || '7 a deletes the event of b (expect 0 rows): ' || n || E'\n';
  delete from public.gmail_agenda where external_id = 'ea';
  get diagnostics n = row_count;
  res := res || '8 a deletes own event (expect 1 row): ' || n || E'\n';

  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', b, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.gmail_agenda where user_id = a;
  res := res || '9 b sees a''s agenda (expect 0): ' || n || E'\n';
  select count(*) into n from public.gmail_agenda;
  res := res || '10 b sees own agenda (expect 2): ' || n || E'\n';

  reset role;
  set local role anon;
  begin perform 1 from public.gmail_agenda; res := res || '11 anon reads the agenda: ALLOWED (BAD)' || E'\n';
  exception when others then res := res || '11 anon reads the agenda: denied (good)' || E'\n'; end;
  begin delete from public.gmail_agenda; res := res || '12 anon deletes agenda rows: ALLOWED (BAD)' || E'\n';
  exception when others then res := res || '12 anon deletes agenda rows: denied (good)' || E'\n'; end;

  reset role;
  begin insert into public.gmail_agenda (user_id, kind, external_id, title) values (a, 'task', 'no-day', 'x'); res := res || '13 a task without a day: ALLOWED (BAD)' || E'\n';
  exception when check_violation then res := res || '13 a task without a day: refused by the database (good)' || E'\n'; end;
  begin insert into public.gmail_agenda (user_id, kind, external_id, title, all_day, starts_at) values (a, 'event', 'no-start', 'x', false, null); res := res || '14 a timed event without a start: ALLOWED (BAD)' || E'\n';
  exception when check_violation then res := res || '14 a timed event without a start: refused (good)' || E'\n'; end;
  begin insert into public.gmail_agenda (user_id, kind, external_id, title, day) values (a, 'note', 'x', 'x', current_date); res := res || '15 an unknown kind: ALLOWED (BAD)' || E'\n';
  exception when check_violation then res := res || '15 an unknown kind: refused (good)' || E'\n'; end;
  begin insert into public.gmail_agenda (user_id, kind, external_id, title, day) values (a, 'task', 'long', repeat('x', 201), current_date); res := res || '16 a title of 201 characters: ALLOWED (BAD)' || E'\n';
  exception when check_violation then res := res || '16 a title of 201 characters: refused (good)' || E'\n'; end;
  begin insert into public.gmail_agenda (user_id, kind, external_id, title, day) values (a, 'task', 'ta', 'dup', current_date); res := res || '17 the same task twice: ALLOWED (BAD)' || E'\n';
  exception when unique_violation then res := res || '17 the same task twice: refused (good)' || E'\n'; end;
  delete from auth.users where id = b;
  select count(*) into n from public.gmail_agenda where user_id = b;
  res := res || '18 deleting member b removes their agenda (expect 0): ' || n || E'\n';
  raise exception E'RESULT\n%', res;
end $$;
