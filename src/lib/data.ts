/**
 * 数据与默认 AI 的接口封装。
 * 与 server/src/data.js、server/src/ai.js 的路由一一对应。
 */
import { request } from './api'
import type {
  Entry,
  EntryLink,
  ModelInfo,
  Review,
  Settings,
  ChatMessage,
} from './types'

const clamp = (n: number, lo: number, hi: number, fallback: number) => {
  const v = Number(n)
  if (!Number.isFinite(v)) return fallback
  return Math.min(hi, Math.max(lo, v))
}

/* ------------------------------------------------------------------ 条目 */

export async function listEntries(limit = 300) {
  return request<Entry[]>(`/entries?limit=${Math.round(clamp(limit, 1, 500, 300))}`)
}

export async function searchEntries({ keyword = '', kind = null, status = null }: { keyword?: string; kind?: string | null; status?: string | null } = {}) {
  const q = new URLSearchParams()
  if (keyword) q.set('keyword', keyword)
  if (kind) q.set('kind', kind)
  if (status) q.set('status', status)
  q.set('limit', '300')
  return request<Entry[]>(`/entries?${q}`)
}

/**
 * Ask 用的相关记忆检索：命中不了就由调用方回落到最近记录。
 * 检索层故障不该把整次问答拖垮。
 */
export async function retrieveEntries({ query = '', kind = null, status = null, limit = 40 }: { query?: string; kind?: string | null; status?: string | null; limit?: number } = {}) {
  return request<Entry[]>('/entries/retrieve', {
    method: 'POST',
    body: {
      query: String(query || '').trim(),
      kind,
      status,
      limit: Math.round(clamp(limit, 1, 100, 40)),
    },
  })
}

export async function createEntry(rawText: string) {
  return request<Entry>('/entries', { method: 'POST', body: { raw_text: rawText } })
}

export async function updateEntry(id: number, patch: Partial<Entry>) {
  return request<Entry>(`/entries/${id}`, { method: 'PATCH', body: patch })
}

export async function deleteEntry(id: number) {
  await request(`/entries/${id}`, { method: 'DELETE' })
  return true
}

/* ------------------------------------------------------------------ 关联 */

export async function listLinks() {
  return request<EntryLink[]>('/links')
}

export async function replaceLinks(sourceId: number, targets: number[], reason: string | null) {
  return request(`/entries/${sourceId}/links`, {
    method: 'PUT',
    body: { target_ids: targets || [], reason: reason || null },
  })
}

export async function deleteLinksFor(entryId: number) {
  return request(`/entries/${entryId}/links`, { method: 'DELETE' })
}

export async function deleteEntryWithLinks(entryId: number) {
  return deleteEntry(entryId)
}

/** 长文本分块：检索索引用。索引失败不应阻断主流程，调用方自行 try/catch */
export async function replaceEntryChunks(entryId: number, chunks: string[]) {
  return request(`/entries/${entryId}/chunks`, {
    method: 'PUT',
    body: { chunks: (chunks || []).filter((x) => typeof x === 'string' && x.trim()) },
  })
}

/* ------------------------------------------------------------------ 复盘 */

export async function listReviews() {
  return request<Review[]>('/reviews')
}

export async function createReview(row: Record<string, unknown>) {
  return request<Review>('/reviews', { method: 'POST', body: row })
}

export async function deleteReview(id: number) {
  await request(`/reviews/${id}`, { method: 'DELETE' })
  return true
}

/* -------------------------------------------------------------- 偏好设置 */

export async function getPreferences() {
  return request<Partial<Settings> | null>('/preferences')
}

export async function savePreferences({ theme, effect, ai }: Partial<Settings>) {
  return request('/preferences', { method: 'PUT', body: { theme, effect, ai } })
}

/* -------------------------------------------------------------------- AI */

export async function listModels() {
  return request<ModelInfo[]>('/ai/models')
}

/**
 * 默认模型由自建服务代理，浏览器不接触服务端 Key。
 * 返回 OpenAI 兼容的 SSE chunk；自定义供应商仍由 ai.ts 走用户自己的接口。
 */
export async function* streamChat(params: {
  model: string
  messages: ChatMessage[]
  stream?: boolean
  temperature?: number
  max_tokens?: number
  response_format?: { type: string }
  signal?: AbortSignal
}): AsyncGenerator<{ choices?: { delta?: { content?: string } }[] }> {
  let res: Response
  try {
    res = await fetch(`${String(import.meta.env.VITE_API_BASE || '/api').replace(/\/+$/, '')}/ai/chat`, {
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
    if ((err as Error)?.name === 'AbortError') throw err
    const e = new Error(`连接 AI 服务失败：${(err as Error)?.message || '网络错误'}`) as Error & { code: string }
    e.code = 'network'
    throw e
  }

  if (!res.ok) {
    const payload = await res.json().catch(async () => ({ message: await res.text().catch(() => '') }))
    throw apiErrorFrom(res.status, payload)
  }

  const ctype = res.headers?.get?.('content-type') || ''
  if (!res.body || !ctype.includes('text/event-stream')) {
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] }
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
    let nl: number
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

function apiErrorFrom(status: number, payload: unknown) {
  const info = (payload && typeof payload === 'object' ? (payload as { error?: Record<string, unknown> }).error : null) || {}
  const err = new Error(String(info.message || 'AI 服务调用失败')) as Error & { code: string; status: number }
  err.code = String(info.code || `http_${status}`)
  err.status = status
  return err
}

/* ------------------------------------------------------------------ 错误 */

export function describeError(err: unknown): string {
  const e = err as { code?: string; message?: string } | null
  const code = e?.code || ''
  const msg = e?.message || String(err || '未知错误')
  console.error('[api-error]', code || '(no-code)', msg)
  if (code === 'unauthenticated') return '登录状态已失效，请重新登录'
  if (code === 'invalid_grant') return '邮箱或密码不正确'
  if (code === 'otp_invalid') return '验证码不正确或已过期'
  if (code === 'otp_rate_limited') return '验证码发送过于频繁，请稍后再试'
  if (code === 'network') return '自建服务暂时无法连接，请检查网络或服务器状态'
  if (code === 'ai_quota') return '今天的 AI 调用额度已用完'
  return msg
}
