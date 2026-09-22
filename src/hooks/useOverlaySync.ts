import { useEffect, useLayoutEffect, useState } from 'react'
import type { Store } from '../state/store'

/**
 * 把浮层状态同步到 body / scrim / inert。
 *
 * 这些是旧的浮层管理契约，UI 测试与静态检查都依赖它们：
 *  - body.nav-open / body.rail-open：窄屏抽屉
 *  - body.has-overlay：背景滚动锁（计数式，抽屉与设置面板不会互相解锁）
 *  - #app-view / .app-main / #sidebar / #compose-rail 的 inert：焦点陷阱
 */
export function useOverlaySync(store: Pick<Store, 'state' | 'appRef' | 'narrow'>) {
  const { state, appRef, narrow } = store
  const { drawerId, panelOpen, navOpen, railOpen, phase } = state

  // 布局阶段同步执行：浮层开合的 body class / inert 必须在点击后的同一帧落定，
  // 延后到 useEffect 会让「点了却没反应」的竞态窗口出现
  useLayoutEffect(() => {
    if (phase !== 'app') return
    const body = document.body
    body.classList.toggle('nav-open', navOpen)
    body.classList.toggle('rail-open', railOpen)

    const locks = [drawerId !== null, panelOpen, navOpen, railOpen].filter(Boolean).length
    body.classList.toggle('has-overlay', locks > 0)

    const scrim = document.getElementById('sidebar-scrim')
    if (scrim) (scrim as HTMLElement).hidden = !(navOpen || railOpen)

    const app = appRef.current
    const main = document.querySelector<HTMLElement>('.app-main')
    const overlayOpen = drawerId !== null || panelOpen
    if (app) app.inert = overlayOpen
    if (main) main.inert = !overlayOpen && (navOpen || railOpen)
    // 两个抽屉互不相干，打开一个时把另一个也隔离掉
    const sidebar = document.getElementById('sidebar')
    const rail = document.getElementById('compose-rail')
    if (sidebar) sidebar.inert = !overlayOpen && railOpen && narrow()
    if (rail) rail.inert = !overlayOpen && navOpen && narrow()
  }, [appRef, drawerId, narrow, navOpen, panelOpen, phase, railOpen])
}

/** 媒体查询变化时自动收起窄屏抽屉 */
export function useNarrowQuery(onLeaveNarrow: () => void): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 860px)').matches
  )
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia('(max-width: 860px)')
    const onChange = (e: MediaQueryListEvent) => {
      setNarrow(e.matches)
      if (!e.matches) onLeaveNarrow()
    }
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [onLeaveNarrow])
  return narrow
}
