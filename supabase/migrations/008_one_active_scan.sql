-- One active scan per member, enforced by the database (two clicks at the same moment cannot start two).
create unique index if not exists gmail_scans_one_active on public.gmail_scans (user_id) where status in ('queued', 'running', 'paused');
