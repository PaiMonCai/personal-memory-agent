/** 问答：只依据用户自己的记录回答 */
import { useEffect, useRef } from 'react'
import { useStore } from '../../state/store'
import { renderRichText } from '../../lib/ui'
import { RichText } from '../Overlays'

function suggestions(n: number, topTag: string | null, hasOpenTodo: boolean): string[] {
  const out: string[] = []
  if (hasOpenTodo) out.push('我有哪些待办快到期了？')
  if (topTag) out.push(`帮我梳理一下关于「${topTag}」的记录`)
  out.push('我最近主要在关注什么？')
  out.push('有哪些想法一直没有推进？')
  return out.slice(0, n)
}

export function AskView({ active }: { active: boolean }) {
  const { state, actions, derived } = useStore()
  const threadRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const { messages, busy } = state.ask

  const entries = derived.activeEntries()
  const tagCount: Record<string, number> = {}
  for (const e of entries) for (const t of e.tags || []) tagCount[t] = (tagCount[t] || 0) + 1
  const topTag = Object.entries(tagCount).sort((a, b) => b[1] - a[1])[0]?.[0] || null
  const hasOpenTodo = entries.some((e) => e.kind === 'todo' && e.status !== 'done')

  useEffect(() => {
    const el = threadRef.current
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' })
  }, [messages.length, messages[messages.length - 1]?.content])

  const submit = () => {
    const value = inputRef.current?.value.trim() || ''
    if (!value) return
    if (inputRef.current) inputRef.current.value = ''
    void actions.handleAsk(value)
  }

  return (
    <section className={`view ${active ? '' : 'hidden'}`} id="view-ask">
      <header className="view-head">
        <h1>问答</h1>
        <p>只依据你自己的记录回答，记录里没有的它会直说 · 基于 {entries.length} 条</p>
      </header>

      <div className="card">
        {messages.length ? (
          <div className="card-head">
            <span className="spacer"></span>
            <button type="button" className="btn btn-ghost btn-sm" id="btn-clear-ask" onClick={actions.clearAsk}>
              清空对话
            </button>
          </div>
        ) : (
          <div className="suggest-row">
            {suggestions(4, topTag, hasOpenTodo).map((s) => (
              <button
                key={s}
                type="button"
                className="chip"
                data-act="ask-suggest"
                data-q={s}
                onClick={() => {
                  if (inputRef.current) inputRef.current.value = s
                  void actions.handleAsk(s)
                }}
              >
                {s}
              </button>
            ))}
          </div>
        )}
        <div className="ask-thread" id="ask-thread" ref={threadRef}>
          {messages.length ? (
            messages.map((m, i) => {
              const isUser = m.role === 'user'
              const streaming = !isUser && i === messages.length - 1 && busy
              return (
                <div className={`msg ${isUser ? 'user' : 'assistant'}`} key={i}>
                  <div className="msg-avatar">{isUser ? '🙋' : '🐾'}</div>
                  <div className="msg-body">
                    <div className="msg-role">{isUser ? '你' : '信息管家'}</div>
                    <div className="msg-text" data-streaming={streaming ? '1' : undefined}>
                      {m.content ? <RichText html={renderRichText(m.content)} /> : busy ? <div className="spinner"></div> : null}
                    </div>
                  </div>
                </div>
              )
            })
          ) : (
            <div className="empty">
              <div className="empty-icon">💬</div>
              <h3>问点什么吧</h3>
              <p>它只会依据你自己的记录回答，记录里没有的会直接告诉你没有。</p>
            </div>
          )}
        </div>
        <div className="ask-input" style={{ marginTop: 16 }}>
          <textarea
            id="ask-input"
            ref={inputRef}
            placeholder="比如：我上次记的那个想法后来推进了吗？"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit()
              }
            }}
          ></textarea>
          {busy ? (
            <button type="button" className="btn btn-ghost" id="btn-stop-ask" onClick={actions.stopAsk}>
              停止
            </button>
          ) : (
            <button type="button" className="btn btn-primary" id="btn-ask" onClick={submit}>
              发送
            </button>
          )}
        </div>
      </div>
    </section>
  )
}
