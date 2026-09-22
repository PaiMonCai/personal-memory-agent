import pg from 'pg'
import { config } from './config.js'

pg.types.setTypeParser(20, (v) => Number(v))

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
})

export async function query(text, params = []) {
  return pool.query(text, params)
}

export async function tx(fn) {
  const client = await pool.connect()
  try {
    await client.query('begin')
    const result = await fn(client)
    await client.query('commit')
    return result
  } catch (err) {
    await client.query('rollback').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

export async function pingDb() {
  await query('select 1')
}

const APP_TABLES = [
  'users',
  'system_settings',
  'sessions',
  'auth_codes',
  'entries',
  'entry_links',
  'entry_chunks',
  'reviews',
  'preferences',
  'ai_usage',
]

async function assertSchemaOwnership() {
  const { rows: who } = await query(`
    select
      current_user as current_user,
      has_schema_privilege(current_user, 'public', 'USAGE') as can_use_schema,
      has_schema_privilege(current_user, 'public', 'CREATE') as can_create_schema_objects
  `)
  const currentUser = who[0]?.current_user

  if (!who[0]?.can_use_schema || !who[0]?.can_create_schema_objects) {
    throw Object.assign(
      new Error(
        `数据库用户 ${currentUser || '(unknown)'} 缺少 public schema 的 USAGE/CREATE 权限。请使用 DATABASE_URL 对应的应用用户初始化数据库，或由数据库管理员授予 USAGE, CREATE ON SCHEMA public。`
      ),
      { code: 'schema_privilege_mismatch' }
    )
  }

  const { rows: objects } = await query(
    `
      with app_tables as (
        select c.oid, c.relname, pg_get_userbyid(c.relowner) as owner
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relkind in ('r', 'p')
          and c.relname = any($1::text[])
      ),
      app_sequences as (
        select distinct seq.relname, pg_get_userbyid(seq.relowner) as owner
        from pg_class seq
        join pg_namespace n on n.oid = seq.relnamespace
        join pg_depend d on d.objid = seq.oid and d.deptype in ('a', 'i')
        join pg_class tbl on tbl.oid = d.refobjid
        where n.nspname = 'public'
          and seq.relkind = 'S'
          and tbl.relname = any($1::text[])
      )
      select 'table' as kind, relname as name, owner from app_tables
      union all
      select 'sequence' as kind, relname as name, owner from app_sequences
      order by kind, name
    `,
    [APP_TABLES]
  )

  const mismatched = objects.filter((x) => x.owner !== currentUser)
  if (!mismatched.length) return

  const detail = mismatched.map((x) => `${x.kind} ${x.name} -> ${x.owner}`).join(', ')
  throw Object.assign(
    new Error(
      `数据库对象 owner 与 DATABASE_URL 用户不一致。当前用户：${currentUser}；不一致对象：${detail}。请用同一个应用用户执行 database/001_baseline.sql；已有数据库可由超级用户运行 database/repair_ownership.sql 修复。`
    ),
    { code: 'schema_owner_mismatch', currentUser, mismatched }
  )
}

export async function ensureSchema() {
  await assertSchemaOwnership()
  await query("alter table users add column if not exists role text not null default 'user'")
  await query("create index if not exists users_role_idx on users(role)")
  await query(`
    create table if not exists system_settings (
      key text primary key,
      value jsonb not null default '{}'::jsonb,
      updated_at timestamptz not null default now()
    )
  `)
}
