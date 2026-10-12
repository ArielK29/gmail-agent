-- The OWNER's own end-to-end payment window (sandbox). Run each block through the Supabase MCP / SQL editor. Never leave block 1 on.
-- Owner member: c232e075-a282-4a2a-9ef8-acdbe3c6b691 (arielkorman7@gmail.com), normally with a MANUAL Pro grant (webhooks never overwrite a manual grant,
-- so for a real payment the grant is taken away for the window and put back afterwards).

-- 1. PREPARE (only for the window): billing on, the manual grant removed -> the owner is a normal Free member.
update public.app_settings set value = 'true'::jsonb, updated_at = now() where key = 'billing_enforced';
delete from public.subscriptions where user_id = 'c232e075-a282-4a2a-9ef8-acdbe3c6b691' and source = 'manual';

-- 2. WATCH while the owner pays (what the webhook did, newest first, and the member's state).
select received_at, type, outcome, reason, subscription_status, current_period_end from public.polar_events order by received_at desc limit 15;
select user_id, source, status, cancel_at_period_end, current_period_end, polar_server, polar_subscription_id is not null as has_polar_sub from public.subscriptions;

-- 3. RESTORE (always at the end): billing off, the manual Pro grant back, the sandbox subscription row gone.
update public.app_settings set value = 'false'::jsonb, updated_at = now() where key = 'billing_enforced';
insert into public.subscriptions (user_id, source, plan, status, current_period_end, cancel_at_period_end, updated_at)
values ('c232e075-a282-4a2a-9ef8-acdbe3c6b691', 'manual', 'pro', 'active', null, false, now())
on conflict (user_id) do update set source = 'manual', plan = 'pro', status = 'active', current_period_end = null, cancel_at_period_end = false,
  polar_customer_id = null, polar_subscription_id = null, polar_modified_at = null, polar_server = null, updated_at = now();
-- check: select user_id, source, status, current_period_end from public.subscriptions; select value from public.app_settings where key = 'billing_enforced';