/**
 * 界面基础工具：转义、时间格式化、轻量 Markdown。
 * 所有来自用户或模型的内容在插入 DOM 前都必须经过 escapeHtml。
 */
import type { Kind, Priority, Status } from './types'

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/* ------------------------------------------------------------ 类型元信息 */

export const KIND_META: Record<Kind, { label: string; icon: string; cls: string }> = {
  idea: { label: '想法', icon: '💡', cls: 'k-idea' },
  material: { label: '资料', icon: '📎', cls: 'k-material' },
  todo: { label: '待办', icon: '✓', cls: 'k-todo' },
  note: { label: '随记', icon: '📝', cls: 'k-note' },
}

export const STATUS_META: Record<Status, { label: string; cls: string }> = {
  inbox: { label: '收件箱', cls: 's-inbox' },
  active: { label: '进行中', cls: 's-active' },
  done: { label: '已完成', cls: 's-done' },
  archived: { label: '已归档', cls: 's-archived' },
}

export const PRIORITY_META: Record<Priority, { label: string; cls: string }> = {
  high: { label: '高', cls: 'p-high' },
  normal: { label: '中', cls: 'p-normal' },
  low: { label: '低', cls: 'p-low' },
}

export function kindMeta(kind: string | null | undefined) {
  return KIND_META[(kind || 'note') as Kind] || KIND_META.note
}

/* -------------------------------------------------------------- 时间格式 */

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return ''
  const diff = Date.now() - t
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时前`
  const day = Math.floor(hour / 24)
  if (day < 30) return `${day} 天前`
  return fmtDate(iso)
}

export interface DueHint {
  text: string
  level: 'over' | 'today' | 'soon' | 'ok'
}

/** 相对今天的日期，用于"后天到期"这类提示 */
export function dueHint(dateStr: string | null | undefined): DueHint | null {
  if (!dateStr) return null
  const due = new Date(`${dateStr}T23:59:59`)
  if (Number.isNaN(due.getTime())) return null
  const today = new Date()
  const d0 = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const days = Math.round((new Date(due.getFullYear(), due.getMonth(), due.getDate()).getTime() - d0.getTime()) / 86400000)
  if (days < 0) return { text: `已逾期 ${-days} 天`, level: 'over' }
  if (days === 0) return { text: '今天到期', level: 'today' }
  if (days === 1) return { text: '明天到期', level: 'soon' }
  if (days <= 3) return { text: `${days} 天后到期`, level: 'soon' }
  return { text: `${dateStr} 到期`, level: 'ok' }
}

/* ---------------------------------------------------------- 简易 Markdown */

/**
 * 只支持换行、有序/无序列表和 **加粗**，其余一律当纯文本转义。
 * 返回 HTML 字符串 —— 输入已在函数内转义，调用方需用 dangerouslySetInnerHTML。
 */
export function renderRichText(text: string): string {
  const safe = escapeHtml(text || '')
  const withBold = safe.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  const lines = withBold.split(/\r?\n/)
  const out: string[] = []
  let listType: 'ul' | 'ol' | null = null
  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`)
      listType = null
    }
  }
  for (const raw of lines) {
    const line = raw.trim()
    const ul = line.match(/^[-*]\s+(.*)$/)
    const ol = line.match(/^\d+[.)]\s+(.*)$/)
    if (ul) {
      if (listType !== 'ul') {
        closeList()
        out.push('<ul>')
        listType = 'ul'
      }
      out.push(`<li>${ul[1]}</li>`)
    } else if (ol) {
      if (listType !== 'ol') {
        closeList()
        out.push('<ol>')
        listType = 'ol'
      }
      out.push(`<li>${ol[1]}</li>`)
    } else {
      closeList()
      out.push(line ? `<p>${line}</p>` : '')
    }
  }
  closeList()
  return out.join('')
}

/** 检索结果里高亮关键词。返回的 HTML 片段分别用于 textNode 与被高亮部分 */
export function highlightParts(text: unknown, keyword: string): { text: string; hit: boolean }[] {
  const safe = escapeHtml(text || '')
  const kw = String(keyword || '').trim()
  if (!kw) return [{ text: safe, hit: false }]
  const escaped = escapeHtml(kw).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  try {
    const re = new RegExp(escaped, 'gi')
    const out: { text: string; hit: boolean }[] = []
    let last = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(safe))) {
      if (m.index > last) out.push({ text: safe.slice(last, m.index), hit: false })
      out.push({ text: m[0], hit: true })
      last = m.index + m[0].length
      if (m[0].length === 0) re.lastIndex++
    }
    if (last < safe.length) out.push({ text: safe.slice(last), hit: false })
    return out.length ? out : [{ text: safe, hit: false }]
  } catch {
    return [{ text: safe, hit: false }]
  }
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, wait = 300) {
  let timer: ReturnType<typeof setTimeout> | null = null
  return (...args: A) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => fn(...args), wait)
  }
}

/** 数字 count → 中文短语，用于统计展示 */
export function plural(n: number, unit = '条'): string {
  return `${n} ${unit}`
}
