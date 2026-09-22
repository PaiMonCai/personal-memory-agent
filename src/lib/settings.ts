/**
 * 设置的数据形态、规范化与"应用到界面"。
 * 面板渲染在 components/SettingsPanel.tsx，云端读写由 store 负责。
 */
import { CUSTOM_LIMITS, EFFECTS } from './effects'
import type { Settings, ThemeSettings, Vendor } from './types'

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

export const DEFAULT_SETTINGS: Settings = {
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
  // mode='cloud' 时走服务器模型（modelId 空 = 自动挑第一个可用）；
  // mode='custom' 时直连下面填的 OpenAI 兼容接口，不再经过服务器。
  ai: {
    mode: 'cloud',
    modelId: '',
    temperature: 1,
    maxTokens: 0, // 0 = 不传，交给服务端默认
    // pick 形如 "vendorId::modelId"，空 = 自动挑第一个可用的。
    custom: { pick: '', vendors: [] },
  },
}

/** 供应商清单的容量上限。设上限是为了别让设置列无限膨胀 */
export const VENDOR_LIMITS = { vendors: 20, modelsPerVendor: 30 }

/** 自定义接口的地址要能拼成 `<base>/chat/completions`，这里做最低限度的合法性判断 */
export function isHttpUrl(v: unknown): boolean {
  try {
    const u = new URL(String(v || '').trim())
    return u.protocol === 'https:' || u.protocol === 'http:'
  } catch {
    return false
  }
}

/* ------------------------------------------------- 供应商清单的规范化 */

let uidSeq = 0
export function uid(prefix = 'v'): string {
  uidSeq += 1
  return `${prefix}${Date.now().toString(36)}${uidSeq.toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/** 从地址里猜一个供应商名，省得用户每个都手打一遍 */
function vendorNameFromUrl(baseUrl: string): string {
  try {
    const host = new URL(baseUrl).hostname
    const main = host.replace(/^www\./, '').split('.')[0] || ''
    return main ? main.slice(0, 24) : ''
  } catch {
    return ''
  }
}

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : ''
}

function normVendor(raw: unknown, index: number): Vendor {
  const v = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const baseUrl = str(v.baseUrl, 300).replace(/\/+$/, '')
  const name = str(v.name, 40) || vendorNameFromUrl(baseUrl) || `供应商 ${index + 1}`
  const modelsRaw = Array.isArray(v.models) ? v.models : []
  const seen = new Set<string>()
  const models = modelsRaw
    .slice(0, VENDOR_LIMITS.modelsPerVendor)
    .map((m) => {
      const item = m && typeof m === 'object' ? (m as Record<string, unknown>) : {}
      const label = str(typeof m === 'string' ? m : item.name, 120)
      const id = str(item.id, 40) || uid('m')
      // 同一供应商下重名没有意义，直接丢掉后面的
      if (!label || seen.has(label)) return null
      seen.add(label)
      return { id, name: label }
    })
    .filter((x): x is { id: string; name: string } => x !== null)
  return {
    id: str(v.id, 40) || uid(),
    name,
    baseUrl,
    apiKey: typeof v.apiKey === 'string' ? v.apiKey.slice(0, 300) : '',
    models,
  }
}

/** 规范化整份清单：补 id、去重、夹紧容量 */
export function normalizeVendors(raw: unknown): Vendor[] {
  const list = Array.isArray(raw) ? raw : []
  const out: Vendor[] = []
  const ids = new Set<string>()
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
function migrateCustom(a: Record<string, unknown>): { pick: string; vendors: Vendor[] } {
  const c = a && typeof a.custom === 'object' && a.custom ? (a.custom as Record<string, unknown>) : {}
  if (Array.isArray(c.vendors)) {
    return { pick: str(c.pick, 140), vendors: normalizeVendors(c.vendors) }
  }
  const baseUrl = str(c.baseUrl, 300).replace(/\/+$/, '')
  const model = str(c.model, 120)
  const apiKey = typeof c.apiKey === 'string' ? c.apiKey.slice(0, 300) : ''
  if (!baseUrl && !model && !apiKey) return { pick: '', vendors: [] }
  const v = normVendor(
    { name: vendorNameFromUrl(baseUrl) || '自定义', baseUrl, apiKey, models: model ? [model] : [] },
    0
  )
  const first = v.models[0]
  return {
    pick: first ? `${v.id}::${first.id}` : '',
    vendors: [v],
  }
}

/* -------------------------------------------- 选中项 → 供应商与模型 */

export function parsePick(pick: string): { vendorId: string; modelId: string } {
  const s = String(pick || '')
  const at = s.indexOf('::')
  if (at < 0) return { vendorId: '', modelId: '' }
  return { vendorId: s.slice(0, at), modelId: s.slice(at + 2) }
}

/**
 * 把当前 pick 解析成"真的能用的"供应商与模型。
 * pick 空或指向已删除的条目时，回退到第一个可用的 —— 删掉正在用的模型不该让整条链路哑掉。
 */
export function resolveCustomPick(ai: { custom?: { pick?: string; vendors?: Vendor[] } } | null | undefined): {
  vendor: Vendor | null
  model: { id: string; name: string } | null
  vendors: Vendor[]
} {
  const c = (ai && ai.custom) || {}
  const vendors = Array.isArray(c.vendors) ? c.vendors : []
  const { vendorId, modelId } = parsePick(String(c.pick || ''))
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
export function customModelIssue(ai: { custom?: { vendors?: Vendor[] } } | null | undefined): string {
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
export function activePickKey(custom: { pick?: string; vendors?: Vendor[] } | undefined): string {
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

function hexToRgb(hex: string) {
  let h = String(hex || '').trim().replace(/^#/, '')
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  if (!/^[0-9a-f]{6}$/i.test(h)) return { r: 79, g: 70, b: 229 }
  const n = parseInt(h, 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

function rgbToHex(r: number, g: number, b: number): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')
  return `#${c(r)}${c(g)}${c(b)}`
}

function rgbToHsl({ r, g, b }: { r: number; g: number; b: number }) {
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

function hslToRgb(h: number, s: number, l: number) {
  const hh = (((h % 360) + 360) % 360) / 360
  const hue = (p: number, q: number, t: number) => {
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
    r: hue(p, q, hh + 1 / 3) * 255,
    g: hue(p, q, hh) * 255,
    b: hue(p, q, hh - 1 / 3) * 255,
  }
}

/** 强调色的邻近色，用于渐变按钮的第二端。
 *  色相偏移刻意取小值、明度也只微调 —— 偏移一大就变成俗气的「紫蓝渐变」。 */
function hueShift(hex: string, deg: number): string {
  const hsl = rgbToHsl(hexToRgb(hex))
  const rgb = hslToRgb(hsl.h + deg, Math.min(1, hsl.s * 0.96 + 0.02), Math.min(0.66, hsl.l + 0.045))
  return rgbToHex(rgb.r, rgb.g, rgb.b)
}

function alpha(hex: string, a: number): string {
  const { r, g, b } = hexToRgb(hex)
  return `rgba(${r}, ${g}, ${b}, ${a})`
}

/** 只允许安全协议的图片地址，并转义后写进 CSS url() */
function safeImageUrl(url: unknown): string {
  const u = String(url || '').trim()
  if (!u) return ''
  if (!/^(https?:|data:image\/)/i.test(u)) return ''
  return u.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]/g, '')
}

/* ------------------------------------------------------------ 规范化 */

export function normalizeSettings(raw: unknown): Settings {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const t = r.theme && typeof r.theme === 'object' ? (r.theme as Record<string, unknown>) : {}
  const e = r.effect && typeof r.effect === 'object' ? (r.effect as Record<string, unknown>) : {}
  const a = r.ai && typeof r.ai === 'object' ? (r.ai as Record<string, unknown>) : {}
  const d = DEFAULT_SETTINGS

  const hex = (v: unknown, fallback: string) =>
    /^#[0-9a-f]{6}$/i.test(String(v || '')) ? String(v).toLowerCase() : fallback
  const num = (v: unknown, lo: number, hi: number, fallback: number) => {
    const n = Number(v)
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback
  }

  return {
    theme: {
      preset:
        t.preset === 'custom' || PRESETS.some((p) => p.id === t.preset)
          ? String(t.preset)
          : d.theme.preset,
      accent: hex(t.accent, d.theme.accent),
      bgFrom: hex(t.bgFrom, d.theme.bgFrom),
      bgTo: hex(t.bgTo, d.theme.bgTo),
      bgImage: typeof t.bgImage === 'string' ? t.bgImage.slice(0, 800) : '',
      blur: num(t.blur, 0, 24, d.theme.blur),
      dim: num(t.dim, 0, 80, d.theme.dim),
      radius: num(t.radius, 0, 24, d.theme.radius),
      dark: typeof t.dark === 'boolean' ? t.dark : d.theme.dark,
      compact: !!t.compact,
    } as ThemeSettings,
    effect: {
      type: EFFECTS.some((x) => x.id === e.type) ? String(e.type) : d.effect.type,
      intensity: num(e.intensity, 0.3, 2, d.effect.intensity),
      speed: num(e.speed, 0.2, 3, d.effect.speed),
      custom: { code: String((e.custom && typeof e.custom === 'object' ? (e.custom as { code?: unknown }).code : '') || '').slice(0, CUSTOM_LIMITS.maxCode) },
    },
    ai: {
      mode: a.mode === 'custom' ? 'custom' : 'cloud',
      // 手填的模型 id 不在服务端目录里也允许 —— 目录可能没列全，但后端认得
      modelId: str(a.modelId, 120),
      temperature: num(a.temperature, 0, 2, d.ai.temperature),
      maxTokens: Math.round(num(a.maxTokens, 0, 32000, d.ai.maxTokens)),
      // 旧的「单条地址+密钥+模型名」在这里被迁成供应商清单，历史设置不会丢
      custom: migrateCustom(a as Record<string, unknown>),
    },
  }
}

export function applyPreset(settings: Settings, presetId: string): Settings {
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

/* --------------------------------------------- 按路径读写设置字段 */

/** 读 `a.b.c`；任一层缺失就返回 undefined */
export function readPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]), obj)
}

/**
 * 写 `a.b.c` 并返回新对象（逐层浅拷贝，不动原对象）。
 * 只影响路径上的分支，其余引用原样带过去 —— 设置是不可变对象，改一处不能连累别处。
 */
export function writePath<T>(obj: T, path: string, value: unknown): T {
  const keys = path.split('.')
  const next = { ...(obj as Record<string, unknown>) } as Record<string, unknown>
  let node = next
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i]
    node[k] = { ...((node[k] as Record<string, unknown>) || {}) }
    node = node[k] as Record<string, unknown>
  }
  node[keys[keys.length - 1]] = value
  return next as T
}

/* ---------------------------------------------------------- 应用到界面 */

export function applySettings(s: Settings): void {
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
