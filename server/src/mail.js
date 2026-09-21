import nodemailer from 'nodemailer'
import { config } from './config.js'

let transporter = null

function getTransporter() {
  if (transporter) return transporter
  if (!config.smtp.host || !config.smtp.user || !config.smtp.pass || !config.smtp.from) return null
  transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: { user: config.smtp.user, pass: config.smtp.pass },
  })
  return transporter
}

export async function sendOtpMail(email, code, purpose) {
  const labels = {
    login: '登录',
    signup: '注册',
    reset: '重置密码',
  }
  const label = labels[purpose] || '验证'
  const transport = getTransporter()
  if (!transport) {
    if (!config.production) {
      console.log(`[dev-otp] ${email} ${purpose}: ${code}`)
      return
    }
    throw Object.assign(new Error('SMTP 尚未配置'), { code: 'smtp_unavailable' })
  }
  await transport.sendMail({
    from: config.smtp.from,
    to: email,
    subject: `信息管家 ${label}验证码`,
    text: `你的验证码是：${code}\n\n验证码将在 ${config.otpTtlMinutes} 分钟后失效。如果不是你本人操作，请忽略此邮件。`,
  })
}
