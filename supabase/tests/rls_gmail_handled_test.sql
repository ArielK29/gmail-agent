-- Permission test for "handled" marking on gmail_digest: two throw-away members in ONE transaction that ends with an exception,
-- so NOTHING is kept. Every line must say good / ok or match "expect".
do $$
declare
  a uuid := '00000000-0000-4000-8000-0000000000b1';
  b uuid := '00000000-0000-4000-8000-0000000000b2';
  res text := '';
  n int;
  t text;
begin
  insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at)
  select x, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', x::text || '@test.invalid', now(), now() from unnest(array[a, b]) as x;
  insert into public.gmail_digest (user_id, gmail_message_id, category, summary, from_name, subject)
    values (a, 'ma', 'work', 'for a', 'x', 'y'), (b, 'mb', 'work', 'for b', 'x', 'y');

  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.gmail_digest set handled_at = now() where gmail_message_id = 'ma';
  get diagnostics n = row_count;
  res := res || '1 a marks own mail handled (expect 1 row): ' || n || E'\n';
  update public.gmail_digest set handled_at = null where gmail_message_id = 'ma';
  get diagnostics n = row_count;
  res := res || '2 a unmarks own mail (expect 1 row): ' || n || E'\n';
  update public.gmail_digest set handled_at = now() where gmail_message_id = 'mb';
  get diagnostics n = row_count;
  res := res || '3 a marks the mail of b (expect 0 rows): ' || n || E'\n';
  begin update public.gmail_digest set summary = 'forged' where gmail_message_id = 'ma'; res := res || '4 a edits the summary: ALLOWED (BAD)' || E'\n';
  exception when others then res := res || '4 a edits the summary: denied (good)' || E'\n'; end;
  begin update public.gmail_digest set needs_reply = true where gmail_message_id = 'ma'; res := res || '5 a edits needs_reply: ALLOWED (BAD)' || E'\n';
  exception when others then res := res || '5 a edits needs_reply: denied (good)' || E'\n'; end;
  begin update public.gmail_digest set due_date = '2030-01-01' where gmail_message_id = 'ma'; res := res || '6 a edits due_date: ALLOWED (BAD)' || E'\n';
  exception when others then res := res || '6 a edits due_date: denied (good)' || E'\n'; end;
  begin update public.gmail_digest set user_id = b where gmail_message_id = 'ma'; res := res || '7 a gives the mail to b: ALLOWED (BAD)' || E'\n';
  exception when others then res := res || '7 a gives the mail to b: denied (good)' || E'\n'; end;
  begin insert into public.gmail_digest (user_id, gmail_message_id, category, summary) values (a, 'forged', 'work', 'x'); res := res || '8 a inserts a row: ALLOWED (BAD)' || E'\n';
  exception when others then res := res || '8 a inserts a row: denied (good)' || E'\n'; end;
  select count(*) into n from public.gmail_digest;
  res := res || '9 a still sees only own mails (expect 1): ' || n || E'\n';

  reset role;
  set local role anon;
  begin update public.gmail_digest set handled_at = now(); res := res || '10 anon marks a mail: ALLOWED (BAD)' || E'\n';
  exception when others then res := res || '10 anon marks a mail: denied (good)' || E'\n'; end;
  reset role;
  select handled_at is null into t from public.gmail_digest where gmail_message_id = 'mb';
  res := res || '11 the mail of b is untouched (expect true): ' || t || E'\n';
  raise exception E'RESULT\n%', res;
end $$;
