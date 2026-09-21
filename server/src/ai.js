import { Hono } from 'hono'
import { config } from './config.js'
import { tx } from './db.js'

export const aiRoutes = new Hono()

function apiErr(status, code, message) {
  return Object.assign(new Error(message), { status, code })
}

async function consumeQuota(userId) {
  await tx(async (client) => {
    const { rows } = await client.query(
      `insert into ai_usage (user_id, usage_date, calls)
       values ($1, current_date, 1)
       on conflict (user_id, usage_date)
       do update set calls = ai_usage.calls + 1
       returning calls`,
      [userId]
    )
    if ((rows[0]?.calls || 0) > config.ai.dailyLimit) {
      throw apiErr(429, 'ai_quota', '今天的 AI 调用额度已用完')
    }
  })
}

function allowedModels() {
  return config.ai.models
}

aiRoutes.get('/models', async (c) => {
  const configured = allowedModels()
  if (configured.length) {
    return c.json(configured.map((id) => ({ id, provider: 'self-hosted' })))
  }
  if (!config.ai.baseUrl || !config.ai.apiKey) return c.json([])
  const res = await fetch(`${config.ai.baseUrl}/models`, {
    headers: { Authorization: `Bearer ${config.ai.apiKey}` },
  }).catch(() => null)
  if (!res?.ok) return c.json([])
  const data = await res.json().catch(() => ({}))
  const list = Array.isArray(data?.data) ? data.data : []
  return c.json(list.map((m) => ({ id: String(m.id), provider: m.owned_by || 'self-hosted' })))
})

aiRoutes.post('/chat', async (c) => {
  if (!config.ai.baseUrl || !config.ai.apiKey) {
    throw apiErr(503, 'ai_unavailable', '服务端尚未配置默认 AI 接口')
  }

  const body = await c.req.json().catch(() => ({}))
  const model = String(body.model || '').trim()
  const configured = allowedModels()
  if (!model || (configured.length && !configured.includes(model))) {
    throw apiErr(400, 'model_not_allowed', '模型未在服务端允许列表中')
  }

  const messages = Array.isArray(body.messages)
    ? body.messages
        .filter((m) => ['system', 'user', 'assistant'].includes(m?.role) && typeof m?.content === 'string')
        .slice(0, 30)
        .map((m) => ({ role: m.role, content: m.content.slice(0, 30_000) }))
    : []
  if (!messages.length) throw apiErr(400, 'invalid_messages', '消息不能为空')
  const total = messages.reduce((n, m) => n + m.content.length, 0)
  if (total > 80_000) throw apiErr(413, 'prompt_too_large', '本次上下文过长')

  await consumeQuota(c.get('user').id)

  const upstreamBody = {
    model,
    messages,
    stream: true,
  }
  if (Number.isFinite(Number(body.temperature))) {
    upstreamBody.temperature = Math.max(0, Math.min(2, Number(body.temperature)))
  }
  if (Number(body.max_tokens) > 0) {
    upstreamBody.max_tokens = Math.max(1, Math.min(32_000, Math.trunc(Number(body.max_tokens))))
  }
  if (body.response_format?.type === 'json_object') upstreamBody.response_format = { type: 'json_object' }

  let upstream
  try {
    upstream = await fetch(`${config.ai.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.ai.apiKey}`,
      },
      body: JSON.stringify(upstreamBody),
      signal: c.req.raw.signal,
    })
  } catch (err) {
    if (err?.name === 'AbortError') throw err
    throw apiErr(502, 'ai_upstream', `连接上游模型失败：${err?.message || '网络错误'}`)
  }

  if (!upstream.ok) {
    const detail = (await upstream.text().catch(() => '')).slice(0, 500).replace(/\s+/g, ' ')
    throw apiErr(502, 'ai_upstream', `上游模型返回 ${upstream.status}${detail ? `：${detail}` : ''}`)
  }

  const headers = new Headers()
  headers.set('Content-Type', upstream.headers.get('content-type') || 'text/event-stream; charset=utf-8')
  headers.set('Cache-Control', 'no-cache, no-transform')
  headers.set('X-Accel-Buffering', 'no')
  return new Response(upstream.body, { status: 200, headers })
})
