/**
 * 筛选栏的滑动下划线。
 *
 * 逻辑与旧实现一致：渲染后先把新指示器放回旧位置，强制重排让浏览器认下这个起点，
 * 再过渡到目标位置。只让每个 chip 自己展开下划线的话，视觉上是"旧的消失 + 新的出现"
 * 两段割裂动画 —— 那就是僵硬感的来源。
 */

export type InkGroup = 'kind' | 'scope' | 'range'

/** 记住上一次的几何。React 重渲染会换掉 DOM 节点，但滑动要跨次渲染连续 */
const filterInk: Record<InkGroup, { x: number; y: number; w: number } | null> = {
  kind: null,
  scope: null,
  range: null,
}

export function resetFilterInk() {
  filterInk.kind = null
  filterInk.scope = null
  filterInk.range = null
}

/** @param animate 是否从上次位置滑过来（resize 这类瞬移要关掉，否则会飘着追） */
export function placeFilterInk(group: InkGroup, row: HTMLElement | null, animate: boolean) {
  const ink = row?.querySelector<HTMLElement>('.filter-ink')
  const active = row?.querySelector<HTMLElement>('.chip.active')
  if (!ink || !active) {
    filterInk[group] = null
    return
  }
  const rowRect = row!.getBoundingClientRect()
  const chipRect = active.getBoundingClientRect()
  const to = {
    x: chipRect.left - rowRect.left,
    y: chipRect.bottom - rowRect.top - 1.5,
    w: chipRect.width,
  }
  const set = (v: { x: number; y: number; w: number }) => {
    ink.style.transform = `translate3d(${v.x}px, ${v.y}px, 0)`
    ink.style.width = `${v.w}px`
  }
  const from = animate ? filterInk[group] : null
  // 先关掉过渡把起点（或目标）落定，强制重排后再打开过渡设到目标位置。
  ink.style.transition = 'none'
  set(from || to)
  void ink.offsetWidth // 提交当前位置，否则起点与终点落在同一帧，不会有过渡
  ink.style.transition = ''
  if (from) set(to)
  filterInk[group] = to
}

let inkFrame = 0

/** 渲染后统一重排指示器；同一帧内多次调用只跑最后一次 */
export function scheduleFilterInk(animate = true) {
  if (typeof requestAnimationFrame !== 'function') return
  if (inkFrame) cancelAnimationFrame(inkFrame)
  inkFrame = requestAnimationFrame(() => {
    inkFrame = 0
    placeFilterInk('kind', document.querySelector('#view-inbox [data-ink="kind"]'), animate)
    placeFilterInk('scope', document.querySelector('#view-inbox [data-ink="scope"]'), animate)
    placeFilterInk('range', document.querySelector('#view-review [data-ink="range"]'), animate)
  })
}
