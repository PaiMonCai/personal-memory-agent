/**
 * 个性设置：主题预设、自定义配色、背景与动效参数。
 *
 * 只负责"设置的数据形态 + 应用到界面 + 面板渲染"，不碰云端读写
 * （读写在 cloud.js，保存时机由 app.js 决定）。
 */
import { escapeHtml } from './ui.js?v=20260922s'
import { EFFECTS, CUSTOM_LIMITS } from './effects.js?v=20260922s'

/* ------------------------------------------------------------- 主题预设 */

export const PRESETS = [
  { id: 'mist', label: '晨雾', accent: '#4f46e5', bgFrom: '#f5f6fb', bgTo: '#e8ecf9', dark: false },
  { id: 'ocean', label: '海盐', accent: '#0e7490', bgFrom: '#f0f9fb', bgTo: '#dceff5', dark: false },
  { id: 'forest', label: '苔原', accent: '#15803d', bgFrom: '#f2f9f3', bgTo: '#dff0e4', dark: false },
  { id: 'sunset', label: '暮色', accent: '#c2410c', bgFrom: '#fdf5f0', bgTo: '#fae9db', dark: false },
  { id: 'sakura', label: '樱粉', accent: '#be185d', bgFrom: '#fdf2f8', bgTo: '#fae4ef', dark: false },
  { id: 'graphite', label: '石墨', accent: '#a78bfa', bgFrom: '#15171f', bgTo: '#1d2130', dark: true },
  { id: 'midnight', label: '午夜', accent: '#38bdf8', bgFrom: '#0a1020', bgTo: '#111d33', dark: true },
  { id: 'jade', label: '墨玉', accent: '#34d399', bgFrom: '#0c1512', bgTo: '#13251f', dark: true },
]

export const DEFAULT_SETTINGS = {
  theme: {
    preset: 'mist',
    accent: '#4f46e5',
    bgFrom: '#f5f6fb',
    bgTo: '#e8ecf9',
    bgImage: '',
    blur: 0,
    dim: 0,
    radius: 14,
    dark: false,
    compact: false,
  },
  // custom.code：用户自己写的动效代码（函数体，参数 fx）。存进 effect 列，随设置一起上云。
  effect: { type: 'none', intensity: 1, speed: 1, custom: { code: '' } },
  // mode='cloud' 时走云服务模型（modelId 空 = 自动挑第一个可用）；
  // mode='custom' 时直连下面填的 OpenAI 兼容接口，不再经过云服务。
  ai: {
    mode: 'cloud',
    modelId: '',
    temperature: 1,
    maxTokens: 0, // 0 = 不传，交给服务端默认
    // pick 形如 "vendorId::modelId"，空 = 自动挑第一个可用的。
    // 地址和密钥挂在供应商上、模型挂在供应商下面 —— 按供应商分组，
    // 同一个 key 就不用为每个模型各填一遍。
    custom: { pick: '', vendors: [] },
  },
}

/** 供应商清单的容量上限。设上限是为了别让设置列无限膨胀 */
export const VENDOR_LIMITS = { vendors: 20, modelsPerVendor: 30 }

/** 自定义接口的地址要能拼成 `<base>/chat/completions`，这里做最低限度的合法性判断 */
export function isHttpUrl(v) {
  try {
    const u = new URL(String(v || '').trim())
    return u.protocol === 'https:' || u.protocol === 'http:'
  } catch {
    return false
  }
}

/* ------------------------------------------------- 供应商清单的规范化 */

let uidSeq = 0
function uid(prefix = 'v') {
  uidSeq += 1
  return `${prefix}${Date.now().toString(36)}${uidSeq.toString(36)}${Math.random()
    .toString(36)
    .slice(2, 6)}`
}

/** 从地址里猜一个供应商名，省得用户每个都手打一遍 */
function vendorNameFromUrl(baseUrl) {
  try {
    const host = new URL(baseUrl).hostname
    const main = host.replace(/^www\./, '').split('.')[0] || ''
    return main ? main.slice(0, 24) : ''
  } catch {
    return ''
  }
}

function normVendor(raw, index) {
  const v = raw && typeof raw === 'object' ? raw : {}
  const baseUrl = str(v.baseUrl, 300).replace(/\/+$/, '')
  const name = str(v.name, 40) || vendorNameFromUrl(baseUrl) || `供应商 ${index + 1}`
  const modelsRaw = Array.isArray(v.models) ? v.models : []
  const seen = new Set()
  const models = modelsRaw
    .slice(0, VENDOR_LIMITS.modelsPerVendor)
    .map((m, i) => {
      const item = m && typeof m === 'object' ? m : {}
      const label = str(m && typeof m === 'string' ? m : item.name, 120)
      const id = str(item.id, 40) || uid('m')
      // 同一供应商下重名没有意义，直接丢掉后面的
      if (!label || seen.has(label)) return null
      seen.add(label)
      return { id, name: label }
    })
    .filter(Boolean)
  return {
    id: str(v.id, 40) || uid(),
    name,
    baseUrl,
    apiKey: typeof v.apiKey === 'string' ? v.apiKey.slice(0, 300) : '',
    models,
  }
}

/** 规范化整份清单：补 id、去重、夹紧容量 */
export function normalizeVendors(raw) {
  const list = Array.isArray(raw) ? raw : []
  const out = []
  const ids = new Set()
  for (const item of list.slice(0, VENDOR_LIMITS.vendors)) {
    const v = normVendor(item, out.length)
    while (ids.has(v.id)) v.id = uid() // 复制粘贴可能撞 id，撞了就换一个
    ids.add(v.id)
    out.push(v)
  }
  return out
}

/**
 * 把「旧的单条自定义配置」迁成供应商清单。
 * 之前自定义接口只能填一个（地址 + 密钥 + 模型名），那批设置不能说丢就丢。
 */
function migrateCustom(a) {
  const c = a && typeof a.custom === 'object' && a.custom ? a.custom : {}
  if (Array.isArray(c.vendors)) {
    return { pick: str(c.pick, 140), vendors: normalizeVendors(c.vendors) }
  }
  const baseUrl = str(c.baseUrl, 300).replace(/\/+$/, '')
  const model = str(c.model, 120)
  const apiKey = typeof c.apiKey === 'string' ? c.apiKey.slice(0, 300) : ''
  if (!baseUrl && !model && !apiKey) return { pick: '', vendors: [] }
  const v = normVendor({ name: vendorNameFromUrl(baseUrl) || '自定义', baseUrl, apiKey, models: model ? [model] : [] }, 0)
  const first = v.models[0]
  return {
    pick: first ? `${v.id}::${first.id}` : '',
    vendors: [v],
  }
}

/* -------------------------------------------- 选中项 → 供应商与模型 */

export function parsePick(pick) {
  const s = String(pick || '')
  const at = s.indexOf('::')
  if (at < 0) return { vendorId: '', modelId: '' }
  return { vendorId: s.slice(0, at), modelId: s.slice(at + 2) }
}

/**
 * 把当前 pick 解析成"真的能用的"供应商与模型。
 * pick 空或指向已删除的条目时，回退到第一个可用的 —— 删掉正在用的模型不该让整条链路哑掉。
 */
export function resolveCustomPick(ai) {
  const c = (ai && ai.custom) || {}
  const vendors = Array.isArray(c.vendors) ? c.vendors : []
  const { vendorId, modelId } = parsePick(c.pick)
  if (vendorId) {
    const vendor = vendors.find((v) => v.id === vendorId)
    if (vendor) {
      const model = vendor.models.find((m) => m.id === modelId)
      if (model) return { vendor, model, vendors }
    }
  }
  // 回退：挑第一个"地址合法且有模型"的
  for (const vendor of vendors) {
    if (!isHttpUrl(vendor.baseUrl) || !vendor.models.length) continue
    return { vendor, model: vendor.models[0], vendors }
  }
  return { vendor: null, model: null, vendors }
}

/**
 * 自定义模型能不能用，不能就说明缺哪一样。
 * 顺序按面板上字段的先后，用户从上往下填就不会来回跳。
 */
export function customModelIssue(ai) {
  const c = (ai && ai.custom) || {}
  const vendors = Array.isArray(c.vendors) ? c.vendors : []
  if (!vendors.length) return '还没有添加供应商'
  // 一家都挑不出来时，报第一家的具体原因 —— 只说"都还不能用"，用户不知道从哪改起。
  // resolveCustomPick 只认"能用的"，所以这里不能用它的结果当报表对象。
  const { vendor, model } = resolveCustomPick(ai)
  const v = vendor || vendors[0]
  const m = vendor ? model : v.models[0] || null
  if (!isHttpUrl(v.baseUrl)) return `「${v.name}」的接口地址要填完整的 http(s) 地址`
  if (!v.models.length) return `「${v.name}」下还没有添加模型`
  if (!m) return `「${v.name}」下没有选中可用的模型`
  if (!String(v.apiKey || '').trim()) return `「${v.name}」还没有填 API Key`
  return ''
}

/** 面板里要点亮的那一对：先认用户显式选的，pick 空了再退回自动挑的那个 */
export function activePickKey(custom) {
  const c = custom || {}
  const vendors = Array.isArray(c.vendors) ? c.vendors : []
  const raw = String(c.pick || '')
  if (raw) {
    const { vendorId, modelId } = parsePick(raw)
    const v = vendors.find((x) => x.id === vendorId)
    if (v && v.models.some((m) => m.id === modelId)) return raw
  }
  const { vendor, model } = resolveCustomPick({ custom: c })
  return vendor && model ? `${vendor.id}::${model.id}` : ''
}

/** 自定义动效的起始示例：一段能直接跑起来的最小代码 */
export const CUSTOM_SAMPLE = `// 每一帧都会执行，fx 提供画布与计时
// 可用：fx.ctx / fx.w / fx.h / fx.t（秒）/ fx.dt / fx.speed / fx.intensity
//      fx.rgba(a) 取主题色 / fx.rand(a,b) 随机数 / fx.state 存跨帧状态

if (!fx.state.dots) {
  fx.state.dots = Array.from({ length: 40 }, () => ({
    x: fx.rand(0, fx.w),
    y: fx.rand(0, fx.h),
    r: fx.rand(1, 3),
  }))
}

for (const d of fx.state.dots) {
  d.y += fx.dt * 0.4 * fx.speed
  if (d.y > fx.h) d.y = 0
  fx.ctx.beginPath()
  fx.ctx.fillStyle = fx.rgba(0.45)
  fx.ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2)
  fx.ctx.fill()
}`

/* --------------------------------------------------------------- 颜色工具 */

function hexToRgb(hex) {
  let h = String(hex || '').trim().replace(/^#/, '')
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  if (!/^[0-9a-f]{6}$/i.test(h)) return { r: 79, g: 70, b: 229 }
  const n = parseInt(h, 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

function rgbToHex(r, g, b) {
  const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')
  return `#${c(r)}${c(g)}${c(b)}`
}

function rgbToHsl({ r, g, b }) {
  const rr = r / 255
  const gg = g / 255
  const bb = b / 255
  const max = Math.max(rr, gg, bb)
  const min = Math.min(rr, gg, bb)
  const l = (max + min) / 2
  let h = 0
  let s = 0
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    if (max === rr) h = ((gg - bb) / d + (gg < bb ? 6 : 0)) / 6
    else if (max === gg) h = ((bb - rr) / d + 2) / 6
    else h = ((rr - gg) / d + 4) / 6
  }
  return { h: h * 360, s, l }
}

function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360 / 360
  const hue = (p, q, t) => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  if (s === 0) {
    const v = l * 255
    return { r: v, g: v, b: v }
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  return {
    r: hue(p, q, h + 1 / 3) * 255,
    g: hue(p, q, h) * 255,
    b: hue(p, q, h - 1 / 3) * 255,
  }
}

/** 强调色的邻近色，用于渐变按钮的第二端。
 *  色相偏移刻意取小值、明度也只微调 —— 偏移一大就变成俗气的「紫蓝渐变」。 */
function hueShift(hex, deg) {
  const hsl = rgbToHsl(hexToRgb(hex))
  const rgb = hslToRgb(hsl.h + deg, Math.min(1, hsl.s * 0.96 + 0.02), Math.min(0.66, hsl.l + 0.045))
  return rgbToHex(rgb.r, rgb.g, rgb.b)
}

function alpha(hex, a) {
  const { r, g, b } = hexToRgb(hex)
  return `rgba(${r}, ${g}, ${b}, ${a})`
}

/** 只允许安全协议的图片地址，并转义后写进 CSS url() */
function safeImageUrl(url) {
  const u = String(url || '').trim()
  if (!u) return ''
  if (!/^(https?:|data:image\/)/i.test(u)) return ''
  return u.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]/g, '')
}

/* ------------------------------------------------------------ 规范化 */

export function normalizeSettings(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  const t = r.theme && typeof r.theme === 'object' ? r.theme : {}
  const e = r.effect && typeof r.effect === 'object' ? r.effect : {}
  const a = r.ai && typeof r.ai === 'object' ? r.ai : {}
  const d = DEFAULT_SETTINGS

  const hex = (v, fallback) => (/^#[0-9a-f]{6}$/i.test(String(v || '')) ? String(v).toLowerCase() : fallback)
  const num = (v, lo, hi, fallback) => {
    const n = Number(v)
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback
  }

  return {
    theme: {
      preset:
        t.preset === 'custom' || PRESETS.some((p) => p.id === t.preset) ? t.preset : d.theme.preset,
      accent: hex(t.accent, d.theme.accent),
      bgFrom: hex(t.bgFrom, d.theme.bgFrom),
      bgTo: hex(t.bgTo, d.theme.bgTo),
      bgImage: typeof t.bgImage === 'string' ? t.bgImage.slice(0, 800) : '',
      blur: num(t.blur, 0, 24, d.theme.blur),
      dim: num(t.dim, 0, 80, d.theme.dim),
      radius: num(t.radius, 0, 24, d.theme.radius),
      dark: typeof t.dark === 'boolean' ? t.dark : d.theme.dark,
      compact: !!t.compact,
    },
    effect: {
      type: EFFECTS.some((x) => x.id === e.type) ? e.type : d.effect.type,
      intensity: num(e.intensity, 0.3, 2, d.effect.intensity),
      speed: num(e.speed, 0.2, 3, d.effect.speed),
      custom: { code: String((e.custom && e.custom.code) || '').slice(0, CUSTOM_LIMITS.maxCode) },
    },
    ai: {
      mode: a.mode === 'custom' ? 'custom' : 'cloud',
      // 手填的模型 id 不在云服务目录里也允许 —— 目录可能没列全，但后端认得
      modelId: str(a.modelId, 120),
      temperature: num(a.temperature, 0, 2, d.ai.temperature),
      maxTokens: Math.round(num(a.maxTokens, 0, 32000, d.ai.maxTokens)),
      // 旧的「单条地址+密钥+模型名」在这里被迁成供应商清单，历史设置不会丢
      custom: migrateCustom(a),
    },
  }
}

/** 截断字符串字段；非字符串一律当空 */
function str(v, max) {
  return typeof v === 'string' ? v.trim().slice(0, max) : ''
}

export function applyPreset(settings, presetId) {
  const p = PRESETS.find((x) => x.id === presetId)
  if (!p) return settings
  // 展开原设置再覆盖 theme：这样以后新增设置组（比如 ai）不会在这里被悄悄丢掉
  return {
    ...settings,
    theme: {
      ...settings.theme,
      preset: p.id,
      accent: p.accent,
      bgFrom: p.bgFrom,
      bgTo: p.bgTo,
      dark: p.dark,
    },
  }
}

/* ------------------------------------------------- 按路径读写设置字段 */

/** 读 `a.b.c`；任一层缺失就返回 undefined */
function readPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj)
}

/**
 * 写 `a.b.c` 并返回新对象（逐层浅拷贝，不动原对象）。
 * 只影响路径上的分支，其余引用原样带过去 —— 设置是不可变对象，改一处不能连累别处。
 */
function writePath(obj, path, value) {
  const keys = path.split('.')
  const next = { ...obj }
  let node = next
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i]
    node[k] = { ...(node[k] || {}) }
    node = node[k]
  }
  node[keys[keys.length - 1]] = value
  return next
}

/* ---------------------------------------------------------- 应用到界面 */

export function applySettings(s) {
  const root = document.documentElement
  const th = s.theme
  const img = safeImageUrl(th.bgImage)

  root.setAttribute('data-mode', th.dark ? 'dark' : 'light')
  root.setAttribute('data-density', th.compact ? 'compact' : 'comfortable')

  root.style.setProperty('--brand', th.accent)
  root.style.setProperty('--brand-2', hueShift(th.accent, 14))
  root.style.setProperty('--brand-soft', alpha(th.accent, th.dark ? 0.18 : 0.1))
  root.style.setProperty('--brand-line', alpha(th.accent, th.dark ? 0.34 : 0.22))
  root.style.setProperty('--brand-ring', alpha(th.accent, 0.16))
  root.style.setProperty('--brand-fg', th.dark ? '#ffffff' : '#ffffff')

  root.style.setProperty('--bg-from', th.bgFrom)
  root.style.setProperty('--bg-to', th.bgTo)
  root.style.setProperty('--bg-dim', String(th.dim / 100))
  root.style.setProperty('--bg-blur', `${th.blur}px`)
  root.style.setProperty('--bg-image', img ? `url("${img}")` : 'none')

  root.style.setProperty('--radius', `${th.radius}px`)
  root.style.setProperty('--radius-sm', `${Math.max(4, Math.round(th.radius * 0.64))}px`)

  root.style.setProperty('--fx-color', th.accent)
}

/* ------------------------------------------------------------ 面板渲染 */

function presetGridHtml(activeId) {
  return PRESETS.map(
    (p) => `
    <button type="button" class="preset ${p.id === activeId ? 'active' : ''}" data-preset="${p.id}"
            title="${escapeHtml(p.label)}">
      <span class="preset-swatch" style="background:linear-gradient(135deg,${p.bgFrom},${p.bgTo});border-color:${p.accent}">
        <i style="background:${p.accent}"></i>
      </span>
      <span class="preset-label">${escapeHtml(p.label)}</span>
    </button>`
  ).join('')
}

function effectGridHtml(activeId) {
  return EFFECTS.map(
    (e) => `
    <button type="button" class="fx-card ${e.id === activeId ? 'active' : ''}" data-fx="${e.id}"
            title="${escapeHtml(e.hint)}" aria-pressed="${e.id === activeId}">
      <span class="fx-demo" aria-hidden="true"><i></i><i></i><i></i></span>
      <span class="fx-name">${escapeHtml(e.label)}</span>
      <span class="fx-hint">${escapeHtml(e.hint)}</span>
    </button>`
  ).join('')
}

/**
 * 供应商清单：每家带自己的地址与密钥，下面挂它的模型。
 * 注意 button 里不能再嵌 button（非法 HTML，且点击会串），所以"选中模型"和"删除模型"
 * 是并列的兄弟按钮，不是嵌套。
 */
function vendorListHtml(custom) {
  const list = custom && Array.isArray(custom.vendors) ? custom.vendors : []
  if (!list.length) {
    return '<p class="ai-models-msg">还没有供应商，点下面的「+ 添加供应商」开始。</p>'
  }
  const onKey = activePickKey(custom)

  return list
    .map((v) => {
      const vid = escapeHtml(v.id)
      const models = v.models.length
        ? v.models
            .map((m) => {
              const key = `${v.id}::${m.id}`
              const on = key === onKey
              return `
          <div class="model-row ${on ? 'active' : ''}">
            <button type="button" class="model-pick" data-pick="${escapeHtml(key)}" aria-pressed="${on}">
              <span class="model-name">${escapeHtml(m.name)}</span>
            </button>
            <button type="button" class="model-del" data-model-del="${escapeHtml(key)}"
                    aria-label="删除模型 ${escapeHtml(m.name)}" title="删除模型">×</button>
          </div>`
            })
            .join('')
        : '<p class="ai-models-msg">这家下面还没有模型</p>'

      return `
      <div class="vendor" data-vendor="${vid}">
        <div class="vendor-head">
          <input type="text" class="vendor-name" data-vendor-field="name" data-vendor-id="${vid}"
                 placeholder="供应商名（如 DeepSeek）" value="${escapeHtml(v.name)}"
                 aria-label="供应商名">
          <button type="button" class="vendor-del" data-vendor-del="${vid}"
                  aria-label="删除供应商 ${escapeHtml(v.name)}" title="删除供应商">×</button>
        </div>
        <input type="url" class="set-input" data-vendor-field="baseUrl" data-vendor-id="${vid}"
               placeholder="https://api.example.com/v1" value="${escapeHtml(v.baseUrl)}"
               aria-label="接口地址">
        <input type="password" class="set-input" data-vendor-field="apiKey" data-vendor-id="${vid}"
               placeholder="API Key（sk-…）" value="${escapeHtml(v.apiKey)}"
               autocomplete="off" aria-label="API Key">
        <div class="model-list">${models}</div>
        <div class="model-add">
          <input type="text" class="model-new" data-model-new="${vid}"
                 placeholder="模型名，回车添加" aria-label="新增模型名">
          <button type="button" class="btn btn-ghost btn-sm" data-set-act="add-model"
                  data-vendor-add="${vid}">添加模型</button>
        </div>
      </div>`
    })
    .join('')
}

function row(label, control, out) {
  return `<label class="set-row"><span class="set-label">${escapeHtml(label)}</span>${control}${
    out === undefined ? '' : `<b class="set-out" data-out="${out}"></b>`
  }</label>`
}

/**
 * 把设置面板渲染进 host，并接管交互。
 * @param {HTMLElement} host 面板容器
 * @param {object} settings 当前设置（会被深拷贝，不直接改外部对象）
 * @param {(next:object)=>void} onChange 每次改动后回调（用于实时应用 + 触发保存）
 */
export function mountSettingsPanel(host, settings, onChange, opts = {}) {
  let cur = normalizeSettings(settings)

  // 面板每次打开都会重新挂载。监听器绑在常驻的 host 上，必须把上一轮撤掉，
  // 否则监听器会一轮轮累积，一次点击触发多次提交。
  if (typeof host.__panelAbort === 'function') host.__panelAbort()
  const ac = new AbortController()
  let codeTimer = null
  // 模型目录的请求也要能撤销：面板关了不该还有请求在跑、回来再往已卸载的 DOM 里写
  let modelsAbort = null
  // 撤监听器时一并撤掉待执行的编译，避免面板关了还在跑
  host.__panelAbort = () => {
    ac.abort()
    if (codeTimer) {
      clearTimeout(codeTimer)
      codeTimer = null
    }
    if (modelsAbort) {
      modelsAbort.abort()
      modelsAbort = null
    }
  }
  const listen = { signal: ac.signal }

  const setFxStatus = (text, kind) => {
    const el = host.querySelector('[data-fx-status]')
    if (!el) return
    el.textContent = text
    el.classList.toggle('is-error', kind === 'error')
  }

  host.innerHTML = `
    <div class="set-head">
      <h2>个性设置</h2>
      <button type="button" class="btn btn-ghost btn-sm" data-set-act="close">关闭</button>
    </div>
    <div class="set-body">
      <section class="set-group">
        <h3>主题配色</h3>
        <div class="preset-grid">${presetGridHtml(cur.theme.preset)}</div>
      </section>

      <section class="set-group">
        <h3>自定义颜色</h3>
        ${row('强调色', `<input type="color" data-set="accent" value="${cur.theme.accent}">`)}
        ${row('背景起色', `<input type="color" data-set="bgFrom" value="${cur.theme.bgFrom}">`)}
        ${row('背景止色', `<input type="color" data-set="bgTo" value="${cur.theme.bgTo}">`)}
        <p class="set-hint">改任意颜色会切到「自定义」，深/浅色基调保持不变。</p>
      </section>

      <section class="set-group">
        <h3>背景图片</h3>
        <input type="url" class="set-input" data-set="bgImage" placeholder="粘贴图片直链 https://…（留空则只用渐变色）"
               value="${escapeHtml(cur.theme.bgImage)}">
        <p class="set-hint">建议用 https 图片直链，http 链接可能被浏览器拦截而显示不出来。</p>
        ${row('模糊', `<input type="range" data-set="blur" min="0" max="24" step="1" value="${cur.theme.blur}">`, 'blur')}
        ${row('遮罩浓度', `<input type="range" data-set="dim" min="0" max="80" step="1" value="${cur.theme.dim}">`, 'dim')}
      </section>

      <section class="set-group">
        <h3>动态特效</h3>
        <div class="fx-grid">${effectGridHtml(cur.effect.type)}</div>
        ${row('密度', `<input type="range" data-set="intensity" min="0.3" max="2" step="0.1" value="${cur.effect.intensity}">`, 'intensity')}
        ${row('速度', `<input type="range" data-set="speed" min="0.2" max="3" step="0.1" value="${cur.effect.speed}">`, 'speed')}

        <div class="fx-code ${cur.effect.type === 'custom' ? '' : 'is-off'}" data-fx-code>
          <div class="fx-code-head">
            <span>自定义 JS（每帧执行）</span>
            <button type="button" class="btn btn-ghost btn-sm" data-set-act="sample">填入示例</button>
          </div>
          <textarea class="fx-code-area" data-set="customCode" spellcheck="false"
                    placeholder="写一个函数体，参数 fx。例如：fx.ctx.fillRect(0, 0, 10, 10)"
                    rows="10">${escapeHtml(cur.effect.custom.code)}</textarea>
          <p class="fx-code-status" data-fx-status></p>
          <p class="set-hint">这段代码在你的浏览器里以本页身份运行，只粘贴你自己写的或信任的代码。
            连续出错 3 次或每帧耗时持续超过 60ms 会自动停用。</p>
        </div>
      </section>

      <section class="set-group">
        <h3>AI 模型</h3>
        <div class="ai-mode" role="tablist" aria-label="模型来源">
          <button type="button" class="ai-mode-tab ${cur.ai.mode === 'cloud' ? 'active' : ''}"
                  role="tab" aria-selected="${cur.ai.mode === 'cloud'}" data-ai-mode="cloud">云服务模型</button>
          <button type="button" class="ai-mode-tab ${cur.ai.mode === 'custom' ? 'active' : ''}"
                  role="tab" aria-selected="${cur.ai.mode === 'custom'}" data-ai-mode="custom">自定义接口</button>
        </div>

        <div class="ai-pane ${cur.ai.mode === 'cloud' ? '' : 'is-off'}" data-ai-pane="cloud">
          <div class="ai-models" data-ai-models>
            <p class="ai-models-msg">正在读取可用模型…</p>
          </div>
          <div class="ai-pick">
            <label class="ai-pick-label" for="ai-model-manual">手动指定模型 ID</label>
            <div class="ai-pick-row">
              <input type="text" id="ai-model-manual" class="set-input" data-set="ai.modelId"
                     placeholder="留空 = 自动使用第一个可用模型" value="${escapeHtml(cur.ai.modelId)}">
              <button type="button" class="btn btn-ghost btn-sm" data-set-act="ai-refresh">刷新</button>
            </div>
          </div>
          <p class="set-hint">模型由云服务提供，按当前应用的名义调用，不需要你填密钥。
            目录里没列出的模型也可以手填 ID 试试。</p>
        </div>

        <div class="ai-pane ${cur.ai.mode === 'custom' ? '' : 'is-off'}" data-ai-pane="custom">
          <div class="vendor-list" data-vendor-list>${vendorListHtml(cur.ai.custom)}</div>
          <button type="button" class="btn btn-ghost btn-sm" data-set-act="add-vendor">+ 添加供应商</button>
          <p class="set-hint" data-ai-custom-status></p>
          <p class="set-hint set-warn">
            <strong>密钥会随设置同步到云端</strong>，换设备免重填；请只在信任的环境里填。
            地址需兼容 OpenAI 的 <code>/chat/completions</code>；浏览器直连要求对方允许跨域，
            被拦时请填你自己的中转地址。
          </p>
        </div>

        ${row('温度', `<input type="range" data-set="ai.temperature" min="0" max="2" step="0.1" value="${cur.ai.temperature}">`, 'ai.temperature')}
        <p class="set-hint">越高越发散，越低越稳。整理笔记建议 0.3~0.7。</p>
        ${row('最大长度', `<input type="range" data-set="ai.maxTokens" min="0" max="8192" step="256" value="${cur.ai.maxTokens}">`, 'ai.maxTokens')}
        <p class="set-hint">单次回复的 token 上限，0 表示交给服务端默认。</p>
      </section>

      <section class="set-group">
        <h3>界面</h3>
        ${row('圆角', `<input type="range" data-set="radius" min="0" max="24" step="1" value="${cur.theme.radius}">`, 'radius')}
        <label class="set-row set-switch">
          <span class="set-label">紧凑列表</span>
          <input type="checkbox" data-set="compact" ${cur.theme.compact ? 'checked' : ''}>
        </label>
      </section>
    </div>
    <div class="set-foot">
      <button type="button" class="btn btn-ghost btn-sm" data-set-act="reset">恢复默认</button>
      <span class="set-status" data-set-status>改动会自动保存到云端</span>
    </div>`

  const q = (sel) => host.querySelector(sel)

  /**
   * data-set 支持三种写法：theme 的裸字段名、effect 的裸字段名、`ai.xxx` 路径。
   * customCode 存在 effect.custom.code 里（不是 effect.customCode）—— 不加这条特判，
   * sync 会把 textarea 写成 undefined，用户敲一半的代码就被清空了。
   */
  function readSet(key) {
    if (key === 'customCode') return cur.effect.custom.code
    if (key.startsWith('ai.')) return readPath(cur, key)
    return key in cur.theme ? cur.theme[key] : cur.effect[key]
  }

  /** 写回并返回新设置。一律展开原对象，新增的设置组不会在这里被丢掉 */
  function writeSet(key, value) {
    if (key === 'customCode') return { ...cur, effect: { ...cur.effect, custom: { code: value } } }
    if (key.startsWith('ai.')) return writePath(cur, key, value)
    if (key in cur.theme) {
      // 手动改色即进入自定义模式，但保留当前深浅基调
      const presetTouched = ['accent', 'bgFrom', 'bgTo'].includes(key)
      return {
        ...cur,
        theme: { ...cur.theme, [key]: value, ...(presetTouched ? { preset: 'custom' } : {}) },
      }
    }
    return { ...cur, effect: { ...cur.effect, [key]: value } }
  }

  /** 结构性改动（增删供应商 / 增删模型 / 换选中）后重画清单 */
  function renderVendors() {
    const box = q('[data-vendor-list]')
    if (box) box.innerHTML = vendorListHtml(cur.ai.custom)
  }

  /** 改供应商清单。一律过 normalize 补 id、去尾斜杠，但不重画 —— 重画会打断正在的输入 */
  function commitVendors(vendors, { rerender = false, pick } = {}) {
    cur = normalizeSettings({
      ...cur,
      ai: { ...cur.ai, custom: { ...cur.ai.custom, vendors, pick: pick ?? cur.ai.custom.pick } },
    })
    if (rerender) renderVendors()
    syncCustomStatus()
    onChange(cur)
  }

  const vendorsOf = () => (cur.ai.custom && cur.ai.custom.vendors) || []

  function syncCustomStatus() {
    const el = q('[data-ai-custom-status]')
    if (!el) return
    const issue = customModelIssue(cur.ai)
    el.textContent = issue ? `还不能用：${issue}` : '配置完整 ✓'
    el.classList.toggle('is-error', !!issue)
  }

  /**
   * 模型目录是权威来源，拿不到就把**真实原因**摆出来并给重试按钮 ——
   * 静默降级成"暂无模型"会让人以为是服务端没有模型，而不是读取失败了。
   */
  async function loadAiModels() {
    const box = q('[data-ai-models]')
    if (!box) return
    if (typeof opts.loadModels !== 'function') {
      box.innerHTML = '<p class="ai-models-msg is-error">没有接入模型目录</p>'
      return
    }
    if (modelsAbort) modelsAbort.abort()
    const ctl = new AbortController()
    modelsAbort = ctl
    box.innerHTML = '<p class="ai-models-msg">正在读取可用模型…</p>'
    try {
      const models = await opts.loadModels(ctl.signal)
      if (ctl.signal.aborted) return
      const usable = (models || []).filter((m) => m && m.disabled !== true && m.enabled !== false)
      if (!usable.length) {
        box.innerHTML =
          '<p class="ai-models-msg is-error">服务端没有返回可用模型，请到管理页确认模型配置</p>'
        return
      }
      const items = [
        { id: '', label: '自动', hint: '使用第一个可用模型' },
        ...usable.map((m) => ({ id: String(m.id), label: String(m.id), hint: m.provider || m.owned_by || '' })),
      ]
      box.innerHTML = items
        .map(
          (m) => `
        <button type="button" class="ai-model ${m.id === cur.ai.modelId ? 'active' : ''}"
                data-ai-model="${escapeHtml(m.id)}" aria-pressed="${m.id === cur.ai.modelId}">
          <span class="ai-model-name">${escapeHtml(m.label)}</span>
          ${m.hint ? `<span class="ai-model-hint">${escapeHtml(m.hint)}</span>` : ''}
        </button>`
        )
        .join('')
      // 手填了一个目录里没有的 ID 时，列表里没有能点亮的项，得说清楚
      const manual = cur.ai.modelId && !items.some((m) => m.id === cur.ai.modelId)
      const note = document.createElement('p')
      note.className = 'ai-models-msg'
      note.textContent = manual
        ? `正在使用目录外的模型 ID「${cur.ai.modelId}」`
        : `共 ${usable.length} 个可用模型`
      box.appendChild(note)
    } catch (err) {
      if (ctl.signal.aborted) return
      const msg = (err && (err.message || err.error_description)) || '未知错误'
      box.innerHTML = `
        <p class="ai-models-msg is-error">读取模型失败：${escapeHtml(String(msg))}</p>
        <button type="button" class="btn btn-ghost btn-sm" data-set-act="ai-refresh">重试</button>`
    }
  }

  function sync() {
    host.querySelectorAll('[data-preset]').forEach((b) => {
      b.classList.toggle('active', b.dataset.preset === cur.theme.preset)
    })
    host.querySelectorAll('[data-fx]').forEach((b) => {
      const on = b.dataset.fx === cur.effect.type
      b.classList.toggle('active', on)
      // class 与无障碍状态必须同步更新，否则读屏器会拿到过期的选中态
      b.setAttribute('aria-pressed', String(on))
    })
    host.querySelectorAll('[data-set]').forEach((el) => {
      const val = readSet(el.dataset.set)
      if (el.type === 'checkbox') el.checked = !!val
      else el.value = val
    })
    host.querySelectorAll('[data-out]').forEach((el) => {
      const val = readSet(el.dataset.out)
      el.textContent = typeof val === 'number' ? String(Math.round(val * 10) / 10) : String(val)
    })

    // 模型来源是二选一，pane 与 tab 的状态必须成对更新
    host.querySelectorAll('[data-ai-mode]').forEach((b) => {
      const on = b.dataset.aiMode === cur.ai.mode
      b.classList.toggle('active', on)
      b.setAttribute('aria-selected', String(on))
    })
    host.querySelectorAll('[data-ai-pane]').forEach((p) => {
      p.classList.toggle('is-off', p.dataset.aiPane !== cur.ai.mode)
    })
    syncCustomStatus()
    // 特效为「无」时，密度/速度没有作用对象 —— 禁掉并整行淡化，避免"拖了没反应"的困惑
    const fxOff = cur.effect.type === 'none'
    host.querySelectorAll('[data-set="intensity"],[data-set="speed"]').forEach((el) => {
      el.disabled = fxOff
      const rowEl = el.closest('.set-row')
      if (rowEl) rowEl.classList.toggle('is-disabled', fxOff)
    })
    // 代码区只在「自定义」下出现；密度/速度对自定义同样有效（fx.speed / fx.intensity）
    const codeBox = q('[data-fx-code]')
    if (codeBox) codeBox.classList.toggle('is-off', cur.effect.type !== 'custom')
  }

  function commit() {
    cur = normalizeSettings(cur)
    applySettings(cur)
    sync()
    onChange(cur)
  }

  host.addEventListener('click', (e) => {
    const preset = e.target.closest('[data-preset]')
    if (preset) {
      cur = { ...applyPreset(cur, preset.dataset.preset), effect: cur.effect }
      commit()
      return
    }
    const fx = e.target.closest('[data-fx]')
    if (fx) {
      cur = writeSet('type', fx.dataset.fx)
      commit()
      return
    }
    const mode = e.target.closest('[data-ai-mode]')
    if (mode) {
      cur = writeSet('ai.mode', mode.dataset.aiMode)
      commit()
      // 切到云服务那侧时才去拉目录：自定义模式下这个请求没有意义
      if (cur.ai.mode === 'cloud') loadAiModels()
      return
    }
    const model = e.target.closest('[data-ai-model]')
    if (model) {
      cur = writeSet('ai.modelId', model.dataset.aiModel)
      commit()
      loadAiModels() // 重画选中态
      return
    }
    const pickBtn = e.target.closest('[data-pick]')
    if (pickBtn) {
      commitVendors(vendorsOf(), { rerender: true, pick: pickBtn.dataset.pick })
      return
    }
    const delVendorBtn = e.target.closest('[data-vendor-del]')
    if (delVendorBtn) {
      const id = delVendorBtn.dataset.vendorDel
      commitVendors(
        vendorsOf().filter((v) => v.id !== id),
        { rerender: true }
      )
      // 焦点原本在被删掉的按钮上，重画后它不存在了 —— 还给"添加"按钮，别掉进虚空
      q('[data-set-act="add-vendor"]')?.focus()
      return
    }
    const delModelBtn = e.target.closest('[data-model-del]')
    if (delModelBtn) {
      const { vendorId, modelId } = parsePick(delModelBtn.dataset.modelDel)
      commitVendors(
        vendorsOf().map((v) =>
          v.id === vendorId ? { ...v, models: v.models.filter((m) => m.id !== modelId) } : v
        ),
        { rerender: true }
      )
      return
    }

    const act = e.target.closest('[data-set-act]')?.dataset.setAct
    if (act === 'reset') {
      cur = normalizeSettings(DEFAULT_SETTINGS)
      commit()
      return
    }
    if (act === 'sample') {
      const area = q('[data-set="customCode"]')
      if (area) {
        area.value = CUSTOM_SAMPLE
        // 手动派发一次，走与键盘输入相同的路径
        area.dispatchEvent(new Event('input', { bubbles: true }))
      }
      return
    }
    if (act === 'ai-refresh') {
      loadAiModels()
      return
    }
    if (act === 'add-vendor') {
      if (vendorsOf().length >= VENDOR_LIMITS.vendors) return
      commitVendors([...vendorsOf(), { name: '', baseUrl: '', apiKey: '', models: [] }], {
        rerender: true,
      })
      // 新供应商在最下面，把焦点送过去，省得用户自己找
      const names = host.querySelectorAll('.vendor [data-vendor-field="name"]')
      names[names.length - 1]?.focus()
      return
    }
    if (act === 'add-model') {
      const id = e.target.closest('[data-vendor-add]')?.dataset.vendorAdd
      const input = id ? host.querySelector(`[data-model-new="${id}"]`) : null
      const name = (input && input.value ? input.value : '').trim()
      if (!id || !name) {
        input?.focus()
        return
      }
      // id 必须在这里就定下来：交给 normalize 补的话，每次规范化都会新生成一个，
      // 于是"先算 id 再选中"会选中一个根本不存在的 id（表现是选中态根本没变）。
      const fresh = { id: uid('m'), name }
      const vendors = vendorsOf().map((v) =>
        v.id === id ? { ...v, models: [...v.models, fresh] } : v
      )
      // 刚添加的模型通常就是想用的那个 —— 直接选中它
      commitVendors(vendors, { rerender: true, pick: `${id}::${fresh.id}` })
      return
    }
    if (act === 'close') host.dispatchEvent(new CustomEvent('settings-close', { bubbles: true }))
  }, listen)

  // 动效代码编译失败 / 自动停用时，把原因显示在面板里
  document.addEventListener('fx-custom-failed', (e) => {
    setFxStatus((e.detail && e.detail.reason) || '自定义动效已停用', 'error')
  }, listen)

  // 「新模型名」输入框里回车 = 添加，省得每次都要去点按钮
  host.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return
    const input = e.target.closest('[data-model-new]')
    if (!input) return
    e.preventDefault()
    host.querySelector(`[data-set-act="add-model"][data-vendor-add="${input.dataset.modelNew}"]`)?.click()
  }, listen)

  host.addEventListener('input', (e) => {
    // 供应商的地址 / 密钥 / 名字：改完不重画清单，重画会把正在敲的输入框换掉
    const vf = e.target.closest('[data-vendor-field]')
    if (vf) {
      const id = vf.dataset.vendorId
      const field = vf.dataset.vendorField
      commitVendors(
        vendorsOf().map((v) => (v.id === id ? { ...v, [field]: vf.value } : v))
      )
      return
    }

    const el = e.target.closest('[data-set]')
    if (!el) return
    const key = el.dataset.set
    let value
    if (el.type === 'checkbox') value = el.checked
    else if (el.type === 'range') value = Number(el.value)
    else value = el.value

    // 动效代码：每敲一个字符就重编译太浪费，等停手 600ms 再编译运行
    if (key === 'customCode') {
      cur = writeSet(key, value)
      setFxStatus('输入中…', '')
      if (codeTimer) clearTimeout(codeTimer)
      codeTimer = setTimeout(() => {
        codeTimer = null
        onChange(cur)
      }, 600)
      return
    }

    cur = writeSet(key, value)

    // AI 这几个字段是手输的，落盘前先规范化（地址去尾斜杠、数值夹紧）。
    // 这里不能整体 sync() —— sync 会重写 el.value，正在输入的框光标会被拽到末尾。
    if (key.startsWith('ai.')) cur = normalizeSettings(cur)

    // 自定义接口的"还缺什么"要边打边更新
    if (key.startsWith('ai.custom.')) syncCustomStatus()

    applySettings(cur)
    host.querySelectorAll(`[data-out="${key}"]`).forEach((b) => {
      b.textContent = typeof value === 'number' ? String(Math.round(value * 10) / 10) : String(value)
    })
    if (key in cur.theme) {
      host.querySelectorAll('[data-preset]').forEach((b) => b.classList.toggle('active', b.dataset.preset === cur.theme.preset))
    }
    onChange(cur)
  }, listen)

  sync()
  // 模型目录只在云服务模式下有意义，自定义模式不必发这个请求
  if (cur.ai.mode === 'cloud') loadAiModels()
  return {
    get value() {
      return cur
    },
    sync,
    reloadModels: loadAiModels,
    setStatus(text) {
      const el = q('[data-set-status]')
      if (el) el.textContent = text
    },
  }
}
