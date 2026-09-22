/**
 * 右栏：随手记 + md 导入。
 *
 * 拖拽实现的三个坑（与旧实现一致）：
 * 1. dragenter/dragleave 会在子元素之间反复触发，必须用计数器判断真正离开；
 * 2. dragleave 的 dataTransfer 在部分浏览器里取不到 types，所以这里不能再判断"是不是文件"，
 *    否则计数只增不减、高亮会一直卡在界面上；
 * 3. Esc 取消拖拽、拖出窗口等情况可能收不到 dragleave，用一个空闲计时器兜底。
 */
import { useEffect, useRef, useState } from 'react'
import { useStore } from '../state/store'
import { hasFiles, isMarkdown } from '../lib/memory'
import { toast } from '../lib/overlays'
import { kindMeta } from '../lib/ui'
import { describeError } from '../lib/data'

export function ComposeRail() {
  const { state, actions } = useStore()
  const [text, setText] = useState('')
  const [importing, setImporting] = useState<string | null>(null)
  const railRef = useRef<HTMLElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const depth = useRef(0)
  const active = useRef(false)
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 窄屏抽屉打开后聚焦输入框。延迟与旧实现一致：等右栏滑入的过渡基本结束再聚焦，
  // 否则焦点落在还在移动的元素上，部分浏览器会连带把滚动位置带偏
  useEffect(() => {
    if (!state.railOpen) return
    const t = setTimeout(() => inputRef.current?.focus(), 330)
    return () => clearTimeout(t)
  }, [state.railOpen])

  useEffect(() => {
    const rail = railRef.current
    if (!rail) return

    const clear = () => {
      depth.current = 0
      active.current = false
      if (idleTimer.current) clearTimeout(idleTimer.current)
      idleTimer.current = null
      rail.classList.remove('drag-over')
      // 用 class 而非 hidden 属性：作者的 display 会盖掉 UA 的 [hidden]{display:none}
      rail.querySelector('.rail-drop-hint')?.classList.remove('show')
    }

    // 只要还在 dragover，就不断续期；停止超过 1.2 秒即认为拖拽已结束
    const keepAlive = () => {
      if (idleTimer.current) clearTimeout(idleTimer.current)
      idleTimer.current = setTimeout(clear, 1200)
    }

    const onDragEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      active.current = true
      depth.current += 1
      rail.classList.add('drag-over')
      rail.querySelector('.rail-drop-hint')?.classList.add('show')
      keepAlive()
    }
    const onDragOver = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
      keepAlive()
    }
    // 不判断 hasFiles：拖拽离开时 dataTransfer.types 可能为空
    const onDragLeave = () => {
      if (!active.current) return
      depth.current = Math.max(0, depth.current - 1)
      if (depth.current === 0) clear()
    }
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      clear()
      const files = Array.from(e.dataTransfer?.files || []).filter(isMarkdown)
      if (!files.length) {
        toast('只支持 .md / .markdown / .mdx / .txt 文件', 'warn', 4000)
        return
      }
      void actions.handleMdFiles(files)
    }

    // 拖拽结束、拖出窗口、拖拽被取消 —— 都要把高亮收掉
    const onWindowDragEnd = () => clear()
    const onWindowDragLeave = (e: DragEvent) => {
      if (!e.relatedTarget) clear() // relatedTarget 为空 = 真离开了窗口
    }
    // 拖到页面其他位置时别让浏览器直接打开文件
    const onWindowDragOver = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault()
    }
    const onWindowDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      clear()
    }

    rail.addEventListener('dragenter', onDragEnter)
    rail.addEventListener('dragover', onDragOver)
    rail.addEventListener('dragleave', onDragLeave)
    rail.addEventListener('drop', onDrop)
    window.addEventListener('dragend', onWindowDragEnd)
    window.addEventListener('dragleave', onWindowDragLeave)
    window.addEventListener('dragover', onWindowDragOver)
    window.addEventListener('drop', onWindowDrop)
    return () => {
      rail.removeEventListener('dragenter', onDragEnter)
      rail.removeEventListener('dragover', onDragOver)
      rail.removeEventListener('dragleave', onDragLeave)
      rail.removeEventListener('drop', onDrop)
      window.removeEventListener('dragend', onWindowDragEnd)
      window.removeEventListener('dragleave', onWindowDragLeave)
      window.removeEventListener('dragover', onWindowDragOver)
      window.removeEventListener('drop', onWindowDrop)
    }
  }, [actions])

  const capture = async () => {
    const value = text.trim()
    if (!value) {
      toast('先写点什么再记录吧', 'warn')
      return
    }
    setText('')
    setImporting('正在保存…')
    const res = await actions.saveEntryAndAnalyze(value)
    setImporting(null)
    if (res.ok) {
      const km = kindMeta(res.result.kind)
      const extra = res.result.related_ids.length ? `，关联到 ${res.result.related_ids.length} 条已有记录` : ''
      toast(`已归类为「${km.label}」${extra}`, 'success')
    } else {
      toast(`AI 分析失败：${describeError(res.error)}`, 'error', 6000)
    }
  }

  return (
    <aside className="compose-rail" id="compose-rail" aria-label="随手记" ref={railRef}>
      <button
        type="button"
        className="float-grip"
        data-grip="rail"
        title="上下拖动调整位置（↑ ↓ 微调，Home 回正）"
        aria-label="拖动调整随手记上下位置"
      >
        <span aria-hidden="true"></span>
      </button>
      <div className="rail-head">
        <h2>随手记</h2>
        <div className="rail-head-actions">
          <button
            type="button"
            className="link rail-upload"
            id="btn-upload-md"
            title="上传 .md 文件（也可以直接把文件拖进来）"
            aria-label="上传 .md 文件"
            onClick={() => fileRef.current?.click()}
          >
            <span aria-hidden="true">📎</span>
          </button>
          <button
            type="button"
            className="icon-btn rail-close"
            id="rail-close"
            aria-label="收起随手记"
            onClick={() => actions.closeRail({ restoreFocus: true })}
          >
            ✕
          </button>
        </div>
      </div>
      <textarea
        id="capture-input"
        ref={inputRef}
        placeholder="一个想法、一段资料、一件要做的事…"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault()
            void capture()
          }
        }}
      />
      <div className={`ai-stage ${importing ? '' : 'hidden'}`} id="ai-stage">
        <div className="spinner"></div>
        <span id="ai-stage-text">{importing || '正在分析…'}</span>
      </div>
      <button type="button" className="btn btn-primary btn-block" id="btn-capture" onClick={() => void capture()}>
        记录
      </button>
      <p className="rail-hint">保存后会自动分类、生成摘要并找出关联。把 .md 文件拖进来可以批量导入。</p>
      <div className="rail-drop-hint" id="rail-drop-hint">
        松开即导入 .md
      </div>
      <input
        type="file"
        id="md-file"
        accept=".md,.markdown,.mdx,.txt,text/markdown"
        multiple
        ref={fileRef}
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files || [])
          e.target.value = ''
          if (files.length) void actions.handleMdFiles(files)
        }}
      />
    </aside>
  )
}
