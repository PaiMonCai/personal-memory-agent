/**
 * 背景动态特效。
 *
 * 单张全屏 canvas，requestAnimationFrame 驱动；指针事件穿透，不影响操作。
 * 页面切到后台时自动暂停，尺寸变化时按 devicePixelRatio 重建（上限 2，避免高分屏掉帧）。
 * 颜色统一取自 CSS 变量 --fx-color，因此切换主题时会自动跟着变。
 */

export interface FxContext {
  ctx: CanvasRenderingContext2D | null
  w: number
  h: number
  t: number
  dt: number
  speed: number
  intensity: number
  color: { r: number; g: number; b: number }
  rgba: (a: number) => string
  state: Record<string, unknown>
  rand: (a?: number, b?: number) => number
}

export const EFFECTS = [
  { id: 'none', label: '无', hint: '干净的纯背景' },
  { id: 'stars', label: '星空', hint: '细密星点，缓慢漂移与明灭' },
  { id: 'snow', label: '飞絮', hint: '轻柔飘落，带横向摆动' },
  { id: 'bubbles', label: '浮泡', hint: '半透明气泡缓缓上浮' },
  { id: 'aurora', label: '极光', hint: '流动的极光色带' },
  { id: 'orbit', label: '星轨', hint: '从中心向外放射的轨迹' },
  { id: 'custom', label: '自定义', hint: '自己写一段 JS 来画' },
]

/** 自定义动效：用户代码作为函数体，只接收 fx 一个参数。 */
export const CUSTOM_LIMITS = { maxCode: 8000, maxErrors: 3, maxSlow: 5, slowMs: 60 }

export function effectLabel(id: string): string {
  return (EFFECTS.find((e) => e.id === id) || EFFECTS[0]).label
}

const BASE_COUNT: Record<string, number> = { stars: 170, snow: 80, bubbles: 42, orbit: 64, none: 0, aurora: 0 }
const MAX_COUNT = 320

let canvas: HTMLCanvasElement | null = null
let ctx: CanvasRenderingContext2D | null = null
let raf = 0
let running = false
let last = 0
let w = 0
let h = 0
let particles: Record<string, number>[] = []
let cfg = { type: 'none', intensity: 1, speed: 1 }
let color = { r: 90, g: 96, b: 120 }

/* ----------------------------------------------------------- 颜色与尺寸 */

function readColor() {
  try {
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--fx-color').trim()
    const m = raw.match(/^#?([0-9a-f]{6})$/i)
    if (m) {
      const n = parseInt(m[1], 16)
      color = { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
      return
    }
    const rgb = raw.match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/)
    if (rgb) color = { r: +rgb[1], g: +rgb[2], b: +rgb[3] }
  } catch {
    /* 取不到就沿用旧值 */
  }
}

const rgba = (a: number) => `rgba(${color.r}, ${color.g}, ${color.b}, ${a})`

/** 主题切换后由外部调用，让粒子颜色跟上 */
export function refreshEffectPalette() {
  readColor()
  build()
}

function resize() {
  if (!canvas) return
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  w = window.innerWidth
  h = window.innerHeight
  canvas.width = Math.max(1, Math.floor(w * dpr))
  canvas.height = Math.max(1, Math.floor(h * dpr))
  canvas.style.width = `${w}px`
  canvas.style.height = `${h}px`
  if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  build()
}

/* ----------------------------------------------------------- 自定义动效 */

const custom = {
  fn: null as ((fx: FxContext) => void) | null,
  state: {} as Record<string, unknown>,
  error: '',
  errors: 0,
  slow: 0,
}

/** 当前自定义动效的错误信息（空串表示正常） */
export function customEffectError(): string {
  return custom.error
}

/**
 * 编译用户代码。返回 { ok, error }。
 *
 * 用 new Function 而不是 eval：用户代码只能拿到 fx 这一个参数，
 * 摸不到本模块的闭包变量（ctx / particles / cfg 等）。
 * 注意它不是安全边界 —— 代码仍以本页身份运行，只应粘贴自己写的或信任的代码。
 */
export function compileCustom(code: string): { ok: boolean; error: string } {
  custom.error = ''
  custom.errors = 0
  custom.slow = 0
  const src = String(code || '').trim()
  if (!src) {
    custom.fn = null
    return { ok: true, error: '' }
  }
  if (src.length > CUSTOM_LIMITS.maxCode) {
    custom.fn = null
    custom.error = `代码超过 ${CUSTOM_LIMITS.maxCode} 字符上限（当前 ${src.length}）`
    return { ok: false, error: custom.error }
  }
  try {
    custom.fn = new Function('fx', `"use strict";\n${src}`) as (fx: FxContext) => void
    custom.state = {}
    return { ok: true, error: '' }
  } catch (e) {
    custom.fn = null
    custom.error = String((e && (e as Error).message) || e)
    return { ok: false, error: custom.error }
  }
}

/** 出错或卡帧太多就自动停机，并广播给 UI（避免每帧刷屏 + 拖垮页面） */
function failCustom(reason: string) {
  custom.fn = null
  custom.error = reason
  stop()
  document.dispatchEvent(new CustomEvent('fx-custom-failed', { detail: { reason } }))
}

function drawCustom(dt: number) {
  if (!custom.fn) return
  const began = performance.now()
  try {
    custom.fn({
      ctx,
      w,
      h,
      t: began / 1000,
      dt,
      speed: cfg.speed,
      intensity: cfg.intensity,
      color,
      rgba,
      state: custom.state,
      rand: (a = 0, b = 1) => a + Math.random() * (b - a),
    })
  } catch (e) {
    custom.errors++
    const msg = String((e && (e as Error).message) || e)
    if (custom.errors >= CUSTOM_LIMITS.maxErrors) {
      failCustom(`已自动停用：连续 ${CUSTOM_LIMITS.maxErrors} 次运行出错 —— ${msg}`)
    } else {
      custom.error = msg
    }
    return
  }
  // 单帧太慢（死循环或画得太重）也算失控，累计几次就停
  if (performance.now() - began > CUSTOM_LIMITS.slowMs) {
    custom.slow++
    if (custom.slow >= CUSTOM_LIMITS.maxSlow) {
      failCustom(`已自动停用：每帧耗时持续超过 ${CUSTOM_LIMITS.slowMs}ms，可能卡住了`)
    }
  } else {
    custom.slow = 0
  }
}

/* ------------------------------------------------------------- 粒子池 */

function build() {
  const base = BASE_COUNT[cfg.type] || 0
  const n = Math.min(MAX_COUNT, Math.round(base * (0.4 + cfg.intensity * 0.6)))
  particles = []
  for (let i = 0; i < n; i++) particles.push(spawn(cfg.type, true))
}

function spawn(type: string, initial: boolean): Record<string, number> {
  const rnd = (a: number, b: number) => a + Math.random() * (b - a)
  if (type === 'stars') {
    return {
      x: Math.random() * w,
      y: Math.random() * h,
      r: rnd(0.5, 1.7),
      a: rnd(0.2, 0.9),
      da: rnd(-0.01, 0.01) || 0.006,
      vx: rnd(-0.08, 0.08),
      vy: rnd(-0.06, 0.06),
    }
  }
  if (type === 'snow') {
    return {
      x: Math.random() * w,
      y: initial ? Math.random() * h : rnd(-40, -4),
      r: rnd(1, 2.6),
      vy: rnd(0.18, 0.6),
      ph: Math.random() * Math.PI * 2,
      amp: rnd(0.3, 1.1),
    }
  }
  if (type === 'bubbles') {
    return {
      x: Math.random() * w,
      y: initial ? Math.random() * h : h + rnd(4, 40),
      r: rnd(4, 16),
      vy: rnd(0.15, 0.5),
      vx: rnd(-0.12, 0.12),
    }
  }
  if (type === 'orbit') {
    return {
      ang: Math.random() * Math.PI * 2,
      rad: rnd(10, 60),
      vr: rnd(0.25, 0.9),
      life: 1,
      decay: rnd(0.0018, 0.005),
      spin: rnd(0.01, 0.035),
    }
  }
  return { x: 0, y: 0 }
}

/* --------------------------------------------------------------- 绘制 */

function drawStars(dt: number) {
  const sp = cfg.speed
  for (let i = 0; i < particles.length; i++) {
    const p = particles[i]
    p.x += p.vx * dt * sp
    p.y += p.vy * dt * sp
    p.a += p.da * dt * sp
    if (p.a >= 0.95) {
      p.a = 0.95
      p.da = -Math.abs(p.da)
    } else if (p.a <= 0.12) {
      p.a = 0.12
      p.da = Math.abs(p.da)
    }
    if (p.x < -4) p.x = w + 4
    if (p.x > w + 4) p.x = -4
    if (p.y < -4) p.y = h + 4
    if (p.y > h + 4) p.y = -4

    ctx!.beginPath()
    ctx!.fillStyle = rgba(p.a)
    ctx!.arc(p.x, p.y, p.r, 0, Math.PI * 2)
    ctx!.fill()
  }
}

function drawSnow(dt: number) {
  const sp = cfg.speed
  for (let i = 0; i < particles.length; i++) {
    const p = particles[i]
    p.ph += 0.014 * dt * sp
    p.y += p.vy * dt * sp
    p.x += Math.sin(p.ph) * p.amp * dt * 0.6
    if (p.y > h + 8) {
      particles[i] = spawn('snow', false)
      continue
    }
    if (p.x < -10) p.x = w + 10
    if (p.x > w + 10) p.x = -10

    ctx!.beginPath()
    ctx!.fillStyle = rgba(0.5)
    ctx!.arc(p.x, p.y, p.r, 0, Math.PI * 2)
    ctx!.fill()
  }
}

function drawBubbles(dt: number) {
  const sp = cfg.speed
  for (let i = 0; i < particles.length; i++) {
    const p = particles[i]
    p.y -= p.vy * dt * sp
    p.x += p.vx * dt * sp
    if (p.y < -p.r - 10) {
      particles[i] = spawn('bubbles', false)
      continue
    }
    ctx!.beginPath()
    ctx!.strokeStyle = rgba(0.28)
    ctx!.lineWidth = 1.2
    ctx!.arc(p.x, p.y, p.r, 0, Math.PI * 2)
    ctx!.stroke()
  }
}

function drawOrbit(dt: number) {
  const sp = cfg.speed
  const cx = w / 2
  const cy = h / 2
  for (let i = 0; i < particles.length; i++) {
    const p = particles[i]
    p.rad += p.vr * dt * sp
    p.ang += p.spin * dt * sp
    p.life -= p.decay * dt * sp
    if (p.life <= 0) {
      particles[i] = spawn('orbit', false)
      continue
    }
    const x = cx + Math.cos(p.ang) * p.rad
    const y = cy + Math.sin(p.ang) * p.rad * 0.62
    const size = Math.max(0.6, 2.4 * p.life)
    ctx!.beginPath()
    ctx!.fillStyle = rgba(0.55 * p.life)
    ctx!.arc(x, y, size, 0, Math.PI * 2)
    ctx!.fill()
  }
}

function drawAurora(_dt: number) {
  const sp = cfg.speed
  const time = performance.now() / 1000
  const bands = 3
  const amp = 40 + cfg.intensity * 46
  for (let b = 0; b < bands; b++) {
    const phase = time * 0.24 * sp + b * 1.7
    const yBase = h * (0.28 + b * 0.19)
    ctx!.beginPath()
    ctx!.moveTo(-20, yBase)
    for (let x = -20; x <= w + 20; x += 22) {
      const y =
        yBase +
        Math.sin(x / 190 + phase) * amp * 0.5 +
        Math.sin(x / 74 - phase * 1.4) * amp * 0.22
      ctx!.lineTo(x, y)
    }
    ctx!.lineTo(w + 20, yBase + amp * 1.5)
    ctx!.lineTo(-20, yBase + amp * 1.5)
    ctx!.closePath()
    const g = ctx!.createLinearGradient(0, yBase - amp, 0, yBase + amp * 1.5)
    g.addColorStop(0, rgba(0))
    g.addColorStop(0.5, rgba(0.1 + b * 0.015))
    g.addColorStop(1, rgba(0))
    ctx!.fillStyle = g
    ctx!.fill()
  }
}

/* --------------------------------------------------------------- 主循环 */

function frame(ts: number) {
  raf = requestAnimationFrame(frame)
  if (!ctx) return
  if (!last) last = ts
  const dt = Math.min((ts - last) / 16.667, 3)
  last = ts

  ctx.clearRect(0, 0, w, h)
  switch (cfg.type) {
    case 'stars':
      drawStars(dt)
      break
    case 'snow':
      drawSnow(dt)
      break
    case 'bubbles':
      drawBubbles(dt)
      break
    case 'aurora':
      drawAurora(dt)
      break
    case 'orbit':
      drawOrbit(dt)
      break
    case 'custom':
      drawCustom(dt)
      break
    default:
      break
  }
}

function start() {
  if (running || !ctx || cfg.type === 'none') return
  running = true
  last = 0
  raf = requestAnimationFrame(frame)
}

function stop() {
  running = false
  if (raf) cancelAnimationFrame(raf)
  raf = 0
}

/* --------------------------------------------------------------- 对外 */

export function initEffects(el: HTMLCanvasElement | null) {
  canvas = el
  if (!canvas) return
  ctx = canvas.getContext('2d')
  readColor()
  resize()
  window.addEventListener('resize', resize)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stop()
    else if (cfg.type !== 'none') start()
  })
}

export function setEffect(next: { type?: string; intensity?: number; speed?: number; custom?: { code?: string } } | null | undefined) {
  cfg = {
    type: next?.type || 'none',
    intensity: Number(next?.intensity) || 1,
    speed: Number(next?.speed) || 1,
  }
  if (cfg.type === 'custom') {
    const r = compileCustom(next?.custom?.code ?? '')
    // 编译失败就广播，让设置面板能立刻显示原因
    if (!r.ok) document.dispatchEvent(new CustomEvent('fx-custom-failed', { detail: { reason: r.error } }))
  } else {
    custom.fn = null
    custom.error = ''
  }
  if (!canvas) return
  readColor()
  build()
  if (cfg.type === 'none') {
    stop()
    if (ctx) ctx.clearRect(0, 0, w, h)
  } else if (cfg.type === 'custom' && !custom.fn) {
    // 没有可运行的代码（空或编译失败）：清屏但不空转
    stop()
    if (ctx) ctx.clearRect(0, 0, w, h)
  } else {
    start()
  }
}

export function stopEffects() {
  stop()
}
