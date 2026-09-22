/** 待办：按紧急程度分组 + AI 整理建议 */
import { useStore } from '../../state/store'
import { dueHint, kindMeta, renderRichText, timeAgo } from '../../lib/ui'
import { RichText } from '../Overlays'
import type { Entry } from '../../lib/types'

function TodoRow({ e, onOpen, onToggle }: { e: Entry; onOpen: () => void; onToggle: () => void }) {
  const km = kindMeta(e.kind)
  const due = dueHint(e.due_date)
  const isTodo = e.kind === 'todo'
  return (
    <article className="entry" data-act="open-entry" data-id={e.id} onClick={onOpen}>
      <button
        type="button"
        className="entry-check"
        data-act="toggle-entry"
        data-id={e.id}
        title="标记完成"
        onClick={(ev) => {
          ev.stopPropagation()
          onToggle()
        }}
      >
        ✓
      </button>
      <div className="entry-main">
        <div className="entry-top">
          <span className="entry-title">{e.title || e.raw_text.slice(0, 40)}</span>
          {isTodo ? null : <span className={`badge ${km.cls}`}>{km.icon} 来自记录</span>}
          {e.priority === 'high' ? (
            <span className="badge badge-over">高优先</span>
          ) : e.priority === 'low' ? (
            <span className="badge badge-soft">低优先</span>
          ) : null}
          {due ? <span className={`badge ${due.level === 'over' ? 'badge-over' : 'badge-due'}`}>{due.text}</span> : null}
        </div>
        {e.action_items?.length ? (
          <div className="entry-summary">
            {e.action_items.map((a) => (
              <div key={a}>· {a}</div>
            ))}
          </div>
        ) : null}
        <div className="entry-meta">
          <span>#{e.id}</span>
          <span>{timeAgo(e.created_at)}</span>
        </div>
      </div>
    </article>
  )
}

export function TodoView({ active }: { active: boolean }) {
  const { state, actions, derived } = useStore()
  const { buckets, doneList } = derived.todoBuckets()
  const groups: [string, Entry[]][] = [
    ['⚠️ 已逾期', buckets.over],
    ['🔥 今天到期', buckets.today],
    ['📅 一周内', buckets.week],
    ['🗓️ 更远', buckets.later],
    ['🕊️ 没有期限', buckets.none],
  ].filter(([, arr]) => arr.length) as [string, Entry[]][]

  const totalOpen = groups.reduce((n, [, arr]) => n + arr.length, 0)

  let body: React.ReactNode
  if (state.loading) {
    body = (
      <div className="list">
        {[0, 1, 2].map((i) => (
          <div className="skeleton" key={i}></div>
        ))}
      </div>
    )
  } else if (totalOpen === 0 && doneList.length === 0) {
    body = (
      <div className="empty">
        <div className="empty-icon">✅</div>
        <h3>暂时没有待办</h3>
        <p>在收件箱里记下"要做的事"，它会自动被识别成待办。</p>
      </div>
    )
  } else {
    body = (
      <>
        {groups.map(([title, arr]) => (
          <div className="todo-group" key={title}>
            <h3>
              {title} · {arr.length}
            </h3>
            <div className="list">
              {arr.map((e) => (
                <TodoRow key={e.id} e={e} onOpen={() => actions.openEntry(e.id)} onToggle={() => void actions.toggleEntry(e.id)} />
              ))}
            </div>
          </div>
        ))}
        {doneList.length ? (
          <div className="todo-group">
            <h3>已完成 · {doneList.length}</h3>
            <div className="list">
              {doneList.map((e) => (
                <TodoRow key={e.id} e={e} onOpen={() => actions.openEntry(e.id)} onToggle={() => void actions.toggleEntry(e.id)} />
              ))}
            </div>
          </div>
        ) : null}
      </>
    )
  }

  return (
    <section className={`view ${active ? '' : 'hidden'}`} id="view-todo">
      <header className="view-head">
        <h1>待办</h1>
        <p>按紧急程度排好，逾期在最前 · {totalOpen} 项未完成</p>
      </header>

      <div className="card">
        <div className="card-head">
          <span className="spacer"></span>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            id="btn-tidy"
            disabled={state.todoAdviceBusy}
            onClick={() => void actions.handleTidy()}
          >
            {state.todoAdviceBusy ? '整理中…' : '✨ AI 整理建议'}
          </button>
        </div>
        {state.todoAdvice || state.todoAdviceBusy ? (
          <div className="advice-box" id="advice-box">
            <h4>整理建议</h4>
            <div id="advice-body">
              {state.todoAdviceBusy ? <div className="spinner"></div> : <RichText html={renderRichText(state.todoAdvice)} />}
            </div>
          </div>
        ) : (
          <p className="card-sub" style={{ margin: 0 }}>
            点右上角的「AI 整理建议」，让它帮你排优先级、找重复项、判断哪些该放弃。
          </p>
        )}
      </div>
      {body}
    </section>
  )
}
