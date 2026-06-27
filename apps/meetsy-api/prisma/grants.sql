-- Meetsy least-privilege DB role + schema grants (checked-in; applied by an
-- operator out-of-band, NOT by Meetsy migrations).
--
-- Run ONCE as a superuser / the DB owner against the shared `clickup_sync` DB,
-- BEFORE `prisma migrate deploy` for meetsy-api. Meetsy connects as this role via
-- MEETSY_DATABASE_URL. It owns/manages the `meetsy` schema but has ONLY read
-- access to the three Clicksy `public` tables it needs — never write — so the
-- read-only boundary is DB-enforced, not just convention.

-- 1) The login role Meetsy connects as.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'meetsy') THEN
    CREATE ROLE meetsy LOGIN PASSWORD 'CHANGE_ME';  -- set via secret storage
  END IF;
END
$$;

-- 2) Meetsy owns its own schema (create + alter its tables via migrations).
CREATE SCHEMA IF NOT EXISTS meetsy AUTHORIZATION meetsy;
GRANT USAGE, CREATE ON SCHEMA meetsy TO meetsy;

-- 3) Read-only access to the public schema. USAGE lets it resolve objects;
--    SELECT is granted ONLY on the three tables Meetsy reads. No CREATE on
--    public, no INSERT/UPDATE/DELETE anywhere in public.
GRANT USAGE ON SCHEMA public TO meetsy;
GRANT SELECT ON public.users, public.sessions, public.workspaces TO meetsy;

-- Intentionally NOT granted: any write on public.*, CREATE on public,
-- or REFERENCES (so no cross-schema FK can be added). Phase 2 will add
-- SELECT on public.clickup_tasks / clickup_task_events / clickup_time_entries.
