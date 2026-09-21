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
