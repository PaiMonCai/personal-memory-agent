/**
 * 应用状态与全部交互动作。
 *
 * 这一层对应旧实现的 state 对象 + 那些散落在 app.js 里的函数。
 * 所有写操作都收敛到这里，视图组件只读 state、调 action。
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from 'react'
import * as db from '../lib/data'
import { auth } from '../lib/api'
import { describeError } from '../lib/data'
import * as ai from '../lib/ai'
import { DEFAULT_SETTINGS, applySettings, normalizeSettings } from '../lib/settings'
import { setEffect } from '../lib/effects'
import { dueHint, PRIORITY_META, fmtDate } from '../lib/ui'
import { memoryChunks, mdTitle } from '../lib/memory'
import { SETTINGS_CACHE_KEY, readRaw, removeKey, writeRaw } from '../lib/storage'
import { toast } from '../lib/overlays'
import type { AnalysisResult, ChatMessage, Entry, EntryLink, Review, Settings } from '../lib/types'

export type ViewName = 'inbox' | 'todo' | 'ask' | 'review'

export interface AppState {
  phase: 'boot' | 'auth' | 'app'
  user: { id: string; email: string; role: string } | null
  entries: Entry[]
  searchResults: Entry[]
  links: EntryLink[]
  reviews: Review[]
  filter: { kind: string; scope: string; keyword: string }
  view: ViewName
  ask: { messages: ChatMessage[]; busy: boolean }
  todoAdvice: string
  todoAdviceBusy: boolean
  reviewBusy: boolean
  reviewRange: string
  loading: boolean
  analyzing: number[]
  settings: Settings
  settingsStatus: string
  /** 抽屉里的条目 id；null = 抽屉关闭 */
  drawerId: number | null
  /** 抽屉里是否正在编辑原文 */
  editingId: number | null
  navOpen: boolean
  railOpen: boolean
  panelOpen: boolean
  /** 待删队列变化记号。撤销 / 落库失败都要让界面重算，否则列表不刷新 */
  pendingVersion: number
}

type Action =
  | { type: 'phase'; phase: AppState['phase'] }
  | { type: 'user'; user: AppState['user'] }
  | { type: 'entries'; entries: Entry[] }
  | { type: 'searchResults'; entries: Entry[] }
  | { type: 'links'; links: EntryLink[] }
  | { type: 'reviews'; reviews: Review[] }
  | { type: 'setEntry'; entry: Entry }
  | { type: 'replaceEntry'; id: number; entry: Entry }
  | { type: 'filter'; patch: Partial<AppState['filter']> }
  | { type: 'view'; view: ViewName }
  | { type: 'ask/messages'; messages: ChatMessage[] }
  | { type: 'ask/busy'; busy: boolean }
  | { type: 'ask/append'; content: string }
  | { type: 'todoAdvice'; text: string }
  | { type: 'todoAdviceBusy'; busy: boolean }
  | { type: 'reviewBusy'; busy: boolean }
  | { type: 'reviewRange'; range: string }
  | { type: 'loading'; loading: boolean }
  | { type: 'analyzing/add'; id: number }
  | { type: 'analyzing/remove'; id: number }
  | { type: 'settings'; settings: Settings }
  | { type: 'settingsStatus'; text: string }
  | { type: 'drawer'; id: number | null }
  | { type: 'editing'; id: number | null }
  | { type: 'nav'; open: boolean }
  | { type: 'rail'; open: boolean }
  | { type: 'panel'; open: boolean }
  | { type: 'resetSession' }
  | { type: 'pendingVersion/bump' }

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'phase':
      return { ...state, phase: action.phase }
    case 'user':
      return { ...state, user: action.user }
    case 'entries':
      return { ...state, entries: action.entries }
    case 'searchResults':
      return { ...state, searchResults: action.entries }
    case 'links':
      return { ...state, links: action.links }
    case 'reviews':
      return { ...state, reviews: action.reviews }
    case 'setEntry':
      return {
        ...state,
        entries: state.entries.map((e) => (e.id === action.entry.id ? action.entry : e)),
        searchResults: state.searchResults.map((e) => (e.id === action.entry.id ? action.entry : e)),
      }
    case 'replaceEntry':
      return { ...state, entries: state.entries.map((x) => (x.id === action.id ? action.entry : x)) }
    case 'filter':
      return { ...state, filter: { ...state.filter, ...action.patch } }
    case 'view':
      return { ...state, view: action.view }
    case 'ask/messages':
      return { ...state, ask: { ...state.ask, messages: action.messages } }
    case 'ask/busy':
      return { ...state, ask: { ...state.ask, busy: action.busy } }
    case 'ask/append':
      return {
        ...state,
        ask: {
          ...state.ask,
          messages: state.ask.messages.map((m, i) =>
            i === state.ask.messages.length - 1 && m.role === 'assistant'
              ? { ...m, content: m.content + action.content }
              : m
          ),
        },
      }
    case 'todoAdvice':
      return { ...state, todoAdvice: action.text }
    case 'todoAdviceBusy':
      return { ...state, todoAdviceBusy: action.busy }
    case 'reviewBusy':
      return { ...state, reviewBusy: action.busy }
    case 'reviewRange':
      return { ...state, reviewRange: action.range }
    case 'loading':
      return { ...state, loading: action.loading }
    case 'analyzing/add':
      return state.analyzing.includes(action.id) ? state : { ...state, analyzing: [...state.analyzing, action.id] }
    case 'analyzing/remove':
      return { ...state, analyzing: state.analyzing.filter((x) => x !== action.id) }
    case 'settings':
      return { ...state, settings: action.settings }
    case 'settingsStatus':
      return { ...state, settingsStatus: action.text }
    case 'drawer':
      return { ...state, drawerId: action.id }
    case 'editing':
      return { ...state, editingId: action.id }
    case 'nav':
      return { ...state, navOpen: action.open }
    case 'rail':
      return { ...state, railOpen: action.open }
    case 'panel':
      return { ...state, panelOpen: action.open }
    case 'pendingVersion/bump':
      return { ...state, pendingVersion: state.pendingVersion + 1 }
    case 'resetSession':
      return {
        ...state,
        phase: 'auth',
        user: null,
        entries: [],
        searchResults: [],
        links: [],
        reviews: [],
        ask: { messages: [], busy: false },
        drawerId: null,
        editingId: null,
        navOpen: false,
        railOpen: false,
        panelOpen: false,
      }
    default:
      return state
  }
}

/* ------------------------------------------------------------ 初始状态 */

/**
 * 本地只做一份缓存，让登录页也能沿用上次的配色；云端仍是权威来源。
 * 这里刻意把自定义模型的密钥剔掉：这份缓存只是为了登录页不闪一下默认配色，
 * 没必要把密钥再往浏览器里存一份（云端那份是你自己选的同步方式）。
 */
function cacheSettings(s: Settings) {
  try {
    let safe: Settings = s
    const custom = s?.ai?.custom
    if (custom && Array.isArray(custom.vendors)) {
      safe = {
        ...s,
        ai: {
          ...s.ai,
          custom: {
            ...custom,
            // 密钥挂在供应商上，要逐家剔掉 —— 只清 custom.apiKey 的话，密钥会原样留在缓存里
            vendors: custom.vendors.map((v) => ({ ...v, apiKey: '' })),
          },
        },
      }
    }
    writeRaw(SETTINGS_CACHE_KEY, JSON.stringify(safe))
  } catch {
    /* 隐私模式下写入失败，忽略 */
  }
}

function readCachedSettings(): Settings {
  try {
    const raw = readRaw(SETTINGS_CACHE_KEY)
    return raw ? normalizeSettings(JSON.parse(raw)) : normalizeSettings(DEFAULT_SETTINGS)
  } catch {
    return normalizeSettings(DEFAULT_SETTINGS)
  }
}

const initialState: AppState = {
  phase: 'boot',
  user: null,
  entries: [],
  searchResults: [],
  links: [],
  reviews: [],
  filter: { kind: 'all', scope: 'open', keyword: '' },
  view: 'inbox',
  ask: { messages: [], busy: false },
  todoAdvice: '',
  todoAdviceBusy: false,
  reviewBusy: false,
  reviewRange: '7',
  loading: true,
  analyzing: [],
  settings: readCachedSettings(),
  settingsStatus: '',
  drawerId: null,
  editingId: null,
  navOpen: false,
  railOpen: false,
  panelOpen: false,
  pendingVersion: 0,
}

export const UNDO_MS = 6000

export interface AppActions {
  enterApp: (session: { user: { id: string; email: string; role: string } }) => Promise<void>
  logout: () => Promise<void>
  goAuth: () => void
  refreshAll: () => Promise<void>
  refreshEntries: () => Promise<void>
  setView: (view: ViewName) => void
  setFilterKind: (kind: string) => void
  setFilterScope: (scope: string) => void
  setReviewRange: (range: string) => void
  setKeyword: (keyword: string) => void
  saveEntryAndAnalyze: (
    rawText: string,
    opts?: { titleHint?: string }
  ) => Promise<{ ok: true; entry: Entry; result: AnalysisResult } | { ok: false; error: unknown }>
  handleMdFiles: (files: File[]) => Promise<void>
  toggleEntry: (id: number) => Promise<void>
  removeEntry: (id: number) => void
  undoDelete: (id: number) => void
  reanalyzeEntry: (id: number) => Promise<void>
  saveRaw: (id: number, text: string) => Promise<void>
  handleTidy: () => Promise<void>
  handleAsk: (text: string) => Promise<void>
  stopAsk: () => void
  clearAsk: () => void
  handleReview: () => Promise<void>
  removeReview: (id: number) => Promise<void>
  onSettingsChange: (next: Settings) => void
  resetSettings: () => void
  saveSettingsNow: () => Promise<void>
  openSettings: () => void
  closeSettings: () => void
  openEntry: (id: number) => void
  closeDrawer: () => void
  startEdit: (id: number) => void
  cancelEdit: () => void
  openNav: () => void
  closeNav: (opts?: { restoreFocus?: boolean }) => void
  openRail: () => void
  closeRail: (opts?: { restoreFocus?: boolean }) => void
}

export interface Store {
  state: AppState
  actions: AppActions
  appRef: React.RefObject<HTMLDivElement>
  narrow: () => boolean
  /** 与旧实现一致的派生数据：待删过滤后的全量、当前筛选可见、关联、待办分组 */
  derived: {
    activeEntries: () => Entry[]
    visibleEntries: () => Entry[]
    linksOf: (id: number) => { id: number; reason: string | null }[]
    todoBuckets: () => ReturnType<typeof emptyBuckets>
    entryById: (id: number) => Entry | undefined
  }
}

function emptyBuckets() {
  return {
    buckets: { over: [] as Entry[], today: [] as Entry[], week: [] as Entry[], later: [] as Entry[], none: [] as Entry[] },
    doneList: [] as Entry[],
  }
}

const StoreContext = createContext<Store | null>(null)

export function useStore(): Store {
  const s = useContext(StoreContext)
  if (!s) throw new Error('useStore 必须在 AppProvider 内使用')
  return s
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState)
  const stateRef = useRef(state)
  stateRef.current = state

  const appRef = useRef<HTMLDivElement>(null)
  const askController = useRef<AbortController | null>(null)
  const settingsSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 待删除队列：id -> timer。删除先从界面移除并给 6 秒撤销窗口，到点才真正落库 */
  const pendingDeletes = useRef(new Map<number, ReturnType<typeof setTimeout> | null>())

  /* --------------------------------------------------------- 派生数据 */

  const activeEntries = useCallback(
    () => stateRef.current.entries.filter((e) => !pendingDeletes.current.has(e.id)),
    []
  )

  const sourceEntries = useCallback(
    () =>
      stateRef.current.filter.keyword
        ? stateRef.current.searchResults.filter((e) => !pendingDeletes.current.has(e.id))
        : activeEntries(),
    [activeEntries]
  )

  const visibleEntries = useCallback(() => {
    const { kind, scope } = stateRef.current.filter
    return sourceEntries().filter((e) => {
      if (kind === 'key') {
        if (!(e.key_points && e.key_points.length)) return false
      } else if (kind !== 'all' && e.kind !== kind) {
        return false
      }
      if (scope === 'open') return e.status === 'inbox' || e.status === 'active'
      if (scope === 'done') return e.status === 'done'
      return true
    })
  }, [sourceEntries])

  const entryById = useCallback((id: number) => stateRef.current.entries.find((e) => e.id === id), [])

  const linksOf = useCallback((id: number) => {
    const out: { id: number; reason: string | null }[] = []
    for (const l of stateRef.current.links) {
      if (l.source_id === id) out.push({ id: l.target_id, reason: l.reason })
      else if (l.target_id === id) out.push({ id: l.source_id, reason: l.reason })
    }
    const seen = new Set<number>()
    return out.filter((x) => {
      if (seen.has(x.id)) return false
      seen.add(x.id)
      return true
    })
  }, [])

  const todoBuckets = useCallback(() => {
    const open = activeEntries().filter(
      (e) =>
        (e.kind === 'todo' || (e.action_items && e.action_items.length)) &&
        e.status !== 'done' &&
        e.status !== 'archived'
    )
    const buckets: Record<'over' | 'today' | 'week' | 'later' | 'none', Entry[]> = {
      over: [], today: [], week: [], later: [], none: [],
    }
    for (const e of open) {
      if (!e.due_date) {
        buckets.none.push(e)
        continue
      }
      const hint = dueHint(e.due_date)
      if (!hint) buckets.none.push(e)
      else if (hint.level === 'over') buckets.over.push(e)
      else if (hint.level === 'today') buckets.today.push(e)
      else if (hint.level === 'soon') buckets.week.push(e)
      else buckets.later.push(e)
    }
    const doneList = activeEntries().filter((e) => e.kind === 'todo' && e.status === 'done')
    return { buckets, doneList }
  }, [activeEntries])

  /* ---------------------------------------------------------- 启动与设置 */

  const useSettings = useCallback((s: Settings, { persist = true }: { persist?: boolean } = {}) => {
    dispatch({ type: 'settings', settings: s })
    applySettings(s)
    setEffect(s.effect)
    ai.useAiSettings(s.ai) // AI 层不反向依赖设置模块，由这里推入当前配置
    if (persist) cacheSettings(s)
  }, [])

  const loadSettingsFromCloud = useCallback(async () => {
    try {
      const row = await db.getPreferences()
      if (row && (row.theme || row.effect || row.ai)) {
        useSettings(normalizeSettings(row))
        return
      }
    } catch (err) {
      console.warn('[settings] 读取服务器设置失败，沿用本地缓存：', describeError(err))
      return
    }
    useSettings(normalizeSettings(DEFAULT_SETTINGS))
  }, [useSettings])

  const saveSettingsNow = useCallback(async () => {
    settingsSaveTimer.current = null
    try {
      await db.savePreferences({
        theme: stateRef.current.settings.theme,
        effect: stateRef.current.settings.effect,
        ai: stateRef.current.settings.ai,
      })
      dispatch({ type: 'settingsStatus', text: '已保存到服务器' })
    } catch (err) {
      const msg = describeError(err)
      dispatch({ type: 'settingsStatus', text: `保存失败：${msg}` })
      toast(`设置未保存到服务器：${msg}`, 'error', 5000)
    }
  }, [])

  const onSettingsChange = useCallback(
    (next: Settings) => {
      useSettings(next)
      dispatch({ type: 'settingsStatus', text: '正在保存…' })
      if (settingsSaveTimer.current) clearTimeout(settingsSaveTimer.current)
      settingsSaveTimer.current = setTimeout(saveSettingsNow, 700)
    },
    [saveSettingsNow, useSettings]
  )

  /* ------------------------------------------------------------ 数据层 */

  const refreshAll = useCallback(async () => {
    dispatch({ type: 'loading', loading: true })
    try {
      const [entries, links, reviews] = await Promise.all([
        db.listEntries(),
        db.listLinks(),
        db.listReviews(),
      ])
      dispatch({ type: 'entries', entries: entries || [] })
      dispatch({ type: 'links', links: links || [] })
      dispatch({ type: 'reviews', reviews: reviews || [] })
    } catch (err) {
      toast(describeError(err), 'error', 5000)
    } finally {
      dispatch({ type: 'loading', loading: false })
    }
  }, [])

  /** 关键词检索走后端函数，其余筛选在前端完成。
   *  检索结果单独存放，避免把问答 / 复盘 / 待办依赖的全量数据挤掉。 */
  const refreshEntries = useCallback(async () => {
    const { keyword } = stateRef.current.filter
    if (!keyword) {
      dispatch({ type: 'searchResults', entries: [] })
      try {
        dispatch({ type: 'entries', entries: (await db.listEntries()) || [] })
      } catch (err) {
        toast(describeError(err), 'error')
      }
      return
    }
    try {
      dispatch({ type: 'searchResults', entries: (await db.searchEntries({ keyword })) || [] })
    } catch (err) {
      dispatch({ type: 'searchResults', entries: [] })
      toast(describeError(err), 'error')
    }
  }, [])

  /* ---------------------------------------------------------- 记录与删除 */

  const saveEntryAndAnalyze = useCallback<AppActions['saveEntryAndAnalyze']>(async (rawText, opts = {}) => {
    const created = await db.createEntry(rawText)
    dispatch({ type: 'entries', entries: [created, ...stateRef.current.entries] })
    dispatch({ type: 'analyzing/add', id: created.id })

    // 分块属于检索索引，不应因为索引暂时失败而阻断主记录/AI 分析流程。
    try {
      await db.replaceEntryChunks(created.id, memoryChunks(rawText))
    } catch (err) {
      console.warn('[chunks] 写入失败，继续分析主记录：', describeError(err))
    }

    try {
      const result = await ai.analyzeEntry({
        rawText,
        existingEntries: stateRef.current.entries.filter((e) => e.id !== created.id),
      })

      const updated = await db.updateEntry(created.id, {
        kind: result.kind,
        title: result.title || opts.titleHint || created.raw_text.slice(0, 20),
        summary: result.summary,
        key_points: result.key_points,
        action_items: result.action_items,
        tags: result.tags,
        priority: result.priority,
        due_date: result.due_date,
        ai_state: 'done',
      })
      dispatch({ type: 'setEntry', entry: updated })

      if (result.related_ids.length) {
        const valid = result.related_ids.filter(
          (id) => stateRef.current.entries.some((e) => e.id === id && e.id !== created.id)
        )
        if (valid.length) {
          await db.replaceLinks(created.id, valid, result.related_reason)
          dispatch({ type: 'links', links: (await db.listLinks()) || [] })
        }
      }
      return { ok: true as const, entry: updated, result }
    } catch (err) {
      try {
        const failed = await db.updateEntry(created.id, { ai_state: 'failed' })
        dispatch({ type: 'setEntry', entry: failed })
      } catch {
        /* 标记失败本身失败时不阻塞用户 */
      }
      return { ok: false as const, error: err }
    } finally {
      dispatch({ type: 'analyzing/remove', id: created.id })
    }
  }, [])

  const handleMdFiles = useCallback<AppActions['handleMdFiles']>(async (files) => {
    const picked = files.slice(0, 10)
    if (files.length > 10) {
      toast('一次最多导入 10 个文件，其余已忽略', 'warn', 5000)
    }

    let done = 0
    let skipped = 0
    let lastError: unknown = null

    // 串行导入，避免同时打模型
    for (let i = 0; i < picked.length; i++) {
      const file = picked[i]
      try {
        if (file.size > 512 * 1024) {
          skipped++
          toast(`${file.name} 超过 512KB，已跳过`, 'warn', 4000)
          continue
        }
        const text = (await file.text()).trim()
        if (!text) {
          skipped++
          continue
        }
        const res = await saveEntryAndAnalyze(text, { titleHint: mdTitle(text, file.name) })
        if (res.ok) done++
        else {
          skipped++
          lastError = res.error
        }
      } catch (err) {
        skipped++
        lastError = err
      }
    }

    if (done) {
      toast(`已导入 ${done} 个文件${skipped ? `，${skipped} 个跳过或失败` : ''}`, 'success', 4500)
    } else if (lastError) {
      toast(`导入失败：${describeError(lastError)}`, 'error', 6000)
    } else {
      toast('没有可导入的内容（空文件或超出大小限制）', 'warn', 4500)
    }
  }, [saveEntryAndAnalyze])

  const toggleEntry = useCallback<AppActions['toggleEntry']>(async (id) => {
    const e = entryById(id)
    if (!e) return
    const next = e.status === 'done' ? 'inbox' : 'done'
    try {
      const updated = await db.updateEntry(id, { status: next })
      dispatch({ type: 'setEntry', entry: updated })
      toast(next === 'done' ? '已完成 ✓' : '已恢复为未完成', 'success')
    } catch (err) {
      toast(describeError(err), 'error')
    }
  }, [entryById])

  /** 删除：先从界面移除并给出撤销窗口，到点才真正落库 */
  const removeEntry = useCallback<AppActions['removeEntry']>((id) => {
    const e = entryById(id)
    if (!e || pendingDeletes.current.has(id)) return
    const label = (e.title || e.raw_text).replace(/\s+/g, ' ').slice(0, 18)

    dispatch({ type: 'drawer', id: null })
    dispatch({ type: 'pendingVersion/bump' })
    pendingDeletes.current.set(id, null)

    toast(`已删除「${label}」`, 'info', UNDO_MS, { label: '撤销', onClick: () => undoDelete(id) })

    pendingDeletes.current.set(
      id,
      setTimeout(() => {
        pendingDeletes.current.delete(id)
        void commitDelete(id)
      }, UNDO_MS)
    )
  }, [entryById])

  const undoDelete = useCallback<AppActions['undoDelete']>((id) => {
    const rec = pendingDeletes.current.get(id)
    if (rec === undefined) return
    if (rec) clearTimeout(rec)
    pendingDeletes.current.delete(id)
    dispatch({ type: 'pendingVersion/bump' })
    toast('已恢复', 'success', 2200)
  }, [])

  const commitDelete = useCallback(async (id: number) => {
    if (!pendingDeletes.current.has(id)) return
    pendingDeletes.current.delete(id)
    try {
      await db.deleteEntryWithLinks(id)
      dispatch({ type: 'entries', entries: stateRef.current.entries.filter((x) => x.id !== id) })
      dispatch({ type: 'searchResults', entries: stateRef.current.searchResults.filter((x) => x.id !== id) })
      dispatch({
        type: 'links',
        links: stateRef.current.links.filter((l) => l.source_id !== id && l.target_id !== id),
      })
    } catch (err) {
      // 删除失败就让条目回到列表，别让用户以为已经删掉了
      dispatch({ type: 'pendingVersion/bump' })
      toast(`删除失败：${describeError(err)}`, 'error', 6000)
    }
  }, [])

  const reanalyzeEntry = useCallback<AppActions['reanalyzeEntry']>(async (id) => {
    const e = entryById(id)
    if (!e) return
    dispatch({ type: 'analyzing/add', id })
    try {
      try {
        await db.replaceEntryChunks(id, memoryChunks(e.raw_text))
      } catch (err) {
        console.warn('[chunks] 刷新失败，继续重新分析：', describeError(err))
      }
      const result = await ai.analyzeEntry({
        rawText: e.raw_text,
        existingEntries: stateRef.current.entries.filter((x) => x.id !== id),
      })
      const updated = await db.updateEntry(id, {
        kind: result.kind,
        title: result.title || e.raw_text.slice(0, 20),
        summary: result.summary,
        key_points: result.key_points,
        action_items: result.action_items,
        tags: result.tags,
        priority: result.priority,
        due_date: result.due_date,
        ai_state: 'done',
      })
      dispatch({ type: 'replaceEntry', id, entry: updated })
      const valid = result.related_ids.filter((rid) => rid !== id && stateRef.current.entries.some((x) => x.id === rid))
      await db.replaceLinks(id, valid, result.related_reason)
      dispatch({ type: 'links', links: (await db.listLinks()) || [] })
      toast('已重新分析', 'success')
    } catch (err) {
      toast(`重新分析失败：${describeError(err)}`, 'error', 6000)
    } finally {
      dispatch({ type: 'analyzing/remove', id })
    }
  }, [entryById])

  const saveRaw = useCallback<AppActions['saveRaw']>(async (id, text) => {
    if (!text) {
      toast('内容不能为空', 'warn')
      return
    }
    try {
      const updated = await db.updateEntry(id, { raw_text: text, ai_state: 'pending' })
      dispatch({ type: 'replaceEntry', id, entry: updated })
      dispatch({ type: 'editing', id: null })
      toast('已保存，正在重新分析…', 'success')
    } catch (err) {
      toast(describeError(err), 'error')
      return
    }
    await reanalyzeEntry(id)
  }, [reanalyzeEntry])

  /* ------------------------------------------------- AI：整理 / 问答 / 复盘 */

  const handleTidy = useCallback<AppActions['handleTidy']>(async () => {
    const { buckets } = todoBuckets()
    const todos = [...buckets.over, ...buckets.today, ...buckets.week, ...buckets.later, ...buckets.none]
    if (todos.length === 0) {
      toast('现在没有待办需要整理', 'warn')
      return
    }
    dispatch({ type: 'todoAdviceBusy', busy: true })
    dispatch({ type: 'todoAdvice', text: '' })
    try {
      const text = await ai.tidyTodos({
        todos: todos.map((t) => ({
          title: t.title || t.raw_text.slice(0, 40),
          due_date: t.due_date,
          priority: PRIORITY_META[t.priority]?.label,
        })),
        onDelta: (d) => dispatch({ type: 'todoAdvice', text: stateRef.current.todoAdvice + d }),
      })
      dispatch({ type: 'todoAdvice', text })
    } catch (err) {
      toast(`整理失败：${describeError(err)}`, 'error', 6000)
      dispatch({ type: 'todoAdvice', text: '' })
    } finally {
      dispatch({ type: 'todoAdviceBusy', busy: false })
    }
  }, [todoBuckets])

  const handleAsk = useCallback<AppActions['handleAsk']>(async (text) => {
    if (stateRef.current.ask.busy) return
    const question = String(text || '').trim()
    if (!question) return

    if (activeEntries().length === 0) {
      toast('还没有记录可以检索，先去收件箱记几条', 'warn')
      return
    }

    dispatch({
      type: 'ask/messages',
      messages: [
        ...stateRef.current.ask.messages,
        { role: 'user', content: question },
        { role: 'assistant', content: '' },
      ],
    })
    dispatch({ type: 'ask/busy', busy: true })
    // 问答使用局部 AbortController：停止时只中断这一次，不牵连同页其它请求
    const controller = new AbortController()
    askController.current = controller

    const history = stateRef.current.ask.messages.slice(-6).filter((m) => m.content)

    try {
      let contextEntries = activeEntries().slice(0, 120)
      try {
        const retrieved = await db.retrieveEntries({ query: question, limit: 40 })
        if (retrieved?.length) contextEntries = retrieved
      } catch (err) {
        // 检索层故障时仍可用最近记录回答；不要把检索故障升级成整次问答失败。
        console.warn('[retrieval] 检索失败，回退最近记录：', describeError(err))
      }

      await ai.answerQuestion({
        question,
        entries: contextEntries,
        history,
        signal: controller.signal,
        onDelta: (d) => dispatch({ type: 'ask/append', content: d }),
      })
      const settled = stateRef.current.ask.messages
      if (!settled[settled.length - 1]?.content) {
        dispatch({
          type: 'ask/messages',
          messages: settled.map((m, i) =>
            i === settled.length - 1 ? { ...m, content: '（没有生成内容，请重试）' } : m
          ),
        })
      }
    } catch (err) {
      const aborted = controller.signal.aborted || (err as Error)?.name === 'AbortError'
      const current = stateRef.current.ask.messages
      const msg = describeError(err)
      dispatch({
        type: 'ask/messages',
        messages: current.map((m, i) =>
          i === current.length - 1
            ? {
                ...m,
                content: aborted
                  ? m.content || '（已停止）'
                  : m.content
                    ? `${m.content}\n\n（生成中断：${msg}）`
                    : `抱歉，回答失败了：${msg}`,
              }
            : m
        ),
      })
      if (!aborted) toast(msg, 'error', 6000)
    } finally {
      dispatch({ type: 'ask/busy', busy: false })
      if (askController.current === controller) askController.current = null
    }
  }, [activeEntries])

  const stopAsk = useCallback(() => {
    askController.current?.abort()
  }, [])

  const handleReview = useCallback<AppActions['handleReview']>(async () => {
    const range = stateRef.current.reviewRange
    const { start, end, label } = rangeBounds(range)
    const scoped = entriesInRange(range, activeEntries())
    if (scoped.length === 0) {
      toast('这个区间还没有记录', 'warn')
      return
    }
    dispatch({ type: 'reviewBusy', busy: true })
    try {
      const periodLabel =
        range === 'all'
          ? `全部记录（截至 ${fmtDate(end.toISOString())}）`
          : `${label}（${fmtDate(start!.toISOString())} ~ ${fmtDate(end.toISOString())}）`

      const result = await ai.buildReview({ entries: scoped, label: periodLabel })
      const stats = computeStats(scoped)
      const created = await db.createReview({
        period_label: periodLabel,
        range_start: start ? fmtDate(start.toISOString()) : null,
        range_end: fmtDate(end.toISOString()),
        summary: result.summary,
        actions: result.actions,
        stats: { ...stats, themes: result.themes },
        entry_count: scoped.length,
      })
      dispatch({ type: 'reviews', reviews: [created, ...stateRef.current.reviews] })
      toast('复盘已生成并保存到云端', 'success')
    } catch (err) {
      toast(`生成失败：${describeError(err)}`, 'error', 6000)
    } finally {
      dispatch({ type: 'reviewBusy', busy: false })
    }
  }, [activeEntries])

  const removeReview = useCallback<AppActions['removeReview']>(async (id) => {
    try {
      await db.deleteReview(id)
      dispatch({ type: 'reviews', reviews: stateRef.current.reviews.filter((r) => r.id !== id) })
      toast('已删除', 'success')
    } catch (err) {
      toast(describeError(err), 'error')
    }
  }, [])

  /* --------------------------------------------------------- 启动与登出 */

  const goAuth = useCallback(() => {
    dispatch({ type: 'phase', phase: 'auth' })
  }, [])

  const enterApp = useCallback<AppActions['enterApp']>(
    async (session) => {
      dispatch({ type: 'phase', phase: 'app' })
      dispatch({ type: 'user', user: session.user })
      await Promise.all([loadSettingsFromCloud(), actionsRef.current?.refreshAll()])
    },
    [loadSettingsFromCloud]
  )

  const logout = useCallback<AppActions['logout']>(async () => {
    // 先把还没落盘的设置写上去，否则登出后请求会因会话失效而失败
    if (settingsSaveTimer.current) {
      clearTimeout(settingsSaveTimer.current)
      settingsSaveTimer.current = null
      await saveSettingsNow()
    }
    try {
      await auth.signOut()
    } catch {
      /* 退出失败也回到登录页 */
    }
    removeKey(SETTINGS_CACHE_KEY)
    dispatch({ type: 'resetSession' })
    useSettings(normalizeSettings(DEFAULT_SETTINGS), { persist: false })
  }, [saveSettingsNow, useSettings])

  /* ------------------------------------------------------------ 浮层管理 */

  const narrow = useCallback(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
    return window.matchMedia('(max-width: 860px)').matches
  }, [])

  const openSettings = useCallback(() => {
    if (stateRef.current.panelOpen) return
    dispatch({ type: 'nav', open: false })
    dispatch({ type: 'panel', open: true })
  }, [])

  const closeSettings = useCallback(() => {
    if (!stateRef.current.panelOpen) return
    dispatch({ type: 'panel', open: false })
    // 关闭时立即落盘，不等防抖
    if (settingsSaveTimer.current) {
      clearTimeout(settingsSaveTimer.current)
      saveSettingsNow()
    }
  }, [saveSettingsNow])

  const openEntry = useCallback<AppActions['openEntry']>((id) => {
    dispatch({ type: 'drawer', id })
    dispatch({ type: 'editing', id: null })
  }, [])

  const closeDrawer = useCallback(() => {
    dispatch({ type: 'drawer', id: null })
    dispatch({ type: 'editing', id: null })
  }, [])

  const startEdit = useCallback((id: number) => {
    dispatch({ type: 'editing', id })
  }, [])

  const cancelEdit = useCallback(() => {
    dispatch({ type: 'editing', id: null })
  }, [])

  const openNav = useCallback(() => {
    if (!narrow()) return
    dispatch({ type: 'panel', open: false })
    dispatch({ type: 'rail', open: false })
    dispatch({ type: 'drawer', id: null })
    dispatch({ type: 'nav', open: true })
  }, [narrow])

  const closeNav = useCallback<AppActions['closeNav']>(() => {
    dispatch({ type: 'nav', open: false })
  }, [])

  const openRail = useCallback(() => {
    if (!narrow()) return
    dispatch({ type: 'panel', open: false })
    dispatch({ type: 'nav', open: false })
    dispatch({ type: 'drawer', id: null })
    dispatch({ type: 'rail', open: true })
  }, [narrow])

  const closeRail = useCallback<AppActions['closeRail']>(() => {
    dispatch({ type: 'rail', open: false })
  }, [])

  /* -------------------------------------------------------- 视图与筛选 */

  const setView = useCallback((view: ViewName) => {
    dispatch({ type: 'view', view })
    if (narrow()) dispatch({ type: 'nav', open: false }) // 窄屏选完即收起抽屉
  }, [narrow])

  const setFilterKind = useCallback((kind: string) => {
    dispatch({ type: 'filter', patch: { kind } })
    void actionsRef.current?.refreshEntries()
  }, [])

  const setFilterScope = useCallback((scope: string) => {
    dispatch({ type: 'filter', patch: { scope } })
  }, [])

  const setReviewRange = useCallback((range: string) => {
    dispatch({ type: 'reviewRange', range })
  }, [])

  const setKeyword = useCallback((keyword: string) => {
    dispatch({ type: 'filter', patch: { keyword } })
    void actionsRef.current?.refreshEntries()
  }, [])

  const resetSettings = useCallback(() => {
    useSettings(normalizeSettings(DEFAULT_SETTINGS))
    dispatch({ type: 'settingsStatus', text: '正在保存…' })
    if (settingsSaveTimer.current) clearTimeout(settingsSaveTimer.current)
    settingsSaveTimer.current = setTimeout(saveSettingsNow, 700)
  }, [saveSettingsNow, useSettings])

  const clearAsk = useCallback(() => {
    dispatch({ type: 'ask/messages', messages: [] })
  }, [])

  // 供 enterApp / setFilterKind 等在定义前引用的动作
  const actionsRef = useRef<AppActions | null>(null)

  const actions = useMemo<AppActions>(
    () => ({
      enterApp,
      logout,
      goAuth,
      refreshAll,
      refreshEntries,
      setView,
      setFilterKind,
      setFilterScope,
      setReviewRange,
      setKeyword,
      saveEntryAndAnalyze,
      handleMdFiles,
      toggleEntry,
      removeEntry,
      undoDelete,
      reanalyzeEntry,
      saveRaw,
      handleTidy,
      handleAsk,
      stopAsk,
      clearAsk,
      handleReview,
      removeReview,
      onSettingsChange,
      resetSettings,
      saveSettingsNow,
      openSettings,
      closeSettings,
      openEntry,
      closeDrawer,
      startEdit,
      cancelEdit,
      openNav,
      closeNav,
      openRail,
      closeRail,
    }),
    [
      enterApp, logout, goAuth, refreshAll, refreshEntries, setView, setFilterKind, setFilterScope,
      setReviewRange, setKeyword, saveEntryAndAnalyze, handleMdFiles, toggleEntry, removeEntry,
      undoDelete, reanalyzeEntry, saveRaw, handleTidy, handleAsk, stopAsk, clearAsk, handleReview,
      removeReview, onSettingsChange, resetSettings, saveSettingsNow, openSettings, closeSettings, openEntry,
      closeDrawer, startEdit, cancelEdit, openNav, closeNav, openRail, closeRail,
    ]
  )
  actionsRef.current = actions

  const derived = useMemo(
    () => ({ activeEntries, visibleEntries, linksOf, todoBuckets, entryById }),
    [activeEntries, entryById, linksOf, todoBuckets, visibleEntries]
  )

  const value = useMemo<Store>(() => ({ state, actions, appRef, narrow, derived }), [state, actions, narrow, derived])

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
}

/* ------------------------------------------------------------ 纯函数工具 */

export function rangeBounds(range: string): { start: Date | null; end: Date; label: string } {
  const end = new Date()
  if (range === 'all') return { start: null, end, label: '全部记录' }
  const days = Number(range)
  const start = new Date(end.getTime() - (days - 1) * 86400000)
  return { start, end, label: `最近 ${days} 天` }
}

export function entriesInRange(range: string, list: Entry[]): Entry[] {
  const { start, end } = rangeBounds(range)
  if (!start) return list
  const s = start.getTime()
  const e = end.getTime() + 86399999
  return list.filter((x) => {
    const t = new Date(x.created_at).getTime()
    return t >= s && t <= e
  })
}

export function computeStats(list: Entry[]) {
  const byKind: Record<string, number> = { idea: 0, material: 0, todo: 0, note: 0 }
  let done = 0
  let pending = 0
  for (const e of list) {
    const k = e.kind || 'note'
    byKind[k] = (byKind[k] || 0) + 1
    if (e.status === 'done') done++
    if (e.kind === 'todo' && e.status !== 'done') pending++
  }
  return { total: list.length, byKind, done, pending }
}
