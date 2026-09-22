/**
 * 轻提示与确认框的 React 宿主。
 * DOM 契约与旧实现一致：#toast-host / .toast / .toast-action、#modal-host / .modal-mask。
 */
import { useEffect, useState } from 'react'
import {
  dismissToast,
  resolveConfirm,
  subscribeConfirm,
  subscribeToasts,
  type ToastItem,
} from '../lib/overlays'
import { highlightParts } from '../lib/ui'

export function ToastHost() {
  const [items, setItems] = useState<ToastItem[]>([])
  useEffect(() => subscribeToasts(setItems), [])

  return (
    <div id="toast-host" className="toast-host" role="status" aria-live="polite" aria-atomic="false">
      {items.map((t) => (
        <div key={t.id} className={`toast toast-${t.type}`}>
          <span>{t.message}</span>
          {t.action ? (
            <button
              type="button"
              className="toast-action"
              onClick={() => {
                t.action?.onClick()
                dismissToast(t.id)
              }}
            >
              {t.action.label}
            </button>
          ) : null}
        </div>
      ))}
    </div>
  )
}

interface PendingConfirm {
  title: string
  message?: string
  confirmText?: string
  danger?: boolean
  resolve: (value: boolean) => void
}

export function ConfirmHost() {
  const [pending, setPending] = useState<PendingConfirm | null>(null)
  useEffect(() => subscribeConfirm(setPending as (p: PendingConfirm | null) => void), [])

  useEffect(() => {
    if (!pending) return
    // 危险操作默认聚焦「取消」，避免误按回车
    const host = document.getElementById('modal-host')
    const initial = host?.querySelector<HTMLElement>(
      pending.danger ? '[data-act="cancel"]' : '[data-act="ok"]'
    )
    initial?.focus({ preventScroll: true })
  }, [pending])

  useEffect(() => {
    if (!pending) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // 捕获阶段拦截 Esc，避免同时触发下层浮层的关闭逻辑
        e.stopPropagation()
        resolveConfirm(false)
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [pending])

  if (!pending) return <div id="modal-host" />

  return (
    <div id="modal-host">
      <div className="modal-mask">
        <div className="modal-box" role="dialog" aria-modal="true" aria-label={pending.title}>
          <h3>{pending.title}</h3>
          {pending.message ? <p>{pending.message}</p> : null}
          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" data-act="cancel" onClick={() => resolveConfirm(false)}>
              取消
            </button>
            <button
              type="button"
              className={`btn ${pending.danger ? 'btn-danger' : 'btn-primary'}`}
              data-act="ok"
              onClick={() => resolveConfirm(true)}
            >
              {pending.confirmText || '确定'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/** 富文本：内容已在 renderRichText 里转义，这里只负责注入 */
export function RichText({ html }: { html: string }) {
  return <div dangerouslySetInnerHTML={{ __html: html }} />
}

/** 关键词高亮：命中片段包一层 <mark> */
export function Highlight({ text, keyword }: { text: unknown; keyword?: string }) {
  const kw = String(keyword || '').trim()
  if (!kw) return <>{String(text ?? '')}</>
  const parts = highlightParts(text, kw)
  return (
    <>
      {parts.map((p, i) => (p.hit ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}
    </>
  )
}
