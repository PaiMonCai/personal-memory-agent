/**
 * 界面基础工具：转义、时间格式化、提示、确认框。
 * 所有来自用户或模型的内容在插入 DOM 前都必须经过 escapeHtml。
 */

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/* ------------------------------------------------------------ 类型元信息 */

export const KIND_META = {
  idea: { label: '想法', icon: '💡', cls: 'k-idea' },
  material: { label: '资料', icon: '📎', cls: 'k-material' },
  todo: { label: '待办', icon: '✓', cls: 'k-todo' },
  note: { label: '随记', icon: '📝', cls: 'k-note' },
}

export const STATUS_META = {
  inbox: { label: '收件箱', cls: 's-inbox' },
  active: { label: '进行中', cls: 's-active' },
  done: { label: '已完成', cls: 's-done' },
  archived: { label: '已归档', cls: 's-archived' },
}

export const PRIORITY_META = {
  high: { label: '高', cls: 'p-high' },
  normal: { label: '中', cls: 'p-normal' },
  low: { label: '低', cls: 'p-low' },
}

export function kindMeta(kind) {
  return KIND_META[kind] || KIND_META.note
}

/* -------------------------------------------------------------- 时间格式 */

export function fmtDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function fmtDateTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function timeAgo(iso) {
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

/** 相对今天的日期，用于"后天到期"这类提示 */
export function dueHint(dateStr) {
  if (!dateStr) return null
  const due = new Date(`${dateStr}T23:59:59`)
  if (Number.isNaN(due.getTime())) return null
  const today = new Date()
  const d0 = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const days = Math.round((new Date(due.getFullYear(), due.getMonth(), due.getDate()) - d0) / 86400000)
  if (days < 0) return { text: `已逾期 ${-days} 天`, level: 'over' }
  if (days === 0) return { text: '今天到期', level: 'today' }
  if (days === 1) return { text: '明天到期', level: 'soon' }
  if (days <= 3) return { text: `${days} 天后到期`, level: 'soon' }
  return { text: `${dateStr} 到期`, level: 'ok' }
}

/* ---------------------------------------------------------- 简易 Markdown */

/** 只支持换行、有序/无序列表和 **加粗**，其余一律当纯文本转义 */
export function renderRichText(text) {
  const safe = escapeHtml(text || '')
  const withBold = safe.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  const lines = withBold.split(/\r?\n/)
  const out = []
  let listType = null
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

/** 检索结果里高亮关键词 */
export function highlight(text, keyword) {
  const safe = escapeHtml(text || '')
  const kw = String(keyword || '').trim()
  if (!kw) return safe
  const escaped = escapeHtml(kw).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  try {
    return safe.replace(new RegExp(escaped, 'gi'), (m) => `<mark>${m}</mark>`)
  } catch {
    return safe
  }
}

/* ------------------------------------------------------------------ 提示 */

let toastHost = null

/**
 * 轻提示。
 * @param {string} message 文案
 * @param {'info'|'success'|'error'|'warn'} type 类型
 * @param {number} ms 停留毫秒
 * @param {{label:string, onClick:Function}|null} action 可选的行动按钮（如「撤销」）
 */
export function toast(message, type = 'info', ms = 3200, action = null) {
  if (!toastHost) toastHost = document.getElementById('toast-host')
  if (!toastHost) return

  const el = document.createElement('div')
  el.className = `toast toast-${type}`

  const text = document.createElement('span')
  text.textContent = message
  el.appendChild(text)

  let timer = null
  const dismiss = () => {
    if (timer) clearTimeout(timer)
    el.classList.remove('in')
    setTimeout(() => el.remove(), 220)
  }

  if (action) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'toast-action'
    btn.textContent = action.label
    btn.addEventListener('click', () => {
      try {
        if (action.onClick) action.onClick()
      } finally {
        dismiss()
      }
    })
    el.appendChild(btn)
  }

  toastHost.appendChild(el)
  requestAnimationFrame(() => el.classList.add('in'))
  timer = setTimeout(dismiss, ms)
}

/* ------------------------------------------------------------------ 确认 */

export function confirmDialog({ title, message, confirmText = '确定', danger = false }) {
  return new Promise((resolve) => {
    const host = document.getElementById('modal-host')
    const wrap = document.createElement('div')
    wrap.className = 'modal-mask'
    wrap.innerHTML = `
      <div class="modal-box" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
        <h3>${escapeHtml(title)}</h3>
        <p>${escapeHtml(message)}</p>
        <div class="modal-actions">
          <button class="btn btn-ghost" data-act="cancel">取消</button>
          <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-act="ok">${escapeHtml(confirmText)}</button>
        </div>
      </div>`

    const app = document.getElementById('app-view')

    function done(value) {
      document.removeEventListener('keydown', onKey, true)
      wrap.remove()
      // 背后可能还开着抽屉或设置面板，按实际情况恢复而不是一律解锁
      const stillCovered =
        !document.getElementById('drawer')?.classList.contains('hidden') ||
        !document.getElementById('settings-panel')?.classList.contains('hidden')
      if (app) app.inert = !!stillCovered
      resolve(value)
    }

    // 捕获阶段拦截 Esc，避免同时触发下层浮层的关闭逻辑
    function onKey(e) {
      if (e.key === 'Escape') {
        e.stopPropagation()
        done(false)
      }
    }

    if (app) app.inert = true
    document.addEventListener('keydown', onKey, true)

    wrap.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act
      if (act === 'ok') done(true)
      else if (act === 'cancel' || e.target === wrap) done(false)
    })

    host.appendChild(wrap)
    // 危险操作默认聚焦「取消」，避免误按回车
    const initial = wrap.querySelector(danger ? '[data-act="cancel"]' : '[data-act="ok"]')
    if (initial) initial.focus({ preventScroll: true })
  })
}

/* -------------------------------------------------------------- 小工具 */

export function debounce(fn, wait = 300) {
  let timer = null
  return (...args) => {
    clearTimeout(timer)
    timer = setTimeout(() => fn(...args), wait)
  }
}

/** 数字 count → 中文短语，用于统计展示 */
export function plural(n, unit = '条') {
  return `${n} ${unit}`
}
