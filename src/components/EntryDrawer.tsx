/** 条目详情抽屉 */
import { useEffect, useRef, useState } from 'react'
import { useStore } from '../state/store'
import { fmtDateTime, kindMeta, STATUS_META, PRIORITY_META, dueHint } from '../lib/ui'

export function EntryDrawer() {
  const { state, actions, derived } = useStore()
  const { drawerId, editingId } = state
  const entry = drawerId != null ? derived.entryById(drawerId) : undefined
  const [draft, setDraft] = useState('')
  const headRef = useRef<HTMLDivElement>(null)

  // 打开时把焦点送进抽屉（延迟一帧，等过渡与 DOM 落定）
  useEffect(() => {
    if (drawerId == null) return
    const t = setTimeout(() => {
      headRef.current?.querySelector<HTMLElement>('button, [href], input, textarea, [tabindex]:not([tabindex="-1"])')?.focus({ preventScroll: true })
    }, 70)
    return () => clearTimeout(t)
  }, [drawerId])

  // 进入编辑态时把原文装进草稿
  useEffect(() => {
    if (editingId != null && entry) setDraft(entry.raw_text)
  }, [editingId, entry])

  if (!entry) return <aside className="drawer hidden" id="drawer" role="dialog" aria-modal="true" aria-label="条目详情" />

  const km = kindMeta(entry.kind)
  const st = STATUS_META[entry.status] || STATUS_META.inbox
  const due = dueHint(entry.due_date)
  const analyzing = state.analyzing.includes(entry.id) || entry.ai_state === 'pending'
  const related = derived
    .linksOf(entry.id)
    .map((l) => ({ link: l, target: derived.entryById(l.id) }))
    .filter((x) => x.target)

  return (
    <aside className="drawer" id="drawer" ref={headRef} role="dialog" aria-modal="true" aria-label="条目详情">
      <div className="drawer-head">
        <h2 id="drawer-title">{entry.title || '未命名记录'}</h2>
        <button type="button" className="btn btn-ghost btn-sm" data-act="close-drawer" onClick={actions.closeDrawer}>
          关闭
        </button>
      </div>
      <div className="entry-top" style={{ marginBottom: 4 }}>
        <span className={`badge ${km.cls}`}>{km.icon} {km.label}</span>
        <span className="badge badge-soft">{st.label}</span>
        <span className="badge badge-soft">优先级 {PRIORITY_META[entry.priority]?.label || '中'}</span>
        {due ? <span className={`badge ${due.level === 'over' ? 'badge-over' : 'badge-due'}`}>{due.text}</span> : null}
        {analyzing ? <span className="badge badge-ai">AI 分析中…</span> : null}
      </div>
      <p className="card-sub" style={{ margin: '8px 0 0' }}>
        记录于 {fmtDateTime(entry.created_at)}
        {entry.updated_at && entry.updated_at !== entry.created_at ? ` · 更新于 ${fmtDateTime(entry.updated_at)}` : ''}
      </p>

      {entry.summary ? (
        <div className="drawer-section">
          <h3>摘要</h3>
          <div className="raw-box">{entry.summary}</div>
        </div>
      ) : null}
      {entry.key_points?.length ? (
        <div className="drawer-section">
          <h3>重点信息</h3>
          <ul className="kv-list">{entry.key_points.map((p) => <li key={p}>{p}</li>)}</ul>
        </div>
      ) : null}
      {entry.action_items?.length ? (
        <div className="drawer-section">
          <h3>行动项</h3>
          <ul className="kv-list">{entry.action_items.map((p) => <li key={p}>{p}</li>)}</ul>
        </div>
      ) : null}
      {entry.tags?.length ? (
        <div className="drawer-section">
          <h3>标签</h3>
          <div className="entry-tags">{entry.tags.map((t) => <span className="tag" key={t}>{t}</span>)}</div>
        </div>
      ) : null}

      <div className="drawer-section">
        <h3>
          原文{' '}
          {editingId === entry.id ? null : (
            <button type="button" className="link" data-act="edit-raw" data-id={entry.id} onClick={() => actions.startEdit(entry.id)}>
              编辑
            </button>
          )}
        </h3>
        <div id="raw-area">
          {editingId === entry.id ? (
            <>
              <textarea
                id="raw-edit"
                style={{
                  width: '100%',
                  minHeight: 140,
                  padding: 12,
                  border: '1px solid var(--line-strong)',
                  borderRadius: 11,
                  lineHeight: 1.75,
                  outline: 'none',
                }}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
              ></textarea>
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  data-act="save-raw"
                  data-id={entry.id}
                  onClick={() => void actions.saveRaw(entry.id, draft.trim())}
                >
                  保存并重新分析
                </button>
                <button type="button" className="btn btn-ghost btn-sm" data-act="cancel-raw" data-id={entry.id} onClick={() => actions.cancelEdit()}>
                  取消
                </button>
              </div>
            </>
          ) : (
            <div className="raw-box">{entry.raw_text}</div>
          )}
        </div>
      </div>

      <div className="drawer-section">
        <h3>关联内容 {related.length ? `· ${derived.linksOf(entry.id).length}` : ''}</h3>
        {related.length ? (
          related.map(({ link, target }) => (
            <div
              className="related-item"
              key={target!.id}
              data-act="open-entry"
              data-id={target!.id}
              onClick={() => actions.openEntry(target!.id)}
            >
              <span className={`badge ${kindMeta(target!.kind).cls}`}>{kindMeta(target!.kind).icon}</span>
              <span className="t">
                <strong>{(target!.title || target!.raw_text).slice(0, 44)}</strong>
                <small>{link.reason || '内容相关'}</small>
              </span>
            </div>
          ))
        ) : (
          <p className="card-sub" style={{ margin: 0 }}>暂时没有找到关联的记录。</p>
        )}
      </div>

      <div className="drawer-actions">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          data-act="toggle-entry"
          data-id={entry.id}
          onClick={() => void actions.toggleEntry(entry.id)}
        >
          {entry.status === 'done' ? '标记为未完成' : '标记完成'}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" data-act="reanalyze" data-id={entry.id} onClick={() => void actions.reanalyzeEntry(entry.id)}>
          重新分析
        </button>
        <span className="spacer" style={{ flex: 1 }}></span>
        <button type="button" className="btn btn-danger btn-sm" data-act="delete-entry" data-id={entry.id} onClick={() => actions.removeEntry(entry.id)}>
          删除
        </button>
      </div>
    </aside>
  )
}
