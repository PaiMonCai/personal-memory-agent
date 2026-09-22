import bcrypt from 'bcryptjs'
import { randomInt } from 'node:crypto'
import { Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { config } from './config.js'
import { query, tx } from './db.js'
import { otpDigest, randomToken, safeEqualHex, sha256 } from './crypto.js'
import { sendOtpMail } from './mail.js'

export const SESSION_COOKIE = 'pma_session'

function cleanEmail(value) {
  const email = String(value || '').trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    throw apiErr(400, 'invalid_email', '邮箱格式不正确')
  }
  return email
}

function cleanPassword(value) {
  const password = String(value || '')
  if (password.length < 8 || password.length > 200) {
    throw apiErr(400, 'invalid_password', '密码长度需为 8–200 位')
  }
  return password
}

function apiErr(status, code, message) {
  return Object.assign(new Error(message), { status, code })
}

async function userByEmail(email) {
  const { rows } = await query('select id, email, password_hash, role, created_at from users where email = $1', [email])
  return rows[0] || null
}

function clientIp(c) {
  return String(c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || '').split(',')[0].trim() || null
}

async function startSession(c, userId) {
  const token = randomToken(32)
  const tokenHash = sha256(token)
  const days = config.sessionDays
  await query(
    `insert into sessions (user_id, token_hash, expires_at)
     values ($1, $2, now() + ($3 || ' days')::interval)`,
    [userId, tokenHash, String(days)]
  )
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: config.production,
    sameSite: 'Lax',
    path: '/',
    maxAge: days * 86400,
  })
}

async function consumeChallenge({ challengeId, email, code, purpose }, client) {
  const { rows } = await client.query(
    `select id, email, purpose, code_hash, expires_at, attempts, consumed_at
     from auth_codes where id = $1 for update`,
    [challengeId]
  )
  const row = rows[0]
  if (!row || row.email !== email || row.purpose !== purpose || row.consumed_at || new Date(row.expires_at) <= new Date()) {
    throw apiErr(400, 'otp_invalid', '验证码不正确或已过期')
  }
  if (row.attempts >= 5) throw apiErr(429, 'otp_invalid', '验证码尝试次数过多，请重新获取')
  const actual = otpDigest(row.id, email, code)
  if (!safeEqualHex(actual, row.code_hash)) {
    await client.query('update auth_codes set attempts = attempts + 1 where id = $1', [row.id])
    throw apiErr(400, 'otp_invalid', '验证码不正确或已过期')
  }
  await client.query('update auth_codes set consumed_at = now() where id = $1', [row.id])
  return row
}

export async function requireUser(c, next) {
  const token = getCookie(c, SESSION_COOKIE)
  if (!token) throw apiErr(401, 'unauthenticated', '请先登录')
  const { rows } = await query(
    `select u.id, u.email, u.role
     from sessions s join users u on u.id = s.user_id
     where s.token_hash = $1 and s.expires_at > now()`,
    [sha256(token)]
  )
  const user = rows[0]
  if (!user) {
    deleteCookie(c, SESSION_COOKIE, { path: '/' })
    throw apiErr(401, 'unauthenticated', '登录状态已失效')
  }
  c.set('user', user)
  await next()
}

export const authRoutes = new Hono()

authRoutes.get('/session', async (c) => {
  try {
    await requireUser(c, async () => {})
  } catch (err) {
    if (err.status === 401) return c.json({ error: { code: err.code, message: err.message } }, 401)
    throw err
  }
  return c.json({ session: { user: c.get('user') } })
})

authRoutes.post('/otp/request', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const email = cleanEmail(body.email)
  const purpose = String(body.purpose || '')
  if (!['login', 'signup', 'reset'].includes(purpose)) throw apiErr(400, 'invalid_purpose', '验证码用途不正确')

  const { rows: recent } = await query(
    `select count(*)::int as n from auth_codes
     where email = $1 and created_at > now() - interval '1 hour'`,
    [email]
  )
  if ((recent[0]?.n || 0) >= config.otpMaxPerHour) {
    throw apiErr(429, 'otp_rate_limited', '验证码发送过于频繁，请稍后再试')
  }

  const user = await userByEmail(email)
  if (purpose === 'login' && !user) {
    // 不暴露账号是否存在；照常返回成功，但不发送邮件。
    return c.json({ challengeId: randomToken(12), isExistingUser: false })
  }
  if (purpose === 'reset' && !user) {
    return c.json({ challengeId: randomToken(12), isExistingUser: false })
  }

  const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
  const id = randomToken(18)
  await query(
    `insert into auth_codes (id, email, purpose, code_hash, expires_at, request_ip)
     values ($1, $2, $3, $4, now() + ($5 || ' minutes')::interval, $6)`,
    [id, email, purpose, otpDigest(id, email, code), String(config.otpTtlMinutes), clientIp(c)]
  )
  await sendOtpMail(email, code, purpose)
  return c.json({ challengeId: id, isExistingUser: !!user })
})

authRoutes.post('/password/login', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const email = cleanEmail(body.email)
  const password = String(body.password || '')
  const user = await userByEmail(email)
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    throw apiErr(401, 'invalid_grant', '邮箱或密码不正确')
  }
  await startSession(c, user.id)
  return c.json({ user: { id: user.id, email: user.email, role: user.role } })
})

authRoutes.post('/otp/verify-login', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const email = cleanEmail(body.email)
  const code = String(body.code || '').trim()
  const challengeId = String(body.challengeId || '')
  const user = await userByEmail(email)
  if (!user) throw apiErr(400, 'otp_invalid', '验证码不正确或已过期')
  await tx((client) => consumeChallenge({ challengeId, email, code, purpose: 'login' }, client))
  await startSession(c, user.id)
  return c.json({ user: { id: user.id, email: user.email, role: user.role } })
})

authRoutes.post('/signup', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const email = cleanEmail(body.email)
  const password = cleanPassword(body.password)
  const code = String(body.code || '').trim()
  const challengeId = String(body.challengeId || '')
  if (await userByEmail(email)) throw apiErr(409, 'account_exists', '该邮箱已注册，请直接登录')

  const passwordHash = await bcrypt.hash(password, 12)
  const user = await tx(async (client) => {
    await consumeChallenge({ challengeId, email, code, purpose: 'signup' }, client)
    const { rows } = await client.query(
      'insert into users (email, password_hash) values ($1, $2) returning id, email, role',
      [email, passwordHash]
    )
    return rows[0]
  })
  await startSession(c, user.id)
  return c.json({ user: { id: user.id, email: user.email, role: user.role } })
})

authRoutes.post('/password/reset', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const email = cleanEmail(body.email)
  const password = cleanPassword(body.password)
  const code = String(body.code || '').trim()
  const challengeId = String(body.challengeId || '')
  const user = await userByEmail(email)
  if (!user) throw apiErr(400, 'otp_invalid', '验证码不正确或已过期')
  const passwordHash = await bcrypt.hash(password, 12)
  await tx(async (client) => {
    await consumeChallenge({ challengeId, email, code, purpose: 'reset' }, client)
    await client.query('update users set password_hash = $1, updated_at = now() where id = $2', [passwordHash, user.id])
    await client.query('delete from sessions where user_id = $1', [user.id])
  })
  await startSession(c, user.id)
  return c.json({ user: { id: user.id, email: user.email, role: user.role } })
})

authRoutes.post('/logout', async (c) => {
  const token = getCookie(c, SESSION_COOKIE)
  if (token) await query('delete from sessions where token_hash = $1', [sha256(token)])
  deleteCookie(c, SESSION_COOKIE, { path: '/' })
  return c.json({ ok: true })
})
