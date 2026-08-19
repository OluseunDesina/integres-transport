-- Postgres RLS (see apps.core.migration_operations.EnableRowLevelSecurity
-- and docs/specs/1-identity-client-business.md §3) is a no-op for a
-- superuser connection: superusers and BYPASSRLS-attributed roles always
-- bypass row security, full stop, regardless of FORCE ROW LEVEL SECURITY.
-- POSTGRES_USER in this compose file *is* the initdb bootstrap role, which
-- Postgres will not let anyone strip SUPERUSER from ("the bootstrap user
-- must have the SUPERUSER attribute") — so the app needs a genuinely
-- separate, ordinary role to connect as. This runs after
-- init-extensions.sql (alphabetically later, same
-- /docker-entrypoint-initdb.d/ mechanism) and only on first-time
-- initialization of an empty data volume.
CREATE ROLE integra_app LOGIN PASSWORD 'integra_app' NOSUPERUSER NOBYPASSRLS CREATEDB;

-- Postgres 15+ owns the `public` schema via the pg_database_owner
-- pseudo-role, so making integra_app the database owner is enough for it
-- to create objects there too — no separate schema GRANT needed. Every
-- table from here on is created (and owned) by integra_app itself via
-- `manage.py migrate`, so EnableRowLevelSecurity's FORCE ROW LEVEL
-- SECURITY genuinely applies to the role the app actually connects as.
ALTER DATABASE integra_afc OWNER TO integra_app;
