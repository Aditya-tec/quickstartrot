-- What a Supabase project already has and the P1/P6 migrations assume (roles anon, authenticated,
-- service_role; Supabase's default grants on the public schema). Test database only.
CREATE ROLE anon NOLOGIN NOINHERIT;
CREATE ROLE authenticated NOLOGIN NOINHERIT;
CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
-- Supabase grants everything to these roles on new objects by default; migration 0001 revokes it again,
-- which is exactly the behaviour the RLS tests depend on.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
