/** 顶栏：导航开关 + 全局搜索 + 随手记开关 */
import { useRef } from 'react'
import { useStore } from '../state/store'
import { debounce } from '../lib/ui'

export function Topbar() {
  const { state, actions } = useStore()
  const inputRef = useRef<HTMLInputElement>(null)
  const { keyword } = state.filter

  const runSearch = (value: string) => {
    actions.setKeyword(value.trim())
  }

  return (
    <header className="topbar">
      <button
        type="button"
        className="icon-btn nav-toggle"
        id="nav-toggle"
        aria-label="打开导航"
        aria-expanded={state.navOpen}
        aria-controls="sidebar"
        onClick={() => (state.navOpen ? actions.closeNav({ restoreFocus: true }) : actions.openNav())}
      >
        <span className="burger" aria-hidden="true"></span>
      </button>
      <div className="topbar-search">
        <input
          id="global-search"
          ref={inputRef}
          type="search"
          placeholder="搜索记录…（回车检索，支持关键词）"
          autoComplete="off"
          aria-label="搜索记录"
          defaultValue={keyword}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              runSearch(e.currentTarget.value)
            }
          }}
          onInput={debounce((e: unknown) => {
            const el = (e as { target: HTMLInputElement }).target
            if (!el.value.trim() && state.filter.keyword) runSearch('')
          }, 400)}
        />
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          id="search-clear"
          hidden={!keyword}
          onClick={() => {
            if (inputRef.current) inputRef.current.value = ''
            runSearch('')
          }}
        >
          清除
        </button>
      </div>
      <button
        type="button"
        className="icon-btn rail-toggle"
        id="rail-toggle"
        aria-label="打开随手记"
        aria-expanded={state.railOpen}
        aria-controls="compose-rail"
        onClick={() => (state.railOpen ? actions.closeRail({ restoreFocus: true }) : actions.openRail())}
      >
        <span aria-hidden="true">＋</span>
      </button>
    </header>
  )
}
