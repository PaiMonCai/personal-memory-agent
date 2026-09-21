import { Hono } from 'hono'
import { query, tx } from './db.js'
import { decryptAiSettings, encryptAiSettings } from './crypto.js'

export const dataRoutes = new Hono()

const kinds = new Set(['idea', 'material', 'todo', 'note'])
const statuses = new Set(['inbox', 'active', 'done', 'archived'])
const priorities = new Set(['high', 'normal', 'low'])
const aiStates = new Set(['pending', 'done', 'failed'])

function uid(c) {
  return c.get('user').id
}

function int(value, fallback, min, max) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.trunc(n))) : fallback
}

function cleanText(value, max, nullable = false) {
  if (value === null && nullable) return null
  if (typeof value !== 'string') return undefined
  return value.trim().slice(0, max)
}

function cleanTextArray(value, maxItems = 20, maxChars = 500) {
  if (!Array.isArray(value)) return undefined
  return value
    .filter((x) => typeof x === 'string' && x.trim())
    .map((x) => x.trim().slice(0, maxChars))
    .slice(0, maxItems)
}

function apiErr(status, code, message) {
  return Object.assign(new Error(message), { status, code })
}

const ENTRY_COLUMNS =
  'id, raw_text, title, kind, summary, key_points, action_items, tags, status, priority, due_date, ai_state, created_at, updated_at'

dataRoutes.get('/entries', async (c) => {
  const owner = uid(c)
  const limit = int(c.req.query('limit'), 300, 1, 500)
  const keyword = String(c.req.query('keyword') || '').trim().slice(0, 300)
  const kind = String(c.req.query('kind') || '')
  const status = String(c.req.query('status') || '')
  const params = [owner]
  const where = ['owner_id = $1']

  if (kind && kinds.has(kind)) {
    params.push(kind)
    where.push(`kind = $${params.length}`)
  }
  if (status && statuses.has(status)) {
    params.push(status)
    where.push(`status = $${params.length}`)
  }
  if (keyword) {
    params.push(`%${keyword}%`)
    const p = `$${params.length}`
    where.push(`concat_ws(
      ' ', coalesce(title,''), raw_text, coalesce(summary,''),
      array_to_string(tags,' '), array_to_string(key_points,' '), array_to_string(action_items,' ')
    ) ilike ${p}`)
  }
  params.push(limit)
  const { rows } = await query(
    `select ${ENTRY_COLUMNS}
     from entries
     where ${where.join(' and ')}
     order by created_at desc
     limit $${params.length}`,
    params
  )
  return c.json(rows)
})

dataRoutes.post('/entries/retrieve', async (c) => {
  const owner = uid(c)
  const body = await c.req.json().catch(() => ({}))
  const q = String(body.query || '').trim().slice(0, 1000)
  const kind = kinds.has(body.kind) ? body.kind : null
  const status = statuses.has(body.status) ? body.status : null
  const limit = int(body.limit, 40, 1, 100)

  if (!q) {
    const { rows } = await query(
      `select ${ENTRY_COLUMNS} from entries
       where owner_id = $1
       order by created_at desc limit $2`,
      [owner, limit]
    )
    return c.json(rows)
  }

  const { rows } = await query(
    `with base as (
       select e.*,
         lower(concat_ws(
           ' ', coalesce(e.title,''), e.raw_text, coalesce(e.summary,''),
           array_to_string(e.tags,' '), array_to_string(e.key_points,' '),
           array_to_string(e.action_items,' ')
         )) as hay,
         coalesce(ch.chunk_rank, 0) as chunk_rank,
         coalesce(ch.chunk_hit, false) as chunk_hit
       from entries e
       left join lateral (
         select
           max(ts_rank_cd(to_tsvector('simple', lower(ec.content)), websearch_to_tsquery('simple', $2))) as chunk_rank,
           bool_or(lower(ec.content) ilike '%' || lower($2) || '%') as chunk_hit
         from entry_chunks ec
         where ec.owner_id = e.owner_id and ec.entry_id = e.id
       ) ch on true
       where e.owner_id = $1
         and ($3::text is null or e.kind = $3)
         and ($4::text is null or e.status = $4)
     ),
     scored as (
       select b.*,
         (
           case when b.hay ilike '%' || lower($2) || '%' then 8 else 0 end
           + case when b.chunk_hit then 5 else 0 end
           + coalesce((
               select sum(case when length(tok) >= 2 and b.hay ilike '%' || tok || '%' then 1.5 else 0 end)
               from regexp_split_to_table(lower($2), E'\\s+') tok
             ), 0)
           + ts_rank_cd(to_tsvector('simple', b.hay), websearch_to_tsquery('simple', $2)) * 6
           + b.chunk_rank * 7
           + greatest(0, 1 - extract(epoch from (now() - b.created_at)) / 2592000.0) * 0.15
         )::double precision as score
       from base b
     )
     select id, raw_text, title, kind, summary, key_points, action_items, tags,
            status, priority, due_date, ai_state, created_at, updated_at
     from scored
     where score > 0
     order by score desc, created_at desc
     limit $5`,
    [owner, q, kind, status, limit]
  )
  return c.json(rows)
})

dataRoutes.post('/entries', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const raw = cleanText(body.raw_text, 200_000)
  if (!raw) throw apiErr(400, 'invalid_entry', '记录内容不能为空')
  const { rows } = await query(
    `insert into entries (owner_id, raw_text)
     values ($1, $2)
     returning ${ENTRY_COLUMNS}`,
    [uid(c), raw]
  )
  return c.json(rows[0], 201)
})

dataRoutes.patch('/entries/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isSafeInteger(id)) throw apiErr(400, 'invalid_id', '条目 ID 不正确')
  const body = await c.req.json().catch(() => ({}))
  const patch = {}

  if ('raw_text' in body) {
    const v = cleanText(body.raw_text, 200_000)
    if (!v) throw apiErr(400, 'invalid_entry', '记录内容不能为空')
    patch.raw_text = v
  }
  if ('title' in body) patch.title = cleanText(body.title, 120, true)
  if ('summary' in body) patch.summary = cleanText(body.summary, 1000, true)
  if ('kind' in body && kinds.has(body.kind)) patch.kind = body.kind
  if ('status' in body && statuses.has(body.status)) patch.status = body.status
  if ('priority' in body && priorities.has(body.priority)) patch.priority = body.priority
  if ('ai_state' in body && aiStates.has(body.ai_state)) patch.ai_state = body.ai_state
  if ('key_points' in body) patch.key_points = cleanTextArray(body.key_points, 20, 1000)
  if ('action_items' in body) patch.action_items = cleanTextArray(body.action_items, 20, 1000)
  if ('tags' in body) patch.tags = cleanTextArray(body.tags, 20, 100)
  if ('due_date' in body) {
    patch.due_date = body.due_date === null || body.due_date === '' ? null : String(body.due_date).slice(0, 10)
  }

  const keys = Object.keys(patch).filter((k) => patch[k] !== undefined)
  if (!keys.length) throw apiErr(400, 'empty_patch', '没有可更新的字段')
  const params = [uid(c), id]
  const sets = keys.map((key) => {
    params.push(patch[key])
    return `${key} = $${params.length}`
  })
  const { rows } = await query(
    `update entries set ${sets.join(', ')}, updated_at = now()
     where owner_id = $1 and id = $2
     returning ${ENTRY_COLUMNS}`,
    params
  )
  if (!rows[0]) throw apiErr(404, 'not_found', '条目不存在')
  return c.json(rows[0])
})

dataRoutes.delete('/entries/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const { rowCount } = await query('delete from entries where owner_id = $1 and id = $2', [uid(c), id])
  if (!rowCount) throw apiErr(404, 'not_found', '条目不存在')
  return c.json({ ok: true })
})

dataRoutes.get('/links', async (c) => {
  const { rows } = await query(
    `select id, source_id, target_id, reason, created_at
     from entry_links where owner_id = $1
     order by id desc limit 5000`,
    [uid(c)]
  )
  return c.json(rows)
})

dataRoutes.put('/entries/:id/links', async (c) => {
  const owner = uid(c)
  const sourceId = Number(c.req.param('id'))
  const body = await c.req.json().catch(() => ({}))
  const targets = Array.isArray(body.target_ids)
    ? [...new Set(body.target_ids.map(Number).filter((x) => Number.isSafeInteger(x) && x !== sourceId))].slice(0, 30)
    : []
  const reason = cleanText(body.reason, 500, true)

  const rows = await tx(async (client) => {
    const source = await client.query('select 1 from entries where owner_id = $1 and id = $2', [owner, sourceId])
    if (!source.rowCount) throw apiErr(404, 'not_found', '源条目不存在')
    await client.query('delete from entry_links where owner_id = $1 and source_id = $2', [owner, sourceId])
    if (targets.length) {
      await client.query(
        `insert into entry_links (owner_id, source_id, target_id, reason)
         select $1, $2, e.id, $4
         from entries e
         where e.owner_id = $1 and e.id = any($3::bigint[])
         on conflict (owner_id, source_id, target_id) do update set reason = excluded.reason`,
        [owner, sourceId, targets, reason]
      )
    }
    const result = await client.query(
      'select id, source_id, target_id, reason, created_at from entry_links where owner_id = $1 and source_id = $2 order by id',
      [owner, sourceId]
    )
    return result.rows
  })
  return c.json(rows)
})

dataRoutes.delete('/entries/:id/links', async (c) => {
  const id = Number(c.req.param('id'))
  await query(
    'delete from entry_links where owner_id = $1 and (source_id = $2 or target_id = $2)',
    [uid(c), id]
  )
  return c.json({ ok: true })
})

dataRoutes.put('/entries/:id/chunks', async (c) => {
  const owner = uid(c)
  const entryId = Number(c.req.param('id'))
  const body = await c.req.json().catch(() => ({}))
  const chunks = cleanTextArray(body.chunks, 500, 5000) || []

  await tx(async (client) => {
    const exists = await client.query('select 1 from entries where owner_id = $1 and id = $2', [owner, entryId])
    if (!exists.rowCount) throw apiErr(404, 'not_found', '条目不存在')
    await client.query('delete from entry_chunks where owner_id = $1 and entry_id = $2', [owner, entryId])
    if (chunks.length) {
      await client.query(
        `insert into entry_chunks (owner_id, entry_id, chunk_index, content)
         select $1, $2, ordinality - 1, chunk
         from unnest($3::text[]) with ordinality as x(chunk, ordinality)`,
        [owner, entryId, chunks]
      )
    }
  })
  return c.json({ ok: true })
})

dataRoutes.get('/reviews', async (c) => {
  const { rows } = await query(
    `select id, period_label, range_start, range_end, summary, actions, stats, entry_count, created_at
     from reviews where owner_id = $1 order by created_at desc limit 100`,
    [uid(c)]
  )
  return c.json(rows)
})

dataRoutes.post('/reviews', async (c) => {
  const b = await c.req.json().catch(() => ({}))
  const period = cleanText(b.period_label, 120)
  if (!period) throw apiErr(400, 'invalid_review', '复盘区间不能为空')
  const actions = cleanTextArray(b.actions, 20, 1000) || []
  const stats = b.stats && typeof b.stats === 'object' && !Array.isArray(b.stats) ? b.stats : {}
  const { rows } = await query(
    `insert into reviews
       (owner_id, period_label, range_start, range_end, summary, actions, stats, entry_count)
     values ($1,$2,$3,$4,$5,$6,$7,$8)
     returning id, period_label, range_start, range_end, summary, actions, stats, entry_count, created_at`,
    [
      uid(c), period, b.range_start || null, b.range_end || null,
      cleanText(b.summary, 10_000, true), actions, stats, int(b.entry_count, 0, 0, 1_000_000),
    ]
  )
  return c.json(rows[0], 201)
})

dataRoutes.delete('/reviews/:id', async (c) => {
  const { rowCount } = await query('delete from reviews where owner_id = $1 and id = $2', [
    uid(c), Number(c.req.param('id')),
  ])
  if (!rowCount) throw apiErr(404, 'not_found', '复盘不存在')
  return c.json({ ok: true })
})

dataRoutes.get('/preferences', async (c) => {
  const { rows } = await query('select theme, effect, ai, updated_at from preferences where owner_id = $1', [uid(c)])
  if (!rows[0]) return c.json(null)
  return c.json({ ...rows[0], ai: decryptAiSettings(rows[0].ai) })
})

dataRoutes.put('/preferences', async (c) => {
  const b = await c.req.json().catch(() => ({}))
  const theme = b.theme && typeof b.theme === 'object' ? b.theme : {}
  const effect = b.effect && typeof b.effect === 'object' ? b.effect : {}
  const ai = encryptAiSettings(b.ai && typeof b.ai === 'object' ? b.ai : {})
  const { rows } = await query(
    `insert into preferences (owner_id, theme, effect, ai, updated_at)
     values ($1,$2,$3,$4,now())
     on conflict (owner_id) do update
       set theme = excluded.theme, effect = excluded.effect, ai = excluded.ai, updated_at = now()
     returning theme, effect, ai, updated_at`,
    [uid(c), theme, effect, ai]
  )
  return c.json({ ...rows[0], ai: decryptAiSettings(rows[0].ai) })
})
