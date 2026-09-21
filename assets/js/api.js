/**
 * 自建后端 API 客户端。
 *
 * 浏览器只访问同源 /api；数据库密码、会话令牌、SMTP 与默认 AI Key
 * 全部留在服务器。认证使用 HttpOnly Cookie，前端不持有 access token。
 */
import { APP_CONFIG } from './config.js?v=20260922t'

const API = String(APP_CONFIG.apiBase || '/api').replace(/\/$/, '')

function apiError(status, payload, fallback) {
  const info = payload?.error || payload || {}
  const err = new Error(info.message || fallback || `请求失败（${status}）`)
  err.code = info.code || (status === 401 ? 'unauthenticated' : `http_${status}`)
  err.status = status
  return err
}

async function request(path, { method = 'GET', body, signal } = {}) {
  let res
  try {
    res = await fetch(`${API}${path}`, {
      method,
      credentials: 'include',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    })
  } catch (err) {
    if (err?.name === 'AbortError') throw err
    const e = new Error(`连接自建服务失败：${err?.message || '网络错误'}`)
    e.code = 'network'
    throw e
  }

  const ctype = res.headers?.get?.('content-type') || ''
  const payload = ctype.includes('application/json')
    ? await res.json().catch(() => null)
    : await res.text().catch(() => '')

  if (!res.ok) throw apiError(res.status, payload)
  return payload
}

function wrapped(promise) {
  return promise.then((data) => ({ data, error: null })).catch((error) => ({ data: null, error }))
}

/* ------------------------------------------------------------------ 认证 */

export async function getSession() {
  try {
    const data = await request('/auth/session')
    return data?.session || null
  } catch (err) {
    if (err?.status === 401 || err?.code === 'unauthenticated') return null
    throw err
  }
}

export const auth = {
  signInWithPassword: (email, password) =>
    wrapped(request('/auth/password/login', { method: 'POST', body: { email, password } })),

  signInWithOtp: async (email) => {
    try {
      const challenge = await request('/auth/otp/request', {
        method: 'POST',
        body: { email, purpose: 'login' },
      })
      return {
        data: {
          verify: ({ token }) =>
            wrapped(
              request('/auth/otp/verify-login', {
                method: 'POST',
                body: { email, code: token, challengeId: challenge.challengeId },
              })
            ),
        },
        error: null,
      }
    } catch (error) {
      return { data: null, error }
    }
  },

  sendOtp: async (email) => {
    try {
      const challenge = await request('/auth/otp/request', {
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
      return { data: null, error }
    }
  },

  verifyOtp: (payload) =>
    wrapped(
      request('/auth/signup', {
        method: 'POST',
        body: {
          email: payload.email,
          code: payload.token,
          password: payload.password,
          challengeId: payload.verificationId,
        },
      })
    ),

  resetPasswordForEmail: async (email) => {
    try {
      const challenge = await request('/auth/otp/request', {
        method: 'POST',
        body: { email, purpose: 'reset' },
      })
      return {
        data: {
          updateUser: ({ nonce, password }) =>
            wrapped(
              request('/auth/password/reset', {
                method: 'POST',
                body: { email, code: nonce, password, challengeId: challenge.challengeId },
              })
            ),
        },
        error: null,
      }
    } catch (error) {
      return { data: null, error }
    }
  },

  signOut: () => wrapped(request('/auth/logout', { method: 'POST' })),
}

/* ------------------------------------------------------------------ 数据 */

export async function listEntries(limit = 300) {
  return request(`/entries?limit=${Math.max(1, Math.min(Number(limit) || 300, 500))}`)
}

export async function searchEntries({ keyword = '', kind = null, status = null } = {}) {
  const q = new URLSearchParams()
  if (keyword) q.set('keyword', keyword)
  if (kind) q.set('kind', kind)
  if (status) q.set('status', status)
  q.set('limit', '300')
  return request(`/entries?${q}`)
}

export async function retrieveEntries({ query = '', kind = null, status = null, limit = 40 } = {}) {
  return request('/entries/retrieve', {
    method: 'POST',
    body: {
      query: String(query || '').trim(),
      kind,
      status,
      limit: Math.max(1, Math.min(Number(limit) || 40, 100)),
    },
  })
}

export async function createEntry(rawText) {
  return request('/entries', { method: 'POST', body: { raw_text: rawText } })
}

export async function updateEntry(id, patch) {
  return request(`/entries/${id}`, { method: 'PATCH', body: patch })
}

export async function deleteEntry(id) {
  await request(`/entries/${id}`, { method: 'DELETE' })
  return true
}

export async function listLinks() {
  return request('/links')
}

export async function replaceLinks(sourceId, targets, reason) {
  return request(`/entries/${sourceId}/links`, {
    method: 'PUT',
    body: { target_ids: targets || [], reason: reason || null },
  })
}

export async function deleteLinksFor(entryId) {
  return request(`/entries/${entryId}/links`, { method: 'DELETE' })
}

export async function deleteEntryWithLinks(entryId) {
  return deleteEntry(entryId)
}

export async function replaceEntryChunks(entryId, chunks) {
  return request(`/entries/${entryId}/chunks`, {
    method: 'PUT',
    body: { chunks: (chunks || []).filter((x) => typeof x === 'string' && x.trim()) },
  })
}

export async function listReviews() {
  return request('/reviews')
}

export async function createReview(row) {
  return request('/reviews', { method: 'POST', body: row })
}

export async function deleteReview(id) {
  await request(`/reviews/${id}`, { method: 'DELETE' })
  return true
}

export async function getPreferences() {
  return request('/preferences')
}

export async function savePreferences({ theme, effect, ai }) {
  return request('/preferences', { method: 'PUT', body: { theme, effect, ai } })
}

/* ------------------------------------------------------------------ AI */

export async function listModels() {
  return request('/ai/models')
}

/**
 * 默认模型由自建服务代理。返回 OpenAI 兼容的 SSE chunk。
 * 自定义供应商仍由 ai.js 走用户自己的接口。
 */
export async function* streamChat(params) {
  let res
  try {
    res = await fetch(`${API}/ai/chat`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: params.model,
        messages: params.messages,
        stream: true,
        temperature: params.temperature,
        max_tokens: params.max_tokens,
        response_format: params.response_format,
      }),
      signal: params.signal,
    })
  } catch (err) {
    if (err?.name === 'AbortError') throw err
    const e = new Error(`连接 AI 服务失败：${err?.message || '网络错误'}`)
    e.code = 'network'
    throw e
  }

  if (!res.ok) {
    const payload = await res.json().catch(async () => ({ message: await res.text().catch(() => '') }))
    throw apiError(res.status, payload, 'AI 服务调用失败')
  }

  const ctype = res.headers?.get?.('content-type') || ''
  if (!res.body || !ctype.includes('text/event-stream')) {
    const data = await res.json()
    const content = data?.choices?.[0]?.message?.content
    if (content) yield { choices: [{ delta: { content } }] }
    return
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line.startsWith('data:')) continue
      const raw = line.slice(5).trim()
      if (!raw || raw === '[DONE]') continue
      try {
        yield JSON.parse(raw)
      } catch {
        // 心跳或非 JSON 分片直接忽略
      }
    }
  }
}

export function describeError(err) {
  const code = err?.code || ''
  const msg = err?.message || String(err || '未知错误')
  console.error('[api-error]', code || '(no-code)', msg)
  if (code === 'unauthenticated') return '登录状态已失效，请重新登录'
  if (code === 'invalid_grant') return '邮箱或密码不正确'
  if (code === 'otp_invalid') return '验证码不正确或已过期'
  if (code === 'otp_rate_limited') return '验证码发送过于频繁，请稍后再试'
  if (code === 'network') return '自建服务暂时无法连接，请检查网络或服务器状态'
  if (code === 'ai_quota') return '今天的 AI 调用额度已用完'
  return msg
}
