import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { secureHeaders } from 'hono/secure-headers'
import { config, assertRuntimeConfig } from './config.js'
import { pingDb, pool } from './db.js'
import { authRoutes, requireUser } from './auth.js'
import { dataRoutes } from './data.js'
import { aiRoutes } from './ai.js'

assertRuntimeConfig()

const app = new Hono()
app.use('*', secureHeaders())

app.use('/api/*', async (c, next) => {
  const method = c.req.method.toUpperCase()
  if (config.appOrigin && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    const origin = String(c.req.header('origin') || '').replace(/\/$/, '')
    if (origin !== config.appOrigin) {
      return c.json({ error: { code: 'origin_denied', message: '请求来源不被允许' } }, 403)
    }
  }
  await next()
})

app.get('/api/health', async (c) => {
  await pingDb()
  return c.json({ ok: true })
})

app.route('/api/auth', authRoutes)

const protectedApi = new Hono()
protectedApi.use('*', requireUser)
protectedApi.route('/', dataRoutes)
protectedApi.route('/ai', aiRoutes)
app.route('/api', protectedApi)

app.notFound((c) => c.json({ error: { code: 'not_found', message: '接口不存在' } }, 404))

app.onError((err, c) => {
  if (err?.name === 'AbortError') return new Response(null, { status: 499 })
  const status = Number(err?.status) || 500
  const code = err?.code || 'internal_error'
  if (status >= 500) console.error('[server-error]', err)
  return c.json(
    { error: { code, message: status >= 500 && code === 'internal_error' ? '服务器内部错误' : err.message } },
    status
  )
})

const server = serve({ fetch: app.fetch, port: config.port }, () => {
  console.log(`[pma] API listening on :${config.port}`)
})

async function shutdown(signal) {
  console.log(`[pma] ${signal}, shutting down`)
  server.close()
  await pool.end().catch(() => {})
  process.exit(0)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
