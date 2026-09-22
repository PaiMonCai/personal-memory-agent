/**
 * 轻提示与确认框。
 *
 * 这两块在旧实现里是命令式的 DOM 操作；改成"事件总线 + React 宿主"后，
 * 业务代码仍能直接 toast(...) / await confirmDialog(...)，不必层层传回调。
 * DOM 契约（.toast / .toast-action / .modal-mask / #modal-host）保持不变。
 */

export type ToastType = 'info' | 'success' | 'error' | 'warn'

export interface ToastAction {
  label: string
  onClick: () => void
}

export interface ToastItem {
  id: number
  message: string
  type: ToastType
  ms: number
  action: ToastAction | null
}

type Listener = (items: ToastItem[]) => void

const listeners = new Set<Listener>()
let items: ToastItem[] = []
let seq = 0

function emit() {
  for (const l of listeners) l(items)
}

export function subscribeToasts(l: Listener): () => void {
  listeners.add(l)
  l(items)
  return () => listeners.delete(l)
}

export function toast(message: string, type: ToastType = 'info', ms = 3200, action: ToastAction | null = null) {
  seq += 1
  const item: ToastItem = { id: seq, message, type, ms, action }
  items = [...items, item]
  emit()
  if (ms > 0) {
    setTimeout(() => dismissToast(item.id), ms)
  }
}

export function dismissToast(id: number) {
  items = items.filter((t) => t.id !== id)
  emit()
}

/* ------------------------------------------------------------------ 确认框 */

export interface ConfirmOptions {
  title: string
  message?: string
  confirmText?: string
  danger?: boolean
}

interface PendingConfirm extends ConfirmOptions {
  resolve: (value: boolean) => void
}

let pending: PendingConfirm | null = null
const confirmListeners = new Set<(p: PendingConfirm | null) => void>()

export function subscribeConfirm(l: (p: PendingConfirm | null) => void): () => void {
  confirmListeners.add(l)
  l(pending)
  return () => confirmListeners.delete(l)
}

export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    pending = { ...options, resolve }
    for (const l of confirmListeners) l(pending)
  })
}

export function resolveConfirm(value: boolean) {
  const p = pending
  pending = null
  for (const l of confirmListeners) l(null)
  p?.resolve(value)
}
