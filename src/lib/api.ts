/**
 * 自建后端 API 客户端。
 *
 * 浏览器只访问同源 /api；数据库密码、会话令牌、SMTP 与默认 AI Key
 * 全部留在服务器。认证使用 HttpOnly Cookie，前端不持有 access token。
 */

export const APP_CONFIG = {
  apiBase: import.meta.env.VITE_API_BASE || '/api',
} as const

export const APP_INFO = {
  name: '信息管家',
  tagline: '零散想法、资料与待办的统一收件箱',
} as const

const API = String(APP_CONFIG.apiBase).replace(/\/+$/, '')

export interface ApiError extends Error {
  code: string
  status: number
}

function apiError(status: number, payload: unknown, fallback?: string): ApiError {
  const info = (payload && typeof payload === 'object' ? (payload as { error?: Record<string, unknown> }).error : null) || {}
  const err = new Error(String(info.message || fallback || `请求失败（${status}）`)) as ApiError
  err.code = String(info.code || (status === 401 ? 'unauthenticated' : `http_${status}`))
  err.status = status
  return err
}

export async function request<T = unknown>(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const { method = 'GET', body, signal } = options
  let res: Response
  try {
    res = await fetch(`${API}${path}`, {
      method,
      credentials: 'include',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    })
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw err
    const e = new Error(`连接自建服务失败：${(err as Error)?.message || '网络错误'}`) as ApiError
    e.code = 'network'
    e.status = 0
    throw e
  }

  const ctype = res.headers?.get?.('content-type') || ''
  const payload = ctype.includes('application/json')
    ? await res.json().catch(() => null)
    : await res.text().catch(() => '')

  if (!res.ok) throw apiError(res.status, payload)
  return payload as T
}

/** 兼容旧调用点：把抛错转成 { data, error } 信封 */
function wrapped<T>(promise: Promise<T>): Promise<{ data: T | null; error: ApiError | null }> {
  return promise.then((data) => ({ data, error: null })).catch((error) => ({ data: null, error }))
}

/* ------------------------------------------------------------------ 认证 */

export interface SessionUser {
  id: string
  email: string
  role: 'admin' | 'user' | string
}

export interface Session {
  user: SessionUser
}

export async function getSession(): Promise<Session | null> {
  try {
    const data = await request<{ session?: Session }>('/auth/session')
    return data?.session || null
  } catch (err) {
    const e = err as ApiError
    if (e?.status === 401 || e?.code === 'unauthenticated') return null
    throw err
  }
}

export const auth = {
  signInWithPassword: (email: string, password: string) =>
    wrapped(request<{ user: SessionUser }>('/auth/password/login', { method: 'POST', body: { email, password } })),

  signInWithOtp: async (email: string) => {
    try {
      const challenge = await request<{ challengeId: string }>('/auth/otp/request', {
        method: 'POST',
        body: { email, purpose: 'login' },
      })
      return {
        data: {
          verify: ({ token }: { token: string }) =>
            wrapped(
              request<{ user: SessionUser }>('/auth/otp/verify-login', {
                method: 'POST',
                body: { email, code: token, challengeId: challenge.challengeId },
              })
            ),
        },
        error: null,
      }
    } catch (error) {
      return { data: null, error: error as ApiError }
    }
  },

  sendOtp: async (email: string) => {
    try {
      const challenge = await request<{ challengeId: string; isExistingUser: boolean }>('/auth/otp/request', {
        method: 'POST',
        body: { email, purpose: 'signup' },
      })
      return {
        data: {
          verificationId: challenge.challengeId,
          isExistingUser: !!challenge.isExistingUser,
        },
        error: null,
      }
    } catch (error) {
      return { data: null, error: error as ApiError }
    }
  },

  verifyOtp: (payload: {
    verificationId: string
    token: string
    email: string
    isExistingUser: boolean
    password?: string
  }) =>
    wrapped(
      request<{ user: SessionUser }>('/auth/signup', {
        method: 'POST',
        body: {
          email: payload.email,
          code: payload.token,
          password: payload.password,
          challengeId: payload.verificationId,
        },
      })
    ),

  resetPasswordForEmail: async (email: string) => {
    try {
      const challenge = await request<{ challengeId: string }>('/auth/otp/request', {
        method: 'POST',
        body: { email, purpose: 'reset' },
      })
      return {
        data: {
          updateUser: ({ nonce, password }: { nonce: string; password: string }) =>
            wrapped(
              request<{ user: SessionUser }>('/auth/password/reset', {
                method: 'POST',
                body: { email, code: nonce, password, challengeId: challenge.challengeId },
              })
            ),
        },
        error: null,
      }
    } catch (error) {
      return { data: null, error: error as ApiError }
    }
  },

  signOut: () => wrapped(request('/auth/logout', { method: 'POST' })),
}


export interface AdminMailSettings {
  host: string
  port: number
  secure: boolean
  user: string
  from: string
  configured: boolean
  hasPassword: boolean
  source: 'database' | 'environment'
}

export const admin = {
  getMail: () => request<AdminMailSettings>('/admin/settings/mail'),
  saveMail: (payload: {
    host: string
    port: number
    secure: boolean
    user: string
    password?: string
    from: string
  }) => request<AdminMailSettings>('/admin/settings/mail', { method: 'PATCH', body: payload }),
  testMail: (email?: string) =>
    request<{ ok: boolean }>('/admin/settings/mail/test', {
      method: 'POST',
      body: email ? { email } : {},
    }),
}
