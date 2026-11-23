\set ON_ERROR_STOP on

-- PostgreSQL's entrypoint runs this only on an empty PGDATA.
BEGIN;
\i /readnovel/migrations/001_init_schema_v3_2.sql
\i /readnovel/migrations/002_add_user_status.sql
\i /readnovel/migrations/003_reading_progress_evidence.sql
\i /readnovel/migrations/004_bookmark_removal.sql
\i /readnovel/seeds/dev_seed.sql

-- Local readiness gate. Mark completion only after the schema and seed succeed.
CREATE TABLE public.readnovel_local_bootstrap (version integer PRIMARY KEY);
INSERT INTO public.readnovel_local_bootstrap VALUES (4);
COMMIT;
