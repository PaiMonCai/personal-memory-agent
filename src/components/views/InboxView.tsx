/** 收件箱：筛选 + 记录卡片列表 */
import { useEffect, useRef, useState } from 'react'
import { useStore } from '../../state/store'
import { dueHint, kindMeta, STATUS_META, timeAgo } from '../../lib/ui'
import { scheduleFilterInk } from '../../lib/filter-ink'
import type { Entry } from '../../lib/types'
import { Highlight } from '../Overlays'

const KIND_CHIPS: [string, string][] = [
  ['all', '全部'],
  ['idea', '💡 想法'],
  ['material', '📎 资料'],
  ['todo', '✓ 待办'],
  ['note', '📝 随记'],
  ['key', '⭐ 重点'],
]

const SCOPE_CHIPS: [string, string][] = [
  ['open', '未完成'],
  ['done', '已完成'],
  ['all', '全部'],
]

function EntryCard({ e, keyword, linkCount, analyzing, onOpen, onToggle }: {
  e: Entry
  keyword: string
  linkCount: number
  analyzing: boolean
  onOpen: () => void
  onToggle: () => void
}) {
  const km = kindMeta(e.kind)
  const st = STATUS_META[e.status] || STATUS_META.inbox
  const done = e.status === 'done'
  const due = dueHint(e.due_date)
  const title = e.title || e.raw_text.slice(0, 40)
  const tags = (e.tags || []).slice(0, 4)

  return (
    <article
      className={`entry ${km.cls} ${done ? 'done' : ''}`}
      data-act="open-entry"
      data-id={e.id}
      onClick={onOpen}
    >
      <button
        type="button"
        className={`entry-check ${done ? 'on' : ''}`}
        data-act="toggle-entry"
        data-id={e.id}
        title={done ? '标记为未完成' : '标记完成'}
        onClick={(ev) => {
          ev.stopPropagation()
          onToggle()
        }}
      >
        ✓
      </button>
      <div className="entry-main">
        <div className="entry-top">
          <span className="entry-title">
            <Highlight text={title} keyword={keyword} />
          </span>
          <span className={`badge ${km.cls}`}>{km.icon} {km.label}</span>
          {done ? <span className="badge badge-done">已完成</span> : null}
          {e.priority === 'high' && !done ? <span className="badge badge-over">高优先</span> : null}
          {due && !done ? (
            <span className={`badge ${due.level === 'over' ? 'badge-over' : 'badge-due'}`}>{due.text}</span>
          ) : null}
          {analyzing ? <span className="badge badge-ai">AI 分析中</span> : null}
          {e.ai_state === 'failed' ? <span className="badge badge-over">分析失败</span> : null}
        </div>
        {e.summary ? (
          <div className="entry-summary">
            <Highlight text={e.summary} keyword={keyword} />
          </div>
        ) : (
          <div className="entry-raw">
            <Highlight text={e.raw_text.slice(0, 140)} keyword={keyword} />
            {e.raw_text.length > 140 ? '…' : ''}
          </div>
        )}
        <div className="entry-meta">
          <span>{timeAgo(e.created_at)}</span>
          <span>{st.label}</span>
          {e.action_items?.length ? <span>{e.action_items.length} 项行动</span> : null}
          {tags.length ? (
            <span className="entry-tags">
              {tags.map((t) => (
                <span className="tag" key={t}>{t}</span>
              ))}
            </span>
          ) : null}
        </div>
      </div>
      {linkCount ? <div className="entry-side"><div className="entry-links">🔗 {linkCount}</div></div> : null}
    </article>
  )
}

export function InboxView({ active }: { active: boolean }) {
  const { state, actions, derived } = useStore()
  const { keyword } = state.filter
  const [swapping, setSwapping] = useState(false)

  // 关键词检索结果单独存放，避免把问答 / 复盘 / 待办依赖的全量数据挤掉
  const list = derived.visibleEntries()
  const total = derived.activeEntries().length
  const openCount = state.entries.filter((e) => e.status === 'inbox' || e.status === 'active').length

  useEffect(() => {
    scheduleFilterInk()
  }, [state.filter.kind, state.filter.scope, state.entries, state.searchResults, state.loading])

  /**
   * 筛选切换后列表换了内容，给它一点位移淡入（对应旧实现的 swapping 标志）。
   * 只在用户主动改筛选时置位，数据刷新不重放 —— 否则每次保存都会抖一下。
   * 重复点同一项在上面已被守卫拦下，不会重放动画。
   */
  const prevFilter = useRef({ kind: state.filter.kind, scope: state.filter.scope })
  useEffect(() => {
    const prev = prevFilter.current
    prevFilter.current = { kind: state.filter.kind, scope: state.filter.scope }
    if (prev.kind === state.filter.kind && prev.scope === state.filter.scope) return
    setSwapping(true)
  }, [state.filter.kind, state.filter.scope])

  useEffect(() => {
    if (!swapping) return
    const timer = setTimeout(() => setSwapping(false), 300)
    return () => clearTimeout(timer)
  }, [swapping])

  let body: React.ReactNode
  if (state.loading) {
    body = (
      <div className="list">
        {[0, 1, 2, 3].map((i) => (
          <div className="skeleton" key={i}></div>
        ))}
      </div>
    )
  } else if (list.length === 0) {
    const cls = `empty ${swapping ? 'is-swapping' : ''}`
    body = keyword ? (
      <div className={cls}>
        <div className="empty-icon">🔍</div>
        <h3>没有找到包含「{keyword}」的记录</h3>
        <p>换个关键词试试，或清空搜索框查看全部。</p>
      </div>
    ) : (
      <div className={cls}>
        <div className="empty-icon">📥</div>
        <h3>收件箱还是空的</h3>
        <p>用「随手记」写下一句话，剩下的交给它。也可以上传 .md 文件批量导入。</p>
      </div>
    )
  } else {
    body = (
      <div className={`list ${swapping ? 'is-swapping' : ''}`}>
        {list.map((e) => (
          <EntryCard
            key={e.id}
            e={e}
            keyword={keyword}
            linkCount={derived.linksOf(e.id).length}
            analyzing={e.ai_state === 'pending' || state.analyzing.includes(e.id)}
            onOpen={() => actions.openEntry(e.id)}
            onToggle={() => void actions.toggleEntry(e.id)}
          />
        ))}
      </div>
    )
  }

  return (
    <section className={`view ${active ? '' : 'hidden'}`} id="view-inbox">
      <header className="view-head">
        <h1>收件箱</h1>
        <p>写下来就好，分类、摘要和关联交给它</p>
      </header>

      <div className="filters">
        <span className="ink-group" data-ink="kind">
          {KIND_CHIPS.map(([k, label]) => (
            <button
              key={k}
              type="button"
              className={`chip ${state.filter.kind === k ? 'active' : ''}`}
              data-act="set-kind"
              data-kind={k}
              onClick={() => {
                if (state.filter.kind === k) return
                actions.setFilterKind(k)
              }}
            >
              {label}
            </button>
          ))}
          <span className="filter-ink" aria-hidden="true"></span>
        </span>
        <span className="spacer"></span>
        <span className="ink-group" data-ink="scope">
          {SCOPE_CHIPS.map(([s, label]) => (
            <button
              key={s}
              type="button"
              className={`chip ${state.filter.scope === s ? 'active' : ''}`}
              data-act="set-scope"
              data-scope={s}
              onClick={() => {
                if (state.filter.scope === s) return
                actions.setFilterScope(s)
              }}
            >
              {label}
            </button>
          ))}
          <span className="filter-ink" aria-hidden="true"></span>
        </span>
      </div>
      <div className="filters" style={{ marginTop: '-4px' }}>
        <span className="stat-line">
          共 {total} 条记录 · 未完成 {openCount} 条
          {keyword
            ? ` · 检索「${keyword}」命中 ${list.length} 条`
            : list.length !== total
              ? ` · 当前筛选 ${list.length} 条`
              : ''}
        </span>
      </div>

      {body}
    </section>
  )
}
