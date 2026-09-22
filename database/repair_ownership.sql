-- Repair Personal Memory Agent objects that were created by the wrong PostgreSQL role.
-- Run with a database administrator / superuser:
--
--   psql -U postgres -d pma -v app_user=pma -f database/repair_ownership.sql
--
-- Only Personal Memory Agent tables and their owned identity/serial sequences are changed.

\set ON_ERROR_STOP on

\if :{?app_user}
\else
\echo 'Missing -v app_user=<DATABASE_URL user>'
\quit 1
\endif

select format(
  'ALTER TABLE public.%I OWNER TO %I;',
  c.relname,
  :'app_user'
)
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind in ('r', 'p')
  and c.relname = any(array[
    'users',
    'system_settings',
    'sessions',
    'auth_codes',
    'entries',
    'entry_links',
    'entry_chunks',
    'reviews',
    'preferences',
    'ai_usage'
  ])
  and pg_get_userbyid(c.relowner) <> :'app_user'
order by c.relname
\gexec

select format(
  'ALTER SEQUENCE public.%I OWNER TO %I;',
  seq.relname,
  :'app_user'
)
from pg_class seq
join pg_namespace n on n.oid = seq.relnamespace
join pg_depend d on d.objid = seq.oid and d.deptype in ('a', 'i')
join pg_class tbl on tbl.oid = d.refobjid
where n.nspname = 'public'
  and seq.relkind = 'S'
  and tbl.relname = any(array[
    'users',
    'system_settings',
    'sessions',
    'auth_codes',
    'entries',
    'entry_links',
    'entry_chunks',
    'reviews',
    'preferences',
    'ai_usage'
  ])
  and pg_get_userbyid(seq.relowner) <> :'app_user'
order by seq.relname
\gexec

grant usage, create on schema public to :"app_user";

select format(
  'GRANT ALL PRIVILEGES ON TABLE public.%I TO %I;',
  c.relname,
  :'app_user'
)
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind in ('r', 'p')
  and c.relname = any(array[
    'users',
    'system_settings',
    'sessions',
    'auth_codes',
    'entries',
    'entry_links',
    'entry_chunks',
    'reviews',
    'preferences',
    'ai_usage'
  ])
order by c.relname
\gexec

select format(
  'GRANT ALL PRIVILEGES ON SEQUENCE public.%I TO %I;',
  seq.relname,
  :'app_user'
)
from pg_class seq
join pg_namespace n on n.oid = seq.relnamespace
join pg_depend d on d.objid = seq.oid and d.deptype in ('a', 'i')
join pg_class tbl on tbl.oid = d.refobjid
where n.nspname = 'public'
  and seq.relkind = 'S'
  and tbl.relname = any(array[
    'users',
    'system_settings',
    'sessions',
    'auth_codes',
    'entries',
    'entry_links',
    'entry_chunks',
    'reviews',
    'preferences',
    'ai_usage'
  ])
order by seq.relname
\gexec

\echo 'Ownership repair completed.'
