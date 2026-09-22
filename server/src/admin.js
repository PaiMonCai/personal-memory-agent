import bcrypt from 'bcryptjs'
import { Hono } from 'hono'
import { config } from './config.js'
import { query } from './db.js'
import { requireUser } from './auth.js'
import { getPublicMailSettings, saveMailSettings, sendTestMail } from './mail.js'

function apiErr(status, code, message) {
  return Object.assign(new Error(message), { status, code })
}

function cleanEmail(value) {
  const email = String(value || '').trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    throw apiErr(400, 'invalid_email', '邮箱格式不正确')
  }
  return email
}

export async function ensureBootstrapAdmin() {
  const { rows } = await query("select count(*)::int as n from users where role = 'admin'")
  if ((rows[0]?.n || 0) > 0) return

  const email = config.bootstrapAdminEmail
  const password = String(config.bootstrapAdminPassword || '')
  if (!email || !password) {
    console.warn('[bootstrap] 尚无管理员。请设置 BOOTSTRAP_ADMIN_EMAIL 和 BOOTSTRAP_ADMIN_PASSWORD 后重启一次。')
    return
  }
  cleanEmail(email)
  if (password.length < 8) throw new Error('BOOTSTRAP_ADMIN_PASSWORD must be at least 8 characters')
  if (bcrypt.truncates(password)) throw new Error('BOOTSTRAP_ADMIN_PASSWORD exceeds bcrypt 72-byte limit')

  const passwordHash = await bcrypt.hash(password, 12)
  await query(
    `insert into users (email, password_hash, role)
     values ($1, $2, 'admin')
     on conflict (email) do update
       set password_hash = excluded.password_hash,
           role = 'admin',
           updated_at = now()`,
    [email, passwordHash]
  )
  console.log(`[bootstrap] 管理员已初始化：${email}`)
}

export async function setupStatus() {
  const [{ rows }, mail] = await Promise.all([
    query("select count(*)::int as n from users where role = 'admin'"),
    getPublicMailSettings(),
  ])
  return {
    initialized: (rows[0]?.n || 0) > 0,
    mailConfigured: mail.configured,
  }
}

export const adminRoutes = new Hono()

adminRoutes.use('*', requireUser)
adminRoutes.use('*', async (c, next) => {
  if (c.get('user')?.role !== 'admin') throw apiErr(403, 'admin_required', '需要管理员权限')
  await next()
})

adminRoutes.get('/settings/mail', async (c) => c.json(await getPublicMailSettings()))

adminRoutes.patch('/settings/mail', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const host = String(body.host || '').trim()
  const port = Number(body.port)
  const secure = Boolean(body.secure)
  const user = String(body.user || '').trim()
  const from = String(body.from || '').trim()
  const password = body.password === undefined ? undefined : String(body.password)

  if (!host || host.length > 255) throw apiErr(400, 'invalid_smtp', 'SMTP Host 不正确')
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw apiErr(400, 'invalid_smtp', 'SMTP 端口不正确')
  if (!user || user.length > 255) throw apiErr(400, 'invalid_smtp', 'SMTP 用户名不能为空')
  if (!from || from.length > 320) throw apiErr(400, 'invalid_smtp', '发件人不能为空')
  if (password !== undefined && password.length > 1024) throw apiErr(400, 'invalid_smtp', 'SMTP 密码过长')

  return c.json(await saveMailSettings({ host, port, secure, user, password, from }))
})

adminRoutes.post('/settings/mail/test', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const email = cleanEmail(body.email || c.get('user').email)
  await sendTestMail(email)
  return c.json({ ok: true })
})
