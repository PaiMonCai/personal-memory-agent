/** 复盘：区间统计 + 生成 + 历史 */
import { useEffect } from 'react'
import { useStore, computeStats, entriesInRange } from '../../state/store'
import { fmtDateTime, renderRichText } from '../../lib/ui'
import { scheduleFilterInk } from '../../lib/filter-ink'
import { RichText } from '../Overlays'

const RANGE_CHIPS: [string, string][] = [
  ['7', '最近 7 天'],
  ['30', '最近 30 天'],
  ['all', '全部'],
]

export function ReviewView({ active }: { active: boolean }) {
  const { state, actions, derived } = useStore()
  const scoped = entriesInRange(state.reviewRange, derived.activeEntries())
  const stats = computeStats(scoped)

  useEffect(() => {
    scheduleFilterInk()
  }, [state.reviewRange, state.loading, state.reviews.length])

  return (
    <section className={`view ${active ? '' : 'hidden'}`} id="view-review">
      <header className="view-head">
        <h1>复盘</h1>
        <p>把一段时间的记录收拢成一页结论与后续行动</p>
      </header>

      <div className="card">
        <div className="card-head">
          <span className="spacer"></span>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            id="btn-review"
            disabled={state.reviewBusy}
            onClick={() => void actions.handleReview()}
          >
            {state.reviewBusy ? '生成中…' : '✨ 生成复盘'}
          </button>
        </div>
        <div className="filters" style={{ margin: '0 0 14px' }}>
          <span className="ink-group" data-ink="range">
            {RANGE_CHIPS.map(([v, label]) => (
              <button
                key={v}
                type="button"
                className={`chip ${state.reviewRange === v ? 'active' : ''}`}
                data-act="set-range"
                data-range={v}
                onClick={() => actions.setReviewRange(v)}
              >
                {label}
              </button>
            ))}
            <span className="filter-ink" aria-hidden="true"></span>
          </span>
        </div>
        <div className="stat-grid">
          <div className="stat-cell"><b>{stats.total}</b><span>区间内记录</span></div>
          <div className="stat-cell"><b>{stats.byKind.idea || 0}</b><span>想法</span></div>
          <div className="stat-cell"><b>{stats.byKind.material || 0}</b><span>资料</span></div>
          <div className="stat-cell"><b>{stats.byKind.todo || 0}</b><span>待办</span></div>
          <div className="stat-cell"><b>{stats.pending}</b><span>未完成待办</span></div>
          <div className="stat-cell"><b>{stats.done}</b><span>已完成</span></div>
        </div>
        {state.loading ? (
          <div className="skeleton" style={{ height: 60 }}></div>
        ) : stats.total === 0 ? (
          <p className="card-sub" style={{ margin: 0 }}>这段时间还没有记录，换个区间或先去收件箱记点什么。</p>
        ) : state.reviewBusy ? (
          <div className="advice-box">
            <div className="spinner"></div> <span id="review-progress">正在读取记录并生成总结…</span>
          </div>
        ) : null}
      </div>

      <div className="card">
        <div className="card-head">
          <h2>历史复盘</h2>
          <span className="card-sub">{state.reviews.length} 份</span>
        </div>
        {state.reviews.length ? (
          state.reviews.map((r) => (
            <div className="review-item" key={r.id}>
              <div className="review-head">
                <h3>{r.period_label}</h3>
                <span className="badge badge-soft">{r.entry_count} 条记录</span>
                <span className="card-sub">{fmtDateTime(r.created_at)}</span>
                <span className="spacer"></span>
                <button type="button" className="link" data-act="delete-review" data-id={r.id} onClick={() => void actions.removeReview(r.id)}>
                  删除
                </button>
              </div>
              <div className="review-body">
                <RichText html={renderRichText(r.summary || '')} />
              </div>
              {r.actions?.length ? (
                <div className="review-actions">
                  <h4>后续行动建议</h4>
                  {r.actions.map((a, i) => (
                    <div className="action-item" key={i}>
                      <span className="action-num">{i + 1}</span>
                      <span>{a}</span>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ))
        ) : (
          <div className="empty">
            <div className="empty-icon">📊</div>
            <h3>还没有复盘</h3>
            <p>积累几条记录后，点「生成复盘」看看这段时间的轨迹。</p>
          </div>
        )}
      </div>
    </section>
  )
}
