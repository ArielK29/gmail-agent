-- Permission test for the failure-counter reset trigger (migration 014): one throw-away member in ONE transaction that ends with an
-- exception, so NOTHING is kept. Expect: 17 = 3, 18 = 0, 19 denied.
do $$
declare
  a uuid := '00000000-0000-4000-8000-0000000000d3';
  res text := '';
  v text;
begin
  insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at) values (a, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', a::text || '@test.invalid', now(), now());
  insert into public.gmail_connections (user_id, google_email, refresh_token, digest_email, digest_failures) values (a, 'a@test.invalid', 's', true, 3);
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.gmail_connections set digest_tz = 'UTC';
  select digest_failures::text into v from public.gmail_connections;
  res := res || '17 changing only the zone keeps the counter (expect 3): ' || v || E'\n';
  update public.gmail_connections set digest_email = false;
  select digest_failures::text into v from public.gmail_connections;
  res := res || '18 switching off resets the counter (expect 0): ' || v || E'\n';
  begin perform public.reset_digest_failures(); res := res || '19 a calls the trigger function directly: ALLOWED (BAD)' || E'\n';
  exception when others then res := res || '19 a calls the trigger function directly: denied (good)' || E'\n'; end;
  reset role;
  raise exception E'RESULT\n%', res;
end $$;
