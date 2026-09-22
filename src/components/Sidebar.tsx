/** 侧栏：竖向导航 + 视图切换 */
import { useStore, type ViewName } from '../state/store'

const TABS: { view: ViewName; icon: string; label: string }[] = [
  { view: 'inbox', icon: '📥', label: '收件箱' },
  { view: 'todo', icon: '✅', label: '待办' },
  { view: 'ask', icon: '💬', label: '问答' },
  { view: 'review', icon: '📊', label: '复盘' },
]

export function Sidebar() {
  const { state, actions } = useStore()
  return (
    <aside className="sidebar" id="sidebar" aria-label="主导航">
      <button
        type="button"
        className="float-grip"
        data-grip="sidebar"
        title="上下拖动调整位置（↑ ↓ 微调，Home 回正）"
        aria-label="拖动调整导航栏上下位置"
      >
        <span aria-hidden="true"></span>
      </button>
      <div className="side-brand">
        <div className="logo">🐾</div>
        <div className="brand">
          <strong>信息管家</strong>
          <span>个人记忆与待办</span>
        </div>
      </div>

      <nav className="side-nav" id="tabs" aria-label="视图切换">
        {TABS.map((t) => (
          <button
            key={t.view}
            type="button"
            className={`side-tab ${state.view === t.view ? 'active' : ''}`}
            data-view={t.view}
            aria-current={state.view === t.view ? 'page' : undefined}
            onClick={() => actions.setView(t.view)}
          >
            <span aria-hidden="true">{t.icon}</span> {t.label}
          </button>
        ))}
      </nav>

      <p className="side-hint" aria-hidden="true">↑↓ 切换视图 · ←→ 切换栏目</p>
    </aside>
  )
}
