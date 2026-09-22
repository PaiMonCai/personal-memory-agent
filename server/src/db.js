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


export async function ensureSchema() {
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
