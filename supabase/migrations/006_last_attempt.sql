-- Every attempt (success or failure) is stamped, so the "check now" cooldown also holds while the model keeps failing.
-- last_checked_at keeps meaning "last successful check" (it is shown on the page). Service role only: no grant to the browser.
alter table public.gmail_connections add column if not exists last_attempt_at timestamptz;
