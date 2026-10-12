-- Permission test for subscriptions, polar_events and app_settings: two throw-away members in ONE transaction that ends with an
-- exception, so NOTHING is kept. Every line must say good / ok or match "expect".
do $$
declare
  a uuid := '00000000-0000-4000-8000-0000000000e1';
  b uuid := '00000000-0000-4000-8000-0000000000e2';
  res text := '';
  n int;
  v text;
begin
  insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at)
  select x, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', x::text || '@test.invalid', now(), now() from unnest(array[a, b]) as x;
  insert into public.subscriptions (user_id, status, polar_customer_id, polar_subscription_id) values (a, 'active', 'cust-a', 'sub-a'), (b, 'canceled', 'cust-b', 'sub-b');
  insert into public.polar_events (webhook_id, type) values ('evt-1', 'subscription.active');

  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.subscriptions;
  res := res || '1 a reads subscriptions (expect 1, only own): ' || n || E'\n';
  select status into v from public.subscriptions;
  res := res || '2 a reads own status (expect active): ' || v || E'\n';
  begin perform polar_customer_id from public.subscriptions; res := res || '3 a reads the Polar customer id: ALLOWED (BAD)' || E'\n';
  exception when others then res := res || '3 a reads the Polar customer id: denied (good)' || E'\n'; end;
  begin perform polar_subscription_id from public.subscriptions; res := res || '4 a reads the Polar subscription id: ALLOWED (BAD)' || E'\n';
  exception when others then res := res || '4 a reads the Polar subscription id: denied (good)' || E'\n'; end;
  begin perform * from public.subscriptions; res := res || '5 a does select *: ALLOWED (BAD)' || E'\n';
  exception when others then res := res || '5 a does select *: denied (good)' || E'\n'; end;
  begin update public.subscriptions set status = 'active', current_period_end = now() + interval '1 year'; res := res || '6 a upgrades self: ALLOWED (BAD)' || E'\n';
  exception when others then res := res || '6 a upgrades self: denied (good)' || E'\n'; end;
  begin insert into public.subscriptions (user_id, status, source) values (a, 'active', 'manual'); res := res || '7 a inserts a manual grant: ALLOWED (BAD)' || E'\n';
  exception when others then res := res || '7 a inserts a manual grant: denied (good)' || E'\n'; end;
  begin delete from public.subscriptions; res := res || '8 a deletes subscriptions: ALLOWED (BAD)' || E'\n';
  exception when others then res := res || '8 a deletes subscriptions: denied (good)' || E'\n'; end;
  begin perform 1 from public.polar_events; res := res || '9 a reads webhook ids: ALLOWED (BAD)' || E'\n';
  exception when others then res := res || '9 a reads webhook ids: denied (good)' || E'\n'; end;
  begin insert into public.polar_events (webhook_id, type) values ('forged', 'x'); res := res || '10 a writes a webhook id: ALLOWED (BAD)' || E'\n';
  exception when others then res := res || '10 a writes a webhook id: denied (good)' || E'\n'; end;
  select value::text into v from public.app_settings where key = 'billing_enforced';
  res := res || '11 a reads the billing switch (expect false): ' || v || E'\n';
  begin update public.app_settings set value = 'true'::jsonb; res := res || '12 a flips the billing switch: ALLOWED (BAD)' || E'\n';
  exception when others then res := res || '12 a flips the billing switch: denied (good)' || E'\n'; end;
  begin insert into public.app_settings (key, value) values ('x', '1'::jsonb); res := res || '13 a adds a setting: ALLOWED (BAD)' || E'\n';
  exception when others then res := res || '13 a adds a setting: denied (good)' || E'\n'; end;

  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', b, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.subscriptions where user_id = a;
  res := res || '14 b sees a''s subscription (expect 0): ' || n || E'\n';
  select status into v from public.subscriptions;
  res := res || '15 b sees only own (expect canceled): ' || v || E'\n';

  reset role;
  set local role anon;
  begin perform 1 from public.subscriptions; res := res || '16 anon reads subscriptions: ALLOWED (BAD)' || E'\n';
  exception when others then res := res || '16 anon reads subscriptions: denied (good)' || E'\n'; end;
  begin perform 1 from public.app_settings; res := res || '17 anon reads settings: ALLOWED (BAD)' || E'\n';
  exception when others then res := res || '17 anon reads settings: denied (good)' || E'\n'; end;
  reset role;
  begin insert into public.subscriptions (user_id, status) values (gen_random_uuid(), 'active'); res := res || '18 a subscription for a member that does not exist: ALLOWED (BAD)' || E'\n';
  exception when foreign_key_violation then res := res || '18 a subscription for a member that does not exist: refused (good)' || E'\n'; end;
  begin insert into public.subscriptions (user_id, status) values (a, 'vip'); res := res || '19 an unknown status: ALLOWED (BAD)' || E'\n';
  exception when others then res := res || '19 an unknown status: refused (good)' || E'\n'; end;
  begin insert into public.subscriptions (user_id, status, polar_subscription_id) values (b, 'active', 'sub-a'); res := res || '20 the same Polar subscription for two members: ALLOWED (BAD)' || E'\n';
  exception when others then res := res || '20 the same Polar subscription for two members: refused (good)' || E'\n'; end;
  delete from auth.users where id = b;
  select count(*) into n from public.subscriptions where user_id = b;
  res := res || '21 deleting member b removes the subscription (expect 0): ' || n || E'\n';
  raise exception E'RESULT\n%', res;
end $$;