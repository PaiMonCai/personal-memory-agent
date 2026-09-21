import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'
import { config } from './config.js'

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url')
}

export function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex')
}

export function otpDigest(challengeId, email, code) {
  const key = config.otpPepper || 'development-only-pepper'
  return createHmac('sha256', key)
    .update(`${challengeId}|${String(email).toLowerCase()}|${code}`)
    .digest('hex')
}

export function safeEqualHex(a, b) {
  try {
    const aa = Buffer.from(String(a), 'hex')
    const bb = Buffer.from(String(b), 'hex')
    return aa.length === bb.length && timingSafeEqual(aa, bb)
  } catch {
    return false
  }
}

function encryptionKey() {
  const raw = String(config.preferencesKey || '').trim()
  if (!raw) return null
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex')
  try {
    const b = Buffer.from(raw, 'base64')
    return b.length === 32 ? b : null
  } catch {
    return null
  }
}

function seal(value) {
  if (!value) return ''
  const key = encryptionKey()
  if (!key) throw Object.assign(new Error('PREFERENCES_ENCRYPTION_KEY 未配置或格式不正确'), { code: 'config_error' })
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`
}

function open(value) {
  if (!value || typeof value !== 'string' || !value.startsWith('v1.')) return value || ''
  const key = encryptionKey()
  if (!key) throw Object.assign(new Error('无法解密自定义模型密钥：服务端缺少 PREFERENCES_ENCRYPTION_KEY'), { code: 'config_error' })
  const [, ivRaw, tagRaw, dataRaw] = value.split('.')
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivRaw, 'base64url'))
  decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'))
  return Buffer.concat([
    decipher.update(Buffer.from(dataRaw, 'base64url')),
    decipher.final(),
  ]).toString('utf8')
}

export function encryptAiSettings(ai) {
  if (!ai || typeof ai !== 'object') return ai || {}
  const custom = ai.custom && typeof ai.custom === 'object' ? ai.custom : {}
  const vendors = Array.isArray(custom.vendors)
    ? custom.vendors.map((v) => ({
        ...v,
        apiKey: v?.apiKey ? seal(v.apiKey) : '',
      }))
    : []
  return { ...ai, custom: { ...custom, vendors } }
}

export function decryptAiSettings(ai) {
  if (!ai || typeof ai !== 'object') return ai || {}
  const custom = ai.custom && typeof ai.custom === 'object' ? ai.custom : {}
  const vendors = Array.isArray(custom.vendors)
    ? custom.vendors.map((v) => ({
        ...v,
        apiKey: v?.apiKey ? open(v.apiKey) : '',
      }))
    : []
  return { ...ai, custom: { ...custom, vendors } }
}
