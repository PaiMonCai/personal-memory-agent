import nodemailer from 'nodemailer'
import { config } from './config.js'
import { query } from './db.js'
import { decryptSystemSecret, encryptSystemSecret, sha256 } from './crypto.js'

let transporter = null
let transporterKey = ''

async function storedSmtp() {
  const { rows } = await query("select value from system_settings where key = 'smtp'")
  return rows[0]?.value && typeof rows[0].value === 'object' ? rows[0].value : null
}

export async function resolveMailConfig() {
  const stored = await storedSmtp()
  if (stored?.host) {
    return {
      host: String(stored.host || ''),
      port: Number(stored.port) || 465,
      secure: Boolean(stored.secure),
      user: String(stored.user || ''),
      pass: decryptSystemSecret(String(stored.password || '')),
      from: String(stored.from || stored.user || ''),
      source: 'database',
    }
  }

  return {
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    user: config.smtp.user,
    pass: config.smtp.pass,
    from: config.smtp.from,
    source: 'environment',
  }
}

async function getTransporter() {
  const smtp = await resolveMailConfig()
  if (!smtp.host || !smtp.user || !smtp.pass || !smtp.from) return { transport: null, smtp }

  const key = sha256(JSON.stringify([smtp.host, smtp.port, smtp.secure, smtp.user, smtp.pass]))
  if (!transporter || transporterKey !== key) {
    transporter = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: { user: smtp.user, pass: smtp.pass },
    })
    transporterKey = key
  }
  return { transport: transporter, smtp }
}

export async function getPublicMailSettings() {
  const smtp = await resolveMailConfig()
  return {
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    user: smtp.user,
    from: smtp.from,
    configured: Boolean(smtp.host && smtp.user && smtp.pass && smtp.from),
    hasPassword: Boolean(smtp.pass),
    source: smtp.source,
  }
}

export async function saveMailSettings(input) {
  const old = (await storedSmtp()) || {}
  const current = await resolveMailConfig()
  const password =
    input.password === undefined || input.password === ''
      ? String(old.password || (current.pass ? encryptSystemSecret(current.pass) : ''))
      : encryptSystemSecret(String(input.password))

  const value = {
    host: String(input.host || '').trim(),
    port: Number(input.port) || 465,
    secure: Boolean(input.secure),
    user: String(input.user || '').trim(),
    password,
    from: String(input.from || '').trim(),
  }

  await query(
    `insert into system_settings (key, value, updated_at)
     values ('smtp', $1::jsonb, now())
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [JSON.stringify(value)]
  )
  transporter = null
  transporterKey = ''
  return getPublicMailSettings()
}

export async function sendTestMail(email) {
  const { transport, smtp } = await getTransporter()
  if (!transport) throw Object.assign(new Error('SMTP 尚未配置完整'), { code: 'smtp_unavailable', status: 503 })
  await transport.sendMail({
    from: smtp.from,
    to: email,
    subject: '信息管家 SMTP 测试',
    text: 'SMTP 配置测试成功。信息管家已可以发送登录、注册与密码重置验证码。',
  })
}

export async function sendOtpMail(email, code, purpose) {
  const labels = {
    login: '登录',
    signup: '注册',
    reset: '重置密码',
  }
  const label = labels[purpose] || '验证'
  const { transport, smtp } = await getTransporter()
  if (!transport) {
    if (!config.production) {
      console.log(`[dev-otp] ${email} ${purpose}: ${code}`)
      return
    }
    throw Object.assign(new Error('SMTP 尚未配置'), { code: 'smtp_unavailable', status: 503 })
  }
  await transport.sendMail({
    from: smtp.from,
    to: email,
    subject: `信息管家 ${label}验证码`,
    text: `你的验证码是：${code}\n\n验证码将在 ${config.otpTtlMinutes} 分钟后失效。如果不是你本人操作，请忽略此邮件。`,
  })
}
