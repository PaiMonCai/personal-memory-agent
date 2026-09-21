const env = process.env

function int(name, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(env[name])
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(n)))
}

export const config = {
  port: int('PORT', 3000, 1, 65535),
  production: env.NODE_ENV === 'production',
  appOrigin: String(env.APP_ORIGIN || '').replace(/\/$/, ''),
  databaseUrl: env.DATABASE_URL || 'postgres://pma:pma@127.0.0.1:5432/pma',
  sessionDays: int('SESSION_DAYS', 30, 1, 365),
  otpPepper: env.OTP_PEPPER || '',
  otpTtlMinutes: int('OTP_TTL_MINUTES', 10, 2, 60),
  otpMaxPerHour: int('OTP_MAX_PER_HOUR', 5, 1, 30),
  smtp: {
    host: env.SMTP_HOST || '',
    port: int('SMTP_PORT', 465, 1, 65535),
    secure: String(env.SMTP_SECURE || 'true').toLowerCase() !== 'false',
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
    from: env.MAIL_FROM || env.SMTP_USER || '',
  },
  ai: {
    baseUrl: String(env.AI_BASE_URL || '').replace(/\/$/, ''),
    apiKey: env.AI_API_KEY || '',
    models: String(env.AI_MODELS || '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean),
    dailyLimit: int('AI_DAILY_LIMIT', 200, 1, 100000),
  },
  preferencesKey: env.PREFERENCES_ENCRYPTION_KEY || '',
}

export function assertRuntimeConfig() {
  if (!config.databaseUrl) throw new Error('DATABASE_URL is required')
  if (config.production && !config.otpPepper) throw new Error('OTP_PEPPER is required in production')
  if (config.production && !config.appOrigin) throw new Error('APP_ORIGIN is required in production')
}
