/**
 * 云服务数据层：SDK 初始化 + 认证 + 数据读写。
 *
 * 约定：
 *  - 全应用共用一个 cloud 客户端实例（SDK 要求初始化一次）。
 *  - 所有写操作一律不传 owner_id，由数据库的 DEFAULT auth.uid() 决定归属，RLS 兜底。
 *  - 每个调用都返回 { data, error }，这里统一转成 throw，调用方用 try/catch 处理。
 */
import { PUBLIC_CONFIG } from './config.js?v=20260922s'

let _cloud = null

export function getCloud() {
  if (_cloud) return _cloud
  const WB = window.WorkBuddyCloud
  if (!WB || typeof WB.createWorkBuddyCloud !== 'function') {
    throw new Error('云服务 SDK 尚未加载完成，请刷新页面重试')
  }
  _cloud = WB.createWorkBuddyCloud({
    endpoint: PUBLIC_CONFIG.endpoint,
    publishableKey: PUBLIC_CONFIG.publishableKey,
  })
  return _cloud
}

/** 把 supabase 风格的 { data, error } 信封转成"出错就抛" */
function unwrap({ data, error }) {
  if (error) throw error
  return data
}

/** 把底层错误翻译成给人看的话 */
export function describeError(err) {
  const code = err?.code || err?.error?.code || err?.kind || ''
  const msg = err?.message || err?.error?.message || String(err || '未知错误')
  // 只记录错误码与描述，便于现场排查；不打印任何凭据或用户数据
  console.error('[cloud-error]', code || '(no-code)', msg)

  if (code === '42P01') return '数据表还不存在，请先完成应用初始化'
  if (code === '42501') return '没有权限执行该操作（可能登录已过期）'
  if (code === '23505') return '这条记录已经存在了'
  if (code === 'unauthenticated' || code === 'invalid_grant') return '登录状态已失效，请重新登录'
  if (code === 'network' || code === 'backend-unavailable') return '网络或服务暂时不可用，请稍后重试'
  if (String(code).startsWith('quota')) return 'AI 额度已用尽或触发限流，请稍后再试'
  if (String(code).startsWith('auth_')) return '云服务凭据校验失败，请在发布域名下访问'
  if (String(code).startsWith('gateway_') || String(code).startsWith('model_')) return '模型服务暂时不可用，请重试'
  return msg
}

/* ------------------------------------------------------------------ 认证 */

export async function getSession() {
  const { data, error } = await getCloud().auth.getSession()
  if (error) return null
  return data || null
}

export function onAuthStateChange(cb) {
  return getCloud().auth.onAuthStateChange(cb)
}

export const auth = {
  signInWithPassword: (email, password) =>
    getCloud().auth.signInWithPassword({ email, password }),

  sendOtp: (email) => getCloud().auth.sendOtp({ email }),

  verifyOtp: (payload) => getCloud().auth.verifyOtp(payload),

  signInWithOtp: (email) => getCloud().auth.signInWithOtp({ email }),

  resetPasswordForEmail: (email) => getCloud().auth.resetPasswordForEmail(email),

  signOut: () => getCloud().auth.signOut(),
}

/* ------------------------------------------------------------------ 数据 */

const ENTRY_COLUMNS =
  'id, raw_text, title, kind, summary, key_points, action_items, tags, status, priority, due_date, ai_state, created_at, updated_at'

/** 拉取条目（默认按时间倒序，最多 300 条） */
export async function listEntries(limit = 300) {
  return unwrap(
    await getCloud()
      .database.from('entries')
      .select(ENTRY_COLUMNS)
      .order('created_at', { ascending: false })
      .limit(limit)
  )
}

/** 关键词 / 类型 / 状态检索，走数据库端函数，避免把过滤逻辑放前端 */
export async function searchEntries({ keyword = '', kind = null, status = null } = {}) {
  return unwrap(
    await getCloud().database.rpc('pma_search_entries', {
      keyword: keyword || '',
      kind_filter: kind || null,
      status_filter: status || null,
    })
  )
}

function rpcMissing(err) {
  const code = err?.code || err?.error?.code || ''
  const msg = err?.message || err?.error?.message || ''
  return (
    code === 'PGRST202' ||
    code === '42883' ||
    /function .* does not exist/i.test(msg) ||
    /could not find .*function/i.test(msg)
  )
}

/**
 * 为问答取相关记录。新后端走 pma_retrieve_entries 排名检索；
 * 尚未部署该 RPC 的旧环境退回现有关键词函数，保持滚动发布兼容。
 */
export async function retrieveEntries({ query = '', kind = null, status = null, limit = 40 } = {}) {
  try {
    return unwrap(
      await getCloud().database.rpc('pma_retrieve_entries', {
        query_text: String(query || '').trim(),
        kind_filter: kind || null,
        status_filter: status || null,
        p_limit: Math.max(1, Math.min(Number(limit) || 40, 100)),
      })
    )
  } catch (err) {
    if (!rpcMissing(err)) throw err
    return searchEntries({ keyword: String(query || '').trim(), kind, status })
  }
}

/** 新建条目：只写原始文本，AI 结果稍后回填 */
export async function createEntry(rawText) {
  const rows = unwrap(
    await getCloud().database.from('entries').insert({ raw_text: rawText }).select(ENTRY_COLUMNS)
  )
  const created = Array.isArray(rows) ? rows[0] : rows
  if (!created) throw new Error('记录未能写入云端，请重试')
  return created
}

/** 更新条目 */
export async function updateEntry(id, patch) {
  const rows = unwrap(
    await getCloud()
      .database.from('entries')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select(ENTRY_COLUMNS)
  )
  const affected = Array.isArray(rows) ? rows : []
  if (affected.length === 0) throw new Error('没有改动任何内容（条目可能已不存在）')
  return affected[0]
}

/** 删除条目 */
export async function deleteEntry(id) {
  const rows = unwrap(
    await getCloud().database.from('entries').delete().eq('id', id).select('id')
  )
  const affected = Array.isArray(rows) ? rows : []
  if (affected.length === 0) throw new Error('没有删除任何内容（条目可能已不存在）')
  return true
}

/** 拉取全部关联关系 */
export async function listLinks() {
  return unwrap(
    await getCloud()
      .database.from('entry_links')
      .select('id, source_id, target_id, reason, created_at')
      .limit(2000)
  )
}

/** 重写某条目的出边关联。优先走数据库事务 RPC；旧环境回退到兼容路径。 */
export async function replaceLinks(sourceId, targets, reason) {
  const cleanTargets = (targets || []).filter((t) => Number.isFinite(t) && t !== sourceId)
  try {
    return unwrap(
      await getCloud().database.rpc('pma_replace_links', {
        p_source_id: sourceId,
        p_target_ids: cleanTargets,
        p_reason: reason || null,
      })
    )
  } catch (err) {
    if (!rpcMissing(err)) throw err
  }

  await getCloud().database.from('entry_links').delete().eq('source_id', sourceId)
  const rows = cleanTargets.map((targetId) => ({
    source_id: sourceId,
    target_id: targetId,
    reason: reason || null,
  }))
  if (rows.length === 0) return []
  return unwrap(await getCloud().database.from('entry_links').insert(rows).select())
}

/** 删除涉及某条目的全部关联（出边 + 入边） */
export async function deleteLinksFor(entryId) {
  await getCloud().database.from('entry_links').delete().eq('source_id', entryId)
  await getCloud().database.from('entry_links').delete().eq('target_id', entryId)
}

/** 原子删除条目（FK 同事务级联 links/chunks）；旧后端没有 RPC 时走兼容删除。 */
export async function deleteEntryWithLinks(entryId) {
  try {
    const deleted = unwrap(
      await getCloud().database.rpc('pma_delete_entry', { p_entry_id: entryId })
    )
    if (!deleted) throw new Error('没有删除任何内容（条目可能已不存在）')
    return true
  } catch (err) {
    if (!rpcMissing(err)) throw err
  }

  await deleteLinksFor(entryId)
  return deleteEntry(entryId)
}

/** 刷新长文本分块。RPC 未部署时静默跳过，不影响记录主流程。 */
export async function replaceEntryChunks(entryId, chunks) {
  const clean = (chunks || [])
    .filter((x) => typeof x === 'string' && x.trim())
    .map((x) => x.trim())
  try {
    return unwrap(
      await getCloud().database.rpc('pma_replace_entry_chunks', {
        p_entry_id: entryId,
        p_chunks: clean,
      })
    )
  } catch (err) {
    if (rpcMissing(err)) return null
    throw err
  }
}

/* ------------------------------------------------------------------ 复盘 */

export async function listReviews() {
  return unwrap(
    await getCloud()
      .database.from('reviews')
      .select('id, period_label, range_start, range_end, summary, actions, stats, entry_count, created_at')
      .order('created_at', { ascending: false })
      .limit(50)
  )
}

export async function createReview(row) {
  const rows = unwrap(await getCloud().database.from('reviews').insert(row).select())
  const created = Array.isArray(rows) ? rows[0] : rows
  if (!created) throw new Error('复盘未能保存到云端，请重试')
  return created
}

export async function deleteReview(id) {
  const rows = unwrap(await getCloud().database.from('reviews').delete().eq('id', id).select('id'))
  const affected = Array.isArray(rows) ? rows : []
  if (affected.length === 0) throw new Error('没有删除任何内容')
  return true
}

/* --------------------------------------------------------------- 模型目录 */

/**
 * 列出云服务当前可用的模型。目录是权威来源 —— 调用层与设置面板共用同一份，
 * 免得两处各自去问、结果不一致。
 */
export async function listModels() {
  const models = await getCloud().llm.models.list()
  return Array.isArray(models) ? models : []
}

/* --------------------------------------------------------------- 个人偏好 */

/** 读取当前用户的个性化设置；没有则返回 null（调用方用默认值） */
export async function getPreferences() {
  const rows = unwrap(
    await getCloud().database.from('preferences').select('theme, effect, ai, updated_at').limit(1)
  )
  const list = Array.isArray(rows) ? rows : []
  return list[0] || null
}

/**
 * 保存个性化设置。owner_id 有唯一约束，用 upsert 保证一人一行。
 * 同样不发送 owner_id —— 由 DEFAULT auth.uid() 决定归属。
 */
export async function savePreferences({ theme, effect, ai }) {
  const rows = unwrap(
    await getCloud()
      .database.from('preferences')
      .upsert(
        { theme, effect, ai, updated_at: new Date().toISOString() },
        { onConflict: 'owner_id' }
      )
      .select('theme, effect, ai, updated_at')
  )
  const list = Array.isArray(rows) ? rows : []
  if (list.length === 0) throw new Error('设置未能保存到云端，请重试')
  return list[0]
}
