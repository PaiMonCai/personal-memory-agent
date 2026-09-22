/**
 * 应用外壳：背景层、启动遮罩、登录页 / 主界面、四个视图、抽屉与设置面板、全局快捷键。
 *
 * DOM 契约（与旧实现一致，tools/dom-test.mjs 与 static-check.py 都依赖它）：
 *  - #app-view 与 #auth-view 常驻 DOM，用 .hidden class 切换显隐；
 *  - 四个 <section class="view" id="view-*"> 由各自视图组件渲染，同样用 .hidden 切换；
 *  - body 上的 nav-open / rail-open / has-overlay 由 useOverlaySync 同步。
 */
import { useCallback, useEffect, useRef } from 'react'
import { getSession } from './lib/api'
import { AppProvider, useStore, type ViewName } from './state/store'
import { initEffects, refreshEffectPalette } from './lib/effects'
import { scheduleFilterInk, resetFilterInk } from './lib/filter-ink'
import { useFloatPanels, useInkOnResize } from './hooks/useFloatPanels'
import { useNarrowQuery, useOverlaySync } from './hooks/useOverlaySync'
import { AuthView } from './components/AuthView'
import { Sidebar } from './components/Sidebar'
import { Topbar } from './components/Topbar'
import { ComposeRail } from './components/ComposeRail'
import { EntryDrawer } from './components/EntryDrawer'
import { SettingsPanel } from './components/SettingsPanel'
import { InboxView } from './components/views/InboxView'
import { TodoView } from './components/views/TodoView'
import { AskView } from './components/views/AskView'
import { ReviewView } from './components/views/ReviewView'
import { ConfirmHost, ToastHost } from './components/Overlays'

const VIEW_LABEL: Record<ViewName, string> = { inbox: '收件箱', todo: '待办', ask: '问答', review: '复盘' }

function Shell() {
  const { state, actions, appRef, narrow } = useStore()
  useOverlaySync({ state, appRef, narrow })
  useFloatPanels()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const reschedule = useCallback(() => scheduleFilterInk(false), [])
  useInkOnResize(reschedule)
  // 从窄屏（抽屉形态）回到宽屏时把抽屉收起来，否则抽屉会以悬浮形态卡在界面上
  const onLeaveNarrow = useCallback(() => {
    actions.closeNav()
    actions.closeRail()
  }, [actions])
  useNarrowQuery(onLeaveNarrow)
  const lastRenderedView = useRef<ViewName | null>(null)
  const mainRef = useRef<HTMLElement>(null)

  // 特效引擎只需要初始化一次；主题变化由 store 推入的 setEffect 处理
  useEffect(() => {
    initEffects(canvasRef.current)
  }, [])

  // 主题切换后让粒子颜色跟上
  useEffect(() => {
    refreshEffectPalette()
  }, [state.settings.theme.accent, state.settings.theme.dark])

  // 引导：先读本地缓存把外观铺上（避免首屏闪默认配色），再确认会话
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const session = await getSession()
        if (!alive) return
        if (session) await actions.enterApp(session)
        else actions.goAuth()
      } catch (err) {
        console.error(err)
        actions.goAuth()
      }
    })()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 视图切换：播一次入场过渡，数据刷新不重放，避免频繁闪烁
  useEffect(() => {
    const switched = lastRenderedView.current !== state.view
    lastRenderedView.current = state.view
    // 换了页面就忘掉旧的指示器几何，否则它会长途滑过来
    if (switched) resetFilterInk()
    const el = document.querySelector(`#view-${state.view}`)
    if (el && switched && !window.matchMedia('(prefers-reduced-motion: reduce)').matches && typeof el.animate === 'function') {
      el.animate(
        [
          { opacity: 0, transform: 'translateY(6px)' },
          { opacity: 1, transform: 'none' },
        ],
        { duration: 200, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }
      )
    }
  }, [state.view])

  // 指示器在每次渲染后重排
  useEffect(() => {
    scheduleFilterInk()
  })

  /* ------------------------------------------------------- 键盘导航 */

  /** 上下：在侧栏目录里前后移动，到头绕回另一端。顺序直接从 DOM 读，不另维护一份常量 */
  const cycleView = (delta: number): boolean => {
    const tabs = Array.from(document.querySelectorAll<HTMLElement>('#tabs [data-view]'))
    if (tabs.length < 2) return false
    const at = tabs.findIndex((t) => t.dataset.view === state.view)
    if (at < 0) return false
    const next = tabs[(at + delta + tabs.length) % tabs.length]
    actions.setView(next.dataset.view as ViewName)
    announceKeys(`视图：${VIEW_LABEL[next.dataset.view as ViewName] || next.dataset.view}`)
    return true
  }

  /** 左右：切当前视图的筛选栏目。收件箱切分类、复盘切区间 */
  const cycleFilter = (delta: number): boolean => {
    const group = state.view === 'inbox' ? 'kind' : state.view === 'review' ? 'range' : null
    if (!group) return false
    const attr = group === 'kind' ? 'kind' : 'range'
    const chips = Array.from(document.querySelectorAll<HTMLElement>(`[data-ink="${group}"] .chip`))
    if (chips.length < 2) return false
    const cur = group === 'kind' ? state.filter.kind : state.reviewRange
    const at = chips.findIndex((c) => c.dataset[attr] === cur)
    if (at < 0) return false
    const next = chips[(at + delta + chips.length) % chips.length]
    const value = next.dataset[attr] as string
    if (group === 'kind') actions.setFilterKind(value)
    else actions.setReviewRange(value)
    // 栏目名带 emoji（"💡 想法"），念出来很啰嗦，播报时去掉
    const label = (next.textContent || '').trim().replace(/^[\p{Extended_Pictographic}\s]+/u, '')
    announceKeys(`栏目：${label}`)
    return true
  }

  const announceKeys = (text: string) => {
    const el = document.getElementById('key-live')
    if (el) el.textContent = text
  }

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return
      const t = e.target
      if (t && ((t as HTMLElement).tagName === 'INPUT' || (t as HTMLElement).tagName === 'TEXTAREA' || (t as HTMLElement).isContentEditable)) return

      if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        // 手柄自己用上下键调悬浮方块的位置，别抢
        if (t && (t as HTMLElement).closest?.('[data-grip]')) return
        if (document.querySelector('.modal-mask')) return
        if (state.phase !== 'app') return // 还没登录，别在看不见的地方改视图
        const panel = document.getElementById('settings-panel')
        if (state.panelOpen || (panel && !panel.classList.contains('hidden'))) return // 面板里的滑杆要用左右键调值
        if (state.navOpen) return
        if (document.body.classList.contains('nav-open')) return
        if (state.railOpen) return
        if (document.body.classList.contains('rail-open')) return
        const delta = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1
        const moved = e.key === 'ArrowUp' || e.key === 'ArrowDown' ? cycleView(delta) : cycleFilter(delta)
        // 只有真的接管了才阻止默认行为：待办 / 问答页没有筛选栏，左右键仍留给页面自己处理
        if (moved) e.preventDefault()
        return
      }

      if (e.key === '/') {
        e.preventDefault()
        document.getElementById('global-search')?.focus()
      } else if (e.key === 'n' || e.key === 'N') {
        e.preventDefault()
        if (narrow()) {
          if (state.railOpen) actions.closeRail({ restoreFocus: true })
          else actions.openRail()
        } else {
          const input = document.getElementById('capture-input') as HTMLTextAreaElement | null
          input?.focus()
          try {
            input?.setSelectionRange(input.value.length, input.value.length)
          } catch {
            /* 某些输入类型不支持选区，忽略 */
          }
        }
      } else if (e.key === 'Escape') {
        if (document.querySelector('.modal-mask')) return // 确认框自己处理
        if (state.navOpen || document.body.classList.contains('nav-open')) return actions.closeNav({ restoreFocus: true })
        if (state.railOpen || document.body.classList.contains('rail-open')) return actions.closeRail({ restoreFocus: true })
        const panel = document.getElementById('settings-panel')
        if (state.panelOpen || (panel && !panel.classList.contains('hidden'))) return actions.closeSettings()
        actions.closeDrawer()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  })

  // 抽屉关闭后把焦点还给主内容区（列表项本身可能已被重渲染，直接聚焦容器更稳）
  const prevDrawer = useRef<number | null>(null)
  useEffect(() => {
    if (prevDrawer.current !== null && state.drawerId === null && !state.navOpen) {
      mainRef.current?.focus({ preventScroll: true })
    }
    prevDrawer.current = state.drawerId
  }, [state.drawerId, state.navOpen])

  return (
    <>
      <a className="skip-link" href="#main-content">跳到主要内容</a>
      <div className="bg-layer" aria-hidden="true">
        <div className="bg-image"></div>
        <div className="bg-overlay"></div>
      </div>
      <canvas id="fx-layer" aria-hidden="true" ref={canvasRef}></canvas>

      <div className={`boot ${state.phase === 'boot' ? '' : 'hidden'}`} id="boot">
        <div className="boot-inner">
          <div className="boot-logo">🐾</div>
          <div className="boot-text">正在连接自建服务…</div>
        </div>
      </div>

      {/* 登录 / 注册 / 重置。常驻 DOM，未登录时显示 */}
      <AuthView active={state.phase === 'auth'} onAuthed={(session) => void actions.enterApp(session)} />

      <div className={`app ${state.phase === 'app' ? '' : 'hidden'}`} id="app-view" ref={appRef}>
        <Sidebar />
        <div className="app-main">
          <Topbar />
          <main className="main" id="main-content" tabIndex={-1} ref={mainRef} aria-busy={state.loading ? 'true' : 'false'}>
            <InboxView active={state.view === 'inbox'} />
            <TodoView active={state.view === 'todo'} />
            <AskView active={state.view === 'ask'} />
            <ReviewView active={state.view === 'review'} />
          </main>
        </div>
        <ComposeRail />
        <div className="corner-actions">
          <span className="user-chip" id="user-chip" title={state.user?.email || ''}>
            {state.user?.email || '已登录'}
          </span>
          <button type="button" className="btn btn-ghost btn-sm corner-btn" id="btn-settings" title="个性设置" onClick={actions.openSettings}>
            <span className="gear" aria-hidden="true">⚙</span> 设置
          </button>
          <button type="button" className="btn btn-ghost btn-sm corner-btn" id="btn-logout" onClick={() => void actions.logout()}>
            退出
          </button>
        </div>
      </div>

      <div className="sidebar-scrim" id="sidebar-scrim" hidden onClick={() => (state.navOpen ? actions.closeNav({ restoreFocus: true }) : actions.closeRail({ restoreFocus: true }))}></div>

      <div className={`drawer-mask ${state.drawerId != null ? '' : 'hidden'}`} id="drawer-mask" onClick={actions.closeDrawer}></div>
      <EntryDrawer />

      <div className={`settings-mask ${state.panelOpen ? '' : 'hidden'}`} id="settings-mask" onClick={actions.closeSettings}></div>
      <SettingsPanel />

      <ToastHost />
      <ConfirmHost />
      {/* 键盘切换视图 / 栏目的播报：视觉上隐藏，只给屏幕阅读器。
          别复用 toast —— 每切一格弹一个浮层太吵。 */}
      <div id="key-live" className="sr-only" role="status" aria-live="polite" aria-atomic="true"></div>
    </>
  )
}

function Root() {
  return (
    <AppProvider>
      <Shell />
    </AppProvider>
  )
}

export { Root }
export default Root
