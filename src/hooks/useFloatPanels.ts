/**
 * 两侧悬浮栏可以上下拖。位置记在 localStorage —— 它是"这台机器、这个窗口"的偏好，
 * 没必要占云端设置的结构。松手后吸附到最近的档位（顶 / 居中 / 底），
 * 所以不会停在不上不下的位置。
 */
import { useEffect } from 'react'
import { readFloatPos, writeFloatPos } from '../lib/storage'

const NARROW_QUERY = '(max-width: 860px)'

function narrow() {
  return window.matchMedia(NARROW_QUERY).matches
}

function floatGap(): number {
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--float-gap'))
  return Number.isFinite(v) ? v : 16
}

/**
 * 可写范围。
 *
 * 关键：两栏是 `top:50%` + `transform:translateY(-50%)` 定位的，所以 style.top 这个值
 * 是**方块的视觉中心点**，不是顶边。按顶边来算会让"贴顶"把上半截顶出视口、
 * "贴底"在下方多空出半个方块的高度 —— 两种错法方向相反，且只有方块高到一定尺寸才看得出来。
 */
function topRange(el: HTMLElement) {
  const g = floatGap()
  const half = el.offsetHeight / 2
  const min = g + half
  const max = Math.max(min, window.innerHeight - g - half)
  return { min, max }
}

function clampTop(el: HTMLElement, top: number) {
  const { min, max } = topRange(el)
  return Math.min(Math.max(top, min), max)
}

/** 三档吸附位：贴顶、垂直居中、贴底（都是中心点坐标） */
function floatSlots(el: HTMLElement): number[] {
  const { min, max } = topRange(el)
  const mid = Math.round(window.innerHeight / 2)
  return [Math.round(min), mid, Math.round(max)].filter((v, i, a) => a.indexOf(v) === i)
}

function setFloatTop(el: HTMLElement, top: number, key?: string) {
  const next = clampTop(el, top)
  el.style.top = `${next}px`
  if (key) writeFloatPos(key, next)
  return next
}

/** 当前中心点：优先取我们一直在写的 style.top */
function currentCenter(panel: HTMLElement): number {
  const px = parseFloat(panel.style.top)
  return Number.isFinite(px) ? px : panel.getBoundingClientRect().top + panel.offsetHeight / 2
}

export function useFloatPanels() {
  useEffect(() => {
    const grips = Array.from(document.querySelectorAll<HTMLElement>('[data-grip]'))
    const cleanups: (() => void)[] = []

    grips.forEach((grip) => {
      const panel = grip.closest<HTMLElement>('.sidebar, .compose-rail')
      if (!panel) return
      const key = grip.dataset.grip

      const saved = readFloatPos()[key as string]
      if (typeof saved === 'number') setFloatTop(panel, saved)

      let dragging = false
      let moved = false
      let startY = 0
      let startTop = 0

      const onDown = (e: PointerEvent) => {
        if (narrow()) return // 窄屏是抽屉，没有上下余地
        if (e.button != null && e.button !== 0) return
        dragging = true
        moved = false
        startY = e.clientY
        // 起点必须取中心点（与 style.top 同语义），取 rect.top 会在按下的瞬间跳半个方块
        startTop = currentCenter(panel)
        panel.classList.add('dragging')
        try {
          grip.setPointerCapture(e.pointerId)
        } catch {
          /* 老浏览器没有 pointer capture 也能用，只是指针移出会断 */
        }
      }

      const onMove = (e: PointerEvent) => {
        if (!dragging) return
        const dy = e.clientY - startY
        // 3px 抖动阈值：不然单击手柄也会被当成一次（零位移的）拖动
        if (!moved && Math.abs(dy) < 3) return
        moved = true
        e.preventDefault()
        panel.style.top = `${clampTop(panel, startTop + dy)}px`
      }

      const onUp = () => {
        if (!dragging) return
        dragging = false
        panel.classList.remove('dragging')
        if (!moved) return
        // 用自己写的 top 而不是 rect：拖动过程中我们一直在写 style.top，它才是当前位置
        const here = currentCenter(panel)
        let best = floatSlots(panel)[0]
        for (const s of floatSlots(panel)) {
          if (Math.abs(s - here) < Math.abs(best - here)) best = s
        }
        setFloatTop(panel, best, key)
      }

      // 键盘可达：↑ ↓ 微调（按住 Shift 大步），Home 回正中
      const onKeyDown = (e: KeyboardEvent) => {
        if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown' && e.key !== 'Home') return
        e.preventDefault()
        const step = e.shiftKey ? 48 : 12
        if (e.key === 'Home') {
          setFloatTop(panel, window.innerHeight / 2, key) // 中心点语义：视口中线
          return
        }
        setFloatTop(panel, currentCenter(panel) + (e.key === 'ArrowUp' ? -step : step), key)
      }

      grip.addEventListener('pointerdown', onDown)
      grip.addEventListener('pointermove', onMove)
      grip.addEventListener('pointerup', onUp)
      grip.addEventListener('pointercancel', onUp)
      grip.addEventListener('lostpointercapture', onUp)
      grip.addEventListener('keydown', onKeyDown)
      cleanups.push(() => {
        grip.removeEventListener('pointerdown', onDown)
        grip.removeEventListener('pointermove', onMove)
        grip.removeEventListener('pointerup', onUp)
        grip.removeEventListener('pointercancel', onUp)
        grip.removeEventListener('lostpointercapture', onUp)
        grip.removeEventListener('keydown', onKeyDown)
      })
    })

    // 窗口变矮后，原来贴底的位置可能掉出视口，重新钳一下
    const onResize = () => {
      grips.forEach((grip) => {
        const panel = grip.closest<HTMLElement>('.sidebar, .compose-rail')
        if (!panel || !panel.style.top) return
        setFloatTop(panel, parseFloat(panel.style.top), grip.dataset.grip)
      })
    }
    window.addEventListener('resize', onResize)
    cleanups.push(() => window.removeEventListener('resize', onResize))

    return () => cleanups.forEach((fn) => fn())
  }, [])
}

/** 指示器要在每次渲染后重排；窗口尺寸变化时也要（不加过渡，否则会飘着追） */
export function useInkOnResize(reschedule: () => void) {
  useEffect(() => {
    window.addEventListener('resize', reschedule)
    return () => window.removeEventListener('resize', reschedule)
  }, [reschedule])
}
