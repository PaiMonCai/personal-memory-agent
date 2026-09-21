/**
 * 信息管家 · 应用主逻辑
 *
 * 视图：收件箱 / 待办 / 问答 / 复盘
 * 数据：全部走云服务（认证 + 数据库 + 免密钥大模型）
 */
// 版本参数必须与 index.html 中的引用一致，且同一模块在所有文件中写法必须完全相同，
// 否则 ES module 会被当成两个不同模块加载（cloud.js 会出现两个 SDK 客户端实例）。
import { PUBLIC_CONFIG } from './config.js?v=20260922q'
import * as db from './cloud.js?v=20260922q'
import { describeError } from './cloud.js?v=20260922q'
import * as ai from './ai.js?v=20260922q'
import {
  escapeHtml,
  kindMeta,
  STATUS_META,
  PRIORITY_META,
  fmtDateTime,
  fmtDate,
  timeAgo,
  dueHint,
  renderRichText,
  highlight,
  toast,
  confirmDialog,
  debounce,
} from './ui.js?v=20260922q'
import {
  applySettings,
  mountSettingsPanel,
  normalizeSettings,
  DEFAULT_SETTINGS,
} from './settings.js?v=20260922q'
import { initEffects, setEffect } from './effects.js?v=20260922q'

/* ==================================================================== 状态 */

const state = {
  session: null,
  user: null,
  entries: [],
  searchResults: [],
  links: [],
  reviews: [],
  filter: { kind: 'all', scope: 'open', keyword: '' },
  view: 'inbox',
  ask: { messages: [], busy: false, controller: null },
  todoAdvice: '',
  todoAdviceBusy: false,
  reviewBusy: false,
  reviewRange: '7',
  loading: true,
  analyzing: new Set(),
  settings: normalizeSettings(DEFAULT_SETTINGS),
}

const $ = (sel) => document.querySelector(sel)

/* ==================================================================== 启动 */

async function ensureSdk() {
  for (let i = 0; i < 50; i++) {
    if (window.WorkBuddyCloud && typeof window.WorkBuddyCloud.createWorkBuddyCloud === 'function') return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('云服务 SDK 加载失败，请检查网络后刷新页面')
}

async function boot() {
  try {
    await ensureSdk()
  } catch (err) {
    $('#boot').innerHTML = `<div class="boot-inner"><div class="boot-logo">⚠️</div><div class="boot-text">${escapeHtml(
      err.message
    )}</div></div>`
    return
  }

  try {
    const session = await db.getSession()
    if (session) {
      await enterApp(session)
    } else {
      showAuth()
    }
  } catch (err) {
    console.error(err)
    showAuth()
    showAuthError(describeError(err))
  }
}

function showAuth() {
  $('#boot').classList.add('hidden')
  $('#app-view').classList.add('hidden')
  $('#auth-view').classList.remove('hidden')
  renderOriginWarning()
}

async function enterApp(session) {
  state.session = session
  state.user = session?.user || session
  $('#boot').classList.add('hidden')
  $('#auth-view').classList.add('hidden')
  $('#app-view').classList.remove('hidden')
  $('#user-chip').textContent = state.user?.email || '已登录'
  $('#user-chip').title = state.user?.email || ''
  await Promise.all([loadSettingsFromCloud(), refreshAll()])
}

/* ================================================================== 认证层 */

/* ------------------------------------------------------------ 域名守卫 */

/**
 * 登录与云数据只在应用注册的发布域上可用：服务端按 Origin 精确校验，
 * localhost、内置预览域以及其它域名一律被拒。
 * 这里提前拦住并给出可执行的提示，而不是让用户只看到笼统的"网络不可用"。
 */
function isOfficialOrigin() {
  try {
    const target = new URL(PUBLIC_CONFIG.endpoint)
    return location.protocol === 'https:' && location.host === target.host
  } catch {
    return false
  }
}

function renderOriginWarning() {
  const box = $('#origin-warning')
  if (!box) return
  if (isOfficialOrigin()) {
    box.classList.add('hidden')
    box.innerHTML = ''
    return
  }
  box.innerHTML = `<strong>⚠️ 当前不是正式访问域名</strong>
    你打开的是 <code>${escapeHtml(location.host || location.href)}</code>，
    而登录与云数据只在 <code>${escapeHtml(PUBLIC_CONFIG.endpoint)}</code> 上生效。
    请改用正式链接打开本应用后再登录。`
  box.classList.remove('hidden')
}

function guardOfficialOrigin() {
  if (isOfficialOrigin()) return true
  showAuthError(`登录与云数据只在正式域名 ${PUBLIC_CONFIG.endpoint}/ 上可用，请改用该链接打开本应用。`)
  return false
}

function showAuthError(msg) {
  const box = $('#auth-error')
  if (!msg) {
    box.classList.add('hidden')
    box.textContent = ''
    return
  }
  box.textContent = msg
  box.classList.remove('hidden')
}

function setAuthTab(name) {
  document.querySelectorAll('[data-auth-tab]').forEach((b) => {
    b.classList.toggle('active', b.dataset.authTab === name)
  })
  document.querySelectorAll('[data-auth-panel]').forEach((p) => {
    p.classList.toggle('hidden', p.dataset.authPanel !== name)
  })
  showAuthError('')
}

function setLoginMode(mode) {
  document.querySelectorAll('[data-login-mode]').forEach((b) => {
    b.classList.toggle('active', b.dataset.loginMode === mode)
  })
  $('#form-login-password').classList.toggle('hidden', mode !== 'password')
  $('#form-login-otp').classList.toggle('hidden', mode !== 'otp')
  showAuthError('')
}

function withLoading(btn, label, fn) {
  const original = btn.textContent
  btn.disabled = true
  btn.textContent = label
  return fn().finally(() => {
    btn.disabled = false
    btn.textContent = original
  })
}

/**
 * 验证码挑战缓存。
 *
 * 界面是"两步式"（先点发送、用户去收信、再填码提交），因此**必须**把发送时拿到的
 * 挑战对象缓存下来供提交时复用。若在提交时再调一次发送接口，会让上一封验证码立即失效，
 * 用户永远填不对 —— 这正是之前的缺陷。
 */
const otpChallenges = {
  'login-otp': { email: '', payload: null },
  signup: { email: '', payload: null },
  reset: { email: '', payload: null },
}

/** 三个表单各自走不同的发送通道，返回的挑战对象形态也不同 */
async function sendVerificationCode(scope, email) {
  if (scope === 'login-otp') {
    const res = await db.auth.signInWithOtp(email)
    if (res.error) throw res.error
    return { kind: 'signin', data: res.data } // data.verify({ token })
  }
  if (scope === 'signup') {
    const res = await db.auth.sendOtp(email)
    if (res.error) throw res.error
    return { kind: 'otp', data: res.data } // data.verificationId / data.isExistingUser
  }
  const res = await db.auth.resetPasswordForEmail(email)
  if (res.error) throw res.error
  return { kind: 'recovery', data: res.data } // data.updateUser({ nonce, password })
}

/** 取出缓存中的挑战；邮箱变了或没发送过就返回 null */
function takeChallenge(scope, email) {
  const c = otpChallenges[scope]
  if (!c || !c.payload || c.email !== email) return null
  return c.payload
}

function clearChallenge(scope) {
  otpChallenges[scope] = { email: '', payload: null }
}

/** 发送后进入冷却，避免连点导致验证码反复失效 */
function startCooldown(btn, seconds = 60) {
  const original = '发送验证码'
  let left = seconds
  btn.dataset.cooling = '1'
  btn.disabled = true
  btn.textContent = `${left}s 后可重发`
  const timer = setInterval(() => {
    left -= 1
    if (left <= 0) {
      clearInterval(timer)
      btn.dataset.cooling = '0'
      btn.disabled = false
      btn.textContent = original
      return
    }
    btn.textContent = `${left}s 后可重发`
  }, 1000)
}

function bindAuth() {
  document.querySelectorAll('[data-auth-tab]').forEach((btn) => {
    btn.addEventListener('click', () => setAuthTab(btn.dataset.authTab))
  })
  document.querySelectorAll('[data-login-mode]').forEach((btn) => {
    btn.addEventListener('click', () => setLoginMode(btn.dataset.loginMode))
  })
  document.querySelectorAll('[data-goto]').forEach((btn) => {
    btn.addEventListener('click', () => setAuthTab(btn.dataset.goto))
  })

  // 发送验证码：按表单用途走各自的发送通道，并缓存返回值供提交时复用
  document.querySelectorAll('[data-send-otp]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (btn.dataset.cooling === '1') return
      const scope = btn.dataset.sendOtp
      const form = btn.closest('form')
      const email = form.querySelector('input[name="email"]').value.trim()
      if (!email) return showAuthError('请先填写邮箱')
      showAuthError('')
      if (!guardOfficialOrigin()) return
      let sent = false
      await withLoading(btn, '发送中…', async () => {
        try {
          otpChallenges[scope] = { email, payload: await sendVerificationCode(scope, email) }
          toast('验证码已发送，请查收邮箱', 'success')
          sent = true
        } catch (err) {
          showAuthError(describeError(err))
        }
      })
      if (sent) startCooldown(btn)
    })
  })

  // 密码登录
  $('#form-login-password').addEventListener('submit', async (e) => {
    e.preventDefault()
    const form = e.target
    const btn = form.querySelector('button[type="submit"]')
    const email = form.email.value.trim()
    const password = form.password.value
    showAuthError('')
    if (!guardOfficialOrigin()) return
    await withLoading(btn, '登录中…', async () => {
      try {
        const { error } = await db.auth.signInWithPassword(email, password)
        if (error) throw error
        const session = await db.getSession()
        if (!session) throw new Error('登录未成功，请重试')
        await enterApp(session)
      } catch (err) {
        const code = err?.error?.code || err?.code
        showAuthError(code === 'invalid_grant' || code === 'unauthenticated' ? '邮箱或密码不正确' : describeError(err))
      }
    })
  })

  // 验证码登录
  $('#form-login-otp').addEventListener('submit', async (e) => {
    e.preventDefault()
    const form = e.target
    const btn = form.querySelector('button[type="submit"]')
    const email = form.email.value.trim()
    const token = form.code.value.trim()
    showAuthError('')
    if (!guardOfficialOrigin()) return
    const challenge = takeChallenge('login-otp', email)
    if (!challenge) return showAuthError('请先点「发送验证码」获取邮箱验证码，再填入下方')
    await withLoading(btn, '登录中…', async () => {
      try {
        const completed = await challenge.data.verify({ token })
        if (completed.error) throw completed.error
        clearChallenge('login-otp')
        const session = await db.getSession()
        if (!session) throw new Error('登录未成功，请重试')
        await enterApp(session)
      } catch (err) {
        showAuthError(describeError(err))
      }
    })
  })

  // 注册（先验证邮箱，再带着密码完成注册）
  $('#form-signup').addEventListener('submit', async (e) => {
    e.preventDefault()
    const form = e.target
    const btn = form.querySelector('button[type="submit"]')
    const email = form.email.value.trim()
    const token = form.code.value.trim()
    const password = form.password.value
    showAuthError('')
    if (!guardOfficialOrigin()) return
    const challenge = takeChallenge('signup', email)
    if (!challenge) return showAuthError('请先点「发送验证码」获取邮箱验证码，再填入下方')
    await withLoading(btn, '注册中…', async () => {
      try {
        const d = challenge.data
        const completed = await db.auth.verifyOtp({
          verificationId: d.verificationId,
          token,
          email,
          isExistingUser: d.isExistingUser,
          password: d.isExistingUser ? undefined : password,
        })
        if (completed.error) throw completed.error
        if (d.isExistingUser) {
          // 两个登录表单都把邮箱带上，用户不必重输
          const pwForm = $('#form-login-password')
          const otpForm = $('#form-login-otp')
          if (pwForm) pwForm.email.value = email
          if (otpForm) otpForm.email.value = email
          setAuthTab('login')
          showAuthError('该邮箱已注册，请直接登录')
          return
        }
        clearChallenge('signup')
        const session = await db.getSession()
        if (!session) throw new Error('注册未完成，请重试')
        await enterApp(session)
      } catch (err) {
        showAuthError(describeError(err))
      }
    })
  })

  // 重置密码
  $('#form-reset').addEventListener('submit', async (e) => {
    e.preventDefault()
    const form = e.target
    const btn = form.querySelector('button[type="submit"]')
    const email = form.email.value.trim()
    const nonce = form.code.value.trim()
    const password = form.password.value
    showAuthError('')
    if (!guardOfficialOrigin()) return
    const challenge = takeChallenge('reset', email)
    if (!challenge) return showAuthError('请先点「发送验证码」获取密码重置验证码，再填入下方')
    await withLoading(btn, '处理中…', async () => {
      try {
        const completed = await challenge.data.updateUser({ nonce, password })
        if (completed.error) throw completed.error
        clearChallenge('reset')
        const session = await db.getSession()
        if (!session) throw new Error('密码已重置，请重新登录')
        await enterApp(session)
      } catch (err) {
        showAuthError(describeError(err))
      }
    })
  })
}

/* ============================================================== 个性设置 */

const SETTINGS_CACHE_KEY = 'pma.settings.cache'
let settingsPanelCtl = null
let settingsSaveTimer = null

/**
 * 本地只做一份缓存，让登录页也能沿用上次的配色；云端仍是权威来源。
 * 这里刻意把自定义模型的密钥剔掉：这份缓存只是为了登录页不闪一下默认配色，
 * 没必要把密钥再往浏览器里存一份（云端那份是你自己选的同步方式）。
 */
function cacheSettings(s) {
  try {
    const safe = s.ai ? { ...s, ai: { ...s.ai, custom: { ...s.ai.custom, apiKey: '' } } } : s
    localStorage.setItem(SETTINGS_CACHE_KEY, JSON.stringify(safe))
  } catch {
    /* 隐私模式下写入失败，忽略 */
  }
}

function readCachedSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_CACHE_KEY)
    return raw ? normalizeSettings(JSON.parse(raw)) : normalizeSettings(DEFAULT_SETTINGS)
  } catch {
    return normalizeSettings(DEFAULT_SETTINGS)
  }
}

function clearCachedSettings() {
  try {
    localStorage.removeItem(SETTINGS_CACHE_KEY)
  } catch {
    /* 同上 */
  }
}

/** 把设置同时作用到界面变量、动效层与 AI 调用层 */
function useSettings(s, { persist = true } = {}) {
  state.settings = s
  applySettings(s)
  setEffect(s.effect)
  ai.useAiSettings(s.ai) // AI 层不反向依赖设置模块，由这里推入当前配置
  if (persist) cacheSettings(s)
}

/** 登录后以云端偏好为准；没有记录就沿用默认值 */
async function loadSettingsFromCloud() {
  try {
    const row = await db.getPreferences()
    if (row && (row.theme || row.effect || row.ai)) {
      useSettings(normalizeSettings(row))
      return
    }
  } catch (err) {
    console.warn('[settings] 读取云端设置失败，沿用本地缓存：', describeError(err))
    return
  }
  useSettings(normalizeSettings(DEFAULT_SETTINGS))
}

async function saveSettingsNow() {
  settingsSaveTimer = null
  try {
    await db.savePreferences({
      theme: state.settings.theme,
      effect: state.settings.effect,
      ai: state.settings.ai,
    })
    settingsPanelCtl?.setStatus('已保存到云端')
  } catch (err) {
    const msg = describeError(err)
    settingsPanelCtl?.setStatus(`保存失败：${msg}`)
    toast(`设置未保存到云端：${msg}`, 'error', 5000)
  }
}

function onSettingsChange(next) {
  useSettings(next)
  settingsPanelCtl?.setStatus('正在保存…')
  if (settingsSaveTimer) clearTimeout(settingsSaveTimer)
  settingsSaveTimer = setTimeout(saveSettingsNow, 700)
}

function openSettings() {
  const host = $('#settings-panel')
  if (!host || !host.classList.contains('hidden')) return
  closeNav()
  settingsPanelCtl = mountSettingsPanel(host, state.settings, onSettingsChange, {
    // 模型目录由云服务提供；设置模块不直接依赖 cloud.js，这里注入进去
    loadModels: () => db.listModels(),
  })
  host.classList.remove('hidden')
  $('#settings-mask').classList.remove('hidden')
  lockScroll('settings')
  refreshInert()
  const first = host.querySelector('button, input')
  if (first) setTimeout(() => first.focus(), 70)
}

function closeSettings() {
  const host = $('#settings-panel')
  if (!host || host.classList.contains('hidden')) return
  host.classList.add('hidden')
  host.innerHTML = ''
  $('#settings-mask').classList.add('hidden')
  settingsPanelCtl = null
  unlockScroll('settings')
  refreshInert()
  // 关闭时立即落盘，不等防抖
  if (settingsSaveTimer) {
    clearTimeout(settingsSaveTimer)
    saveSettingsNow()
  }
  const trigger = $('#btn-settings')
  if (trigger && !document.body.classList.contains('nav-open')) trigger.focus()
}

/* ============================================================== 浮层管理 */

/** 背景滚动锁用计数式 key，避免抽屉与设置面板互相解锁 */
const scrollLocks = new Set()

function lockScroll(key) {
  scrollLocks.add(key)
  document.body.classList.add('has-overlay')
}

function unlockScroll(key) {
  scrollLocks.delete(key)
  if (scrollLocks.size === 0) document.body.classList.remove('has-overlay')
}

const narrowQuery = window.matchMedia('(max-width: 860px)')

/** 左菜单栏与右随手记在窄屏下都会变成抽屉，用一个遮罩统一服务 */
function syncScrim() {
  const anyOpen =
    document.body.classList.contains('nav-open') || document.body.classList.contains('rail-open')
  $('#sidebar-scrim').hidden = !anyOpen
}

/** 浮层打开时把背后内容置为 inert：Tab 跑不出去，也点不到 */
function refreshInert() {
  const app = $('#app-view')
  const main = document.querySelector('.app-main')
  if (!app || !main) return
  const overlayOpen =
    !$('#drawer').classList.contains('hidden') || !$('#settings-panel').classList.contains('hidden')
  const navOpen = document.body.classList.contains('nav-open')
  const railOpen = document.body.classList.contains('rail-open')

  app.inert = overlayOpen
  main.inert = !app.inert && (navOpen || railOpen)
  // 两个抽屉互不相干，打开一个时把另一个也隔离掉
  const sidebar = $('#sidebar')
  const rail = $('#compose-rail')
  if (sidebar) sidebar.inert = !app.inert && railOpen && narrowQuery.matches
  if (rail) rail.inert = !app.inert && navOpen && narrowQuery.matches
}

/** 窄屏：左侧菜单栏抽屉 */
function openNav() {
  if (!narrowQuery.matches) return
  if (!$('#settings-panel').classList.contains('hidden')) closeSettings()
  closeRail({ restoreFocus: false })
  closeDrawer({ restoreFocus: false })
  document.body.classList.add('nav-open')
  syncScrim()
  $('#nav-toggle').setAttribute('aria-expanded', 'true')
  lockScroll('nav')
  refreshInert()
  const first = document.querySelector('#sidebar .side-tab')
  if (first) setTimeout(() => first.focus(), 70)
}

function closeNav({ restoreFocus = false } = {}) {
  if (!document.body.classList.contains('nav-open')) return
  document.body.classList.remove('nav-open')
  syncScrim()
  $('#nav-toggle').setAttribute('aria-expanded', 'false')
  unlockScroll('nav')
  refreshInert()
  if (restoreFocus && narrowQuery.matches) $('#nav-toggle').focus()
}

/** 窄屏：右侧随手记抽屉。宽屏下它本来就常驻，只需聚焦 */
function openRail() {
  if (!narrowQuery.matches) return focusCapture()
  if (!$('#settings-panel').classList.contains('hidden')) closeSettings()
  closeNav({ restoreFocus: false })
  closeDrawer({ restoreFocus: false })
  document.body.classList.add('rail-open')
  syncScrim()
  $('#rail-toggle').setAttribute('aria-expanded', 'true')
  lockScroll('rail')
  refreshInert()
  setTimeout(() => $('#capture-input').focus(), 330)
}

function closeRail({ restoreFocus = false } = {}) {
  if (!document.body.classList.contains('rail-open')) return
  document.body.classList.remove('rail-open')
  syncScrim()
  $('#rail-toggle').setAttribute('aria-expanded', 'false')
  unlockScroll('rail')
  refreshInert()
  if (restoreFocus && narrowQuery.matches) $('#rail-toggle').focus()
}

narrowQuery.addEventListener('change', (e) => {
  if (!e.matches) {
    closeNav()
    closeRail()
  }
})

/** 聚焦随手记：窄屏下把右栏抽屉拉出来（openRail 内部会聚焦） */
function focusCapture() {
  const input = $('#capture-input')
  if (!input) return
  if (narrowQuery.matches && !document.body.classList.contains('rail-open')) return openRail()
  input.focus()
  try {
    input.setSelectionRange(input.value.length, input.value.length)
  } catch {
    /* 某些输入类型不支持选区，忽略 */
  }
}

/* ================================================================ 数据层 */

async function refreshAll() {
  state.loading = true
  renderView()
  try {
    const [entries, links, reviews] = await Promise.all([
      db.listEntries(),
      db.listLinks(),
      db.listReviews(),
    ])
    state.entries = entries || []
    state.links = links || []
    state.reviews = reviews || []
  } catch (err) {
    toast(describeError(err), 'error', 5000)
  } finally {
    state.loading = false
    renderView()
  }
}

/** 关键词检索走后端函数，其余筛选在前端完成。
 *  检索结果单独存放，避免把问答 / 复盘 / 待办依赖的全量数据挤掉。 */
async function refreshEntries() {
  const { keyword } = state.filter
  if (!keyword) {
    state.searchResults = []
    try {
      state.entries = (await db.listEntries()) || []
    } catch (err) {
      toast(describeError(err), 'error')
    }
    renderView()
    return
  }
  try {
    state.searchResults = (await db.searchEntries({ keyword })) || []
  } catch (err) {
    state.searchResults = []
    toast(describeError(err), 'error')
  }
  renderView()
}

/**
 * 待删除队列：删除先从界面移除并给 6 秒撤销窗口，到点才真正落库。
 * 好处是误删可挽回，且不必让用户对着确认框做决定。
 */
const pendingDeletes = new Map() // id -> { timer }
const UNDO_MS = 6000

function withoutPending(list) {
  if (pendingDeletes.size === 0) return list
  return list.filter((e) => !pendingDeletes.has(e.id))
}

function activeEntries() {
  return withoutPending(state.entries)
}

/** 当前列表应当展示的数据源 */
function sourceEntries() {
  return state.filter.keyword ? withoutPending(state.searchResults) : activeEntries()
}

/** 本地更新一条记录（两个数据源都要同步） */
function setEntry(updated) {
  state.entries = state.entries.map((e) => (e.id === updated.id ? updated : e))
  state.searchResults = state.searchResults.map((e) => (e.id === updated.id ? updated : e))
}

/** 过滤后的可见条目 */
function visibleEntries() {
  const { kind, scope } = state.filter
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
}

function linksOf(id) {
  const out = []
  for (const l of state.links) {
    if (l.source_id === id) out.push({ id: l.target_id, reason: l.reason })
    else if (l.target_id === id) out.push({ id: l.source_id, reason: l.reason })
  }
  const seen = new Set()
  return out.filter((x) => {
    if (seen.has(x.id)) return false
    seen.add(x.id)
    return true
  })
}

function entryById(id) {
  return state.entries.find((e) => e.id === id)
}

/* ================================================================ 视图层 */

let lastRenderedView = null
const reduceMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')

function renderView() {
  // 只在「切换视图」时播入场过渡，数据刷新不重放，避免频繁闪烁
  const switched = lastRenderedView !== state.view
  lastRenderedView = state.view
  // 换了页面就忘掉旧的指示器几何，否则它会长途滑过来
  if (switched) resetFilterInk()

  // 让辅助技术知道主区正在载入
  const mainEl = $('#main-content')
  if (mainEl) mainEl.setAttribute('aria-busy', state.loading ? 'true' : 'false')

  document.querySelectorAll('#tabs [data-view]').forEach((t) => {
    const on = t.dataset.view === state.view
    t.classList.toggle('active', on)
    if (on) t.setAttribute('aria-current', 'page')
    else t.removeAttribute('aria-current')
  })

  for (const name of ['inbox', 'todo', 'ask', 'review']) {
    const el = $(`#view-${name}`)
    if (!el) continue
    const on = name === state.view
    el.classList.toggle('hidden', !on)
    if (on && switched && !reduceMotionQuery.matches && typeof el.animate === 'function') {
      el.animate(
        [
          { opacity: 0, transform: 'translateY(6px)' },
          { opacity: 1, transform: 'none' },
        ],
        { duration: 200, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }
      )
    }
  }

  if (state.view === 'inbox') renderInbox()
  if (state.view === 'todo') renderTodo()
  if (state.view === 'ask') renderAsk()
  if (state.view === 'review') renderReview()
}

/* ------------------------------------------------------------ 收件箱 */

function entryCardHtml(e) {
  const km = kindMeta(e.kind)
  const st = STATUS_META[e.status] || STATUS_META.inbox
  const done = e.status === 'done'
  const kw = state.filter.keyword
  const links = linksOf(e.id)
  const due = dueHint(e.due_date)
  const analyzing = e.ai_state === 'pending' || state.analyzing.has(e.id)

  const title = e.title || e.raw_text.slice(0, 40)
  const badges = [`<span class="badge ${km.cls}">${km.icon} ${km.label}</span>`]
  if (done) badges.push('<span class="badge badge-done">已完成</span>')
  if (e.priority === 'high' && !done) badges.push('<span class="badge badge-over">高优先</span>')
  if (due && !done) badges.push(`<span class="badge ${due.level === 'over' ? 'badge-over' : 'badge-due'}">${escapeHtml(due.text)}</span>`)
  if (analyzing) badges.push('<span class="badge badge-ai">AI 分析中</span>')
  if (e.ai_state === 'failed') badges.push('<span class="badge badge-over">分析失败</span>')

  const tags = (e.tags || []).slice(0, 4).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')
  const side = []
  if (links.length) side.push(`<div class="entry-links">🔗 ${links.length}</div>`)

  return `
    <article class="entry ${km.cls} ${done ? 'done' : ''}" data-act="open-entry" data-id="${e.id}">
      <button class="entry-check ${done ? 'on' : ''}" data-act="toggle-entry" data-id="${e.id}" title="${
        done ? '标记为未完成' : '标记完成'
      }">✓</button>
      <div class="entry-main">
        <div class="entry-top">
          <span class="entry-title">${highlight(title, kw)}</span>
          ${badges.join('')}
        </div>
        ${e.summary ? `<div class="entry-summary">${highlight(e.summary, kw)}</div>` : ''}
        ${
          e.summary
            ? ''
            : `<div class="entry-raw">${highlight(e.raw_text.slice(0, 140), kw)}${
                e.raw_text.length > 140 ? '…' : ''
              }</div>`
        }
        <div class="entry-meta">
          <span>${timeAgo(e.created_at)}</span>
          <span>${st.label}</span>
          ${e.action_items?.length ? `<span>${e.action_items.length} 项行动</span>` : ''}
          ${tags ? `<span class="entry-tags">${tags}</span>` : ''}
        </div>
      </div>
      <div class="entry-side">${side.join('')}</div>
    </article>`
}

/* ------------------------------------------- 悬浮方块的上下拖动与磁吸 */

/**
 * 两侧悬浮栏可以上下拖。位置记在 localStorage —— 它是"这台机器、这个窗口"的偏好，
 * 没必要占云端设置的结构。
 * 松手后吸附到最近的档位（顶 / 居中 / 底），所以不会停在不上不下的位置。
 */
const FLOAT_POS_KEY = 'pma.floatPos'

function readFloatPos() {
  try {
    return JSON.parse(localStorage.getItem(FLOAT_POS_KEY)) || {}
  } catch {
    return {}
  }
}

function writeFloatPos(key, top) {
  try {
    const all = readFloatPos()
    all[key] = Math.round(top)
    localStorage.setItem(FLOAT_POS_KEY, JSON.stringify(all))
  } catch {
    /* 隐私模式下写不了就算了，不影响使用 */
  }
}

function floatGap() {
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--float-gap'))
  return Number.isFinite(v) ? v : 16
}

/**
 * 可写范围。
 *
 * 关键：两栏是 `top:50%` + `transform:translateY(-50%)` 定位的，所以 style.top 这个值
 * 是**方块的视觉中心点**，不是顶边。按顶边来算会让"贴顶"把上半截顶出视口、
 * "贴底"在下方多空出半个方块的高度 —— 两种错法方向相反，且只有方块高到一定尺寸才看得出来。
 */
function topRange(el) {
  const g = floatGap()
  const half = el.offsetHeight / 2
  const min = g + half
  const max = Math.max(min, window.innerHeight - g - half)
  return { min, max }
}

function clampTop(el, top) {
  const { min, max } = topRange(el)
  return Math.min(Math.max(top, min), max)
}

/** 三档吸附位：贴顶、垂直居中、贴底（都是中心点坐标） */
function floatSlots(el) {
  const { min, max } = topRange(el)
  const mid = Math.round(window.innerHeight / 2)
  return [Math.round(min), mid, Math.round(max)].filter((v, i, a) => a.indexOf(v) === i)
}

function setFloatTop(el, top, key) {
  const next = clampTop(el, top)
  el.style.top = `${next}px`
  if (key) writeFloatPos(key, next)
  return next
}

function bindFloatDrag() {
  const grips = document.querySelectorAll('[data-grip]')
  grips.forEach((grip) => {
    const panel = grip.closest('.sidebar, .compose-rail')
    if (!panel) return
    const key = grip.dataset.grip

    const saved = readFloatPos()[key]
    if (typeof saved === 'number') setFloatTop(panel, saved)

    let dragging = false
    let moved = false
    let startY = 0
    let startTop = 0

    const onDown = (e) => {
      if (narrowQuery.matches) return // 窄屏是抽屉，没有上下余地
      if (e.button != null && e.button !== 0) return
      dragging = true
      moved = false
      startY = e.clientY
      // 起点必须取中心点（与 style.top 同语义），取 rect.top 会在按下的瞬间跳半个方块
      const px = parseFloat(panel.style.top)
      startTop = Number.isFinite(px) ? px : panel.getBoundingClientRect().top + panel.offsetHeight / 2
      panel.classList.add('dragging')
      try {
        grip.setPointerCapture(e.pointerId)
      } catch {
        /* 老浏览器没有 pointer capture 也能用，只是指针移出会断 */
      }
    }

    const onMove = (e) => {
      if (!dragging) return
      const dy = e.clientY - startY
      // 3px 抖动阈值：不然单击手柄也会被当成一次（零位移的）拖动
      if (!moved && Math.abs(dy) < 3) return
      moved = true
      e.preventDefault()
      panel.style.top = `${clampTop(panel, startTop + dy)}px`
    }

    const onUp = () => {
      if (!dragging) return
      dragging = false
      panel.classList.remove('dragging')
      if (!moved) return
      // 用自己写的 top 而不是 rect：拖动过程中我们一直在写 style.top，它才是当前位置
      const cur = parseFloat(panel.style.top)
      const here = Number.isFinite(cur) ? cur : panel.getBoundingClientRect().top
      let best = floatSlots(panel)[0]
      for (const s of floatSlots(panel)) {
        if (Math.abs(s - here) < Math.abs(best - here)) best = s
      }
      setFloatTop(panel, best, key)
    }

    grip.addEventListener('pointerdown', onDown)
    grip.addEventListener('pointermove', onMove)
    grip.addEventListener('pointerup', onUp)
    grip.addEventListener('pointercancel', onUp)
    grip.addEventListener('lostpointercapture', onUp)

    // 键盘可达：↑ ↓ 微调（按住 Shift 大步），Home 回正中
    grip.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown' && e.key !== 'Home') return
      e.preventDefault()
      const step = e.shiftKey ? 48 : 12
      if (e.key === 'Home') {
        setFloatTop(panel, window.innerHeight / 2, key) // 中心点语义：视口中线
        return
      }
      const from = parseFloat(panel.style.top)
      const base = Number.isFinite(from)
        ? from
        : panel.getBoundingClientRect().top + panel.offsetHeight / 2
      setFloatTop(panel, base + (e.key === 'ArrowUp' ? -step : step), key)
    })
  })

  // 窗口变矮后，原来贴底的位置可能掉出视口，重新钳一下
  window.addEventListener('resize', () => {
    grips.forEach((grip) => {
      const panel = grip.closest('.sidebar, .compose-rail')
      if (!panel || !panel.style.top) return
      setFloatTop(panel, parseFloat(panel.style.top), grip.dataset.grip)
    })
  })
}

/* ------------------------------------------------- 筛选栏的滑动下划线 */

/**
 * 筛选行是整块 innerHTML 重写的，所以指示器每次都是新元素。
 * 想让"下划线滑过去"成立，就必须记住上一次的几何：渲染后先把新指示器放回旧位置，
 * 强制重排让浏览器认下这个起点，再过渡到目标位置。
 * 只让每个 chip 自己展开下划线的话，视觉上是"旧的消失 + 新的出现"两段割裂动画 —— 就是僵硬感的来源。
 */
const filterInk = { kind: null, scope: null, range: null }

function placeFilterInk(group, selector, animate) {
  const row = $(selector)
  const ink = row && row.querySelector('.filter-ink')
  const active = row && row.querySelector('.chip.active')
  if (!ink || !active) {
    filterInk[group] = null
    return
  }
  const rowRect = row.getBoundingClientRect()
  const chipRect = active.getBoundingClientRect()
  const to = {
    x: chipRect.left - rowRect.left,
    y: chipRect.bottom - rowRect.top - 1.5,
    w: chipRect.width,
  }
  const set = (v) => {
    ink.style.transform = `translate3d(${v.x}px, ${v.y}px, 0)`
    ink.style.width = `${v.w}px`
  }
  const from = animate ? filterInk[group] : null
  // 先关掉过渡把起点（或目标）落定，强制重排后再打开过渡设到目标位置。
  // 不关过渡的话，resize 这类"瞬移"会从动画中途一路追过去，看起来像飘着走。
  ink.style.transition = 'none'
  set(from || to)
  void ink.offsetWidth // 提交当前位置，否则起点与终点落在同一帧，不会有过渡
  ink.style.transition = ''
  if (from) set(to)
  filterInk[group] = to
}

/**
 * 点击筛选后立刻把选中态和指示器挪到位，不等列表数据回来。
 * 否则要先 await 一次云端读取再整块重渲染，指示器才开始动 —— 手感上就是"点了半天才滑"。
 */
function applyFilterSelection() {
  const toggle = (group, attr, value) => {
    document.querySelectorAll(`[data-ink="${group}"] .chip`).forEach((c) => {
      c.classList.toggle('active', c.dataset[attr] === value)
    })
    placeFilterInk(group, `[data-ink="${group}"]`, true)
  }
  toggle('kind', 'kind', state.filter.kind)
  toggle('scope', 'scope', state.filter.scope)
  toggle('range', 'range', state.reviewRange)
}

/* --------------------------------------- 键盘：上下切视图 / 左右切栏目 */

const VIEW_LABEL = { inbox: '收件箱', todo: '待办', ask: '问答', review: '复盘' }

/**
 * 键盘导航走"程序化点击"，不另写一套切换逻辑 ——
 * 否则鼠标和键盘会走两条路径，指示器滑动、列表淡入、aria 状态迟早分叉。
 */

function announceKeys(text) {
  const el = $('#key-live')
  if (el) el.textContent = text
}

/** 上下：在侧栏目录里前后移动，到头绕回另一端。顺序直接从 DOM 读，不另维护一份常量 */
function cycleView(delta) {
  const tabs = [...document.querySelectorAll('#tabs [data-view]')]
  if (tabs.length < 2) return false
  const at = tabs.findIndex((t) => t.dataset.view === state.view)
  if (at < 0) return false
  const next = tabs[(at + delta + tabs.length) % tabs.length]
  next.click()
  announceKeys(`视图：${VIEW_LABEL[next.dataset.view] || next.dataset.view}`)
  return true
}

/** 左右：切当前视图的筛选栏目。收件箱切分类、复盘切区间；其它视图没有筛选栏就不响应 */
function cycleFilter(delta) {
  const group = state.view === 'inbox' ? 'kind' : state.view === 'review' ? 'range' : null
  if (!group) return false
  const attr = group === 'kind' ? 'kind' : 'range'
  const chips = [...document.querySelectorAll(`[data-ink="${group}"] .chip`)]
  if (chips.length < 2) return false
  const cur = group === 'kind' ? state.filter.kind : state.reviewRange
  const at = chips.findIndex((c) => c.dataset[attr] === cur)
  if (at < 0) return false
  const next = chips[(at + delta + chips.length) % chips.length]
  next.click()
  // 栏目名带 emoji（"💡 想法"），念出来很啰嗦，播报时去掉
  const label = next.textContent.trim().replace(/^[\p{Extended_Pictographic}\s]+/u, '')
  announceKeys(`栏目：${label}`)
  return true
}

let inkFrame = 0
/** 渲染后统一重排指示器；同一帧内多次调用只跑最后一次 */
function scheduleFilterInk(animate = true) {
  if (inkFrame) cancelAnimationFrame(inkFrame)
  inkFrame = requestAnimationFrame(() => {
    inkFrame = 0
    placeFilterInk('kind', '#view-inbox [data-ink="kind"]', animate)
    placeFilterInk('scope', '#view-inbox [data-ink="scope"]', animate)
    placeFilterInk('range', '#view-review [data-ink="range"]', animate)
  })
}

/** 切换视图时指示器不该从上一个页面的位置滑过来 */
function resetFilterInk() {
  filterInk.kind = null
  filterInk.scope = null
  filterInk.range = null
}

/** 筛选切换后列表换了内容，给它一点位移淡入。
 *  只在用户主动改筛选时置位，数据刷新不重放 —— 否则每次保存都会抖一下。 */
let swapping = false

function renderInbox() {
  const list = visibleEntries()
  const total = activeEntries().length
  const openCount = activeEntries().filter((e) => e.status === 'inbox' || e.status === 'active').length
  const kw = state.filter.keyword

  const chips = [
    ['all', '全部'],
    ['idea', '💡 想法'],
    ['material', '📎 资料'],
    ['todo', '✓ 待办'],
    ['note', '📝 随记'],
    ['key', '⭐ 重点'],
  ]
    .map(
      ([k, label]) =>
        `<button class="chip ${state.filter.kind === k ? 'active' : ''}" data-act="set-kind" data-kind="${k}">${label}</button>`
    )
    .join('')

  const scopes = [
    ['open', '未完成'],
    ['done', '已完成'],
    ['all', '全部'],
  ]
    .map(
      ([s, label]) =>
        `<button class="chip ${state.filter.scope === s ? 'active' : ''}" data-act="set-scope" data-scope="${s}">${label}</button>`
    )
    .join('')

  let body
  if (state.loading) {
    body = `<div class="list">${'<div class="skeleton"></div>'.repeat(4)}</div>`
  } else if (list.length === 0) {
    const cls = swapping ? 'empty is-swapping' : 'empty'
    body = kw
      ? `<div class="${cls}"><div class="empty-icon">🔍</div><h3>没有找到包含「${escapeHtml(
          kw
        )}」的记录</h3><p>换个关键词试试，或清空搜索框查看全部。</p></div>`
      : `<div class="${cls}"><div class="empty-icon">📥</div><h3>收件箱还是空的</h3><p>用「随手记」写下一句话，剩下的交给它。也可以上传 .md 文件批量导入。</p></div>`
  } else {
    body = `<div class="list${swapping ? ' is-swapping' : ''}">${list.map(entryCardHtml).join('')}</div>`
  }

  $('#view-inbox').innerHTML = `
    <header class="view-head">
      <h1>收件箱</h1>
      <p>写下来就好，分类、摘要和关联交给它</p>
    </header>

    <div class="filters">
      <span class="ink-group" data-ink="kind">
        ${chips}<span class="filter-ink" aria-hidden="true"></span>
      </span>
      <span class="spacer"></span>
      <span class="ink-group" data-ink="scope">
        ${scopes}<span class="filter-ink" aria-hidden="true"></span>
      </span>
    </div>
    <div class="filters" style="margin-top:-4px">
      <span class="stat-line">共 ${total} 条记录 · 未完成 ${openCount} 条${
    kw ? ` · 检索「${escapeHtml(kw)}」命中 ${list.length} 条` : list.length !== total ? ` · 当前筛选 ${list.length} 条` : ''
  }</span>
    </div>

    ${body}`

  swapping = false
  scheduleFilterInk()
}

/* ------------------------------------------------------------ 待办 */

function todoBuckets() {
  const open = activeEntries().filter(
    (e) => (e.kind === 'todo' || (e.action_items && e.action_items.length)) && e.status !== 'done' && e.status !== 'archived'
  )
  const buckets = { over: [], today: [], week: [], later: [], none: [] }
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
}

function todoRowHtml(e) {
  const km = kindMeta(e.kind)
  const due = dueHint(e.due_date)
  const isTodo = e.kind === 'todo'
  return `
    <article class="entry" data-act="open-entry" data-id="${e.id}">
      <button class="entry-check" data-act="toggle-entry" data-id="${e.id}" title="标记完成">✓</button>
      <div class="entry-main">
        <div class="entry-top">
          <span class="entry-title">${escapeHtml(e.title || e.raw_text.slice(0, 40))}</span>
          ${isTodo ? '' : `<span class="badge ${km.cls}">${km.icon} 来自记录</span>`}
          ${
            e.priority === 'high'
              ? '<span class="badge badge-over">高优先</span>'
              : e.priority === 'low'
              ? '<span class="badge badge-soft">低优先</span>'
              : ''
          }
          ${due ? `<span class="badge ${due.level === 'over' ? 'badge-over' : 'badge-due'}">${escapeHtml(due.text)}</span>` : ''}
        </div>
        ${e.action_items?.length ? `<div class="entry-summary">${e.action_items.map((a) => `· ${escapeHtml(a)}`).join('<br>')}</div>` : ''}
        <div class="entry-meta"><span>#${e.id}</span><span>${timeAgo(e.created_at)}</span></div>
      </div>
    </article>`
}

function renderTodo() {
  const { buckets, doneList } = todoBuckets()
  const groups = [
    ['⚠️ 已逾期', buckets.over],
    ['🔥 今天到期', buckets.today],
    ['📅 一周内', buckets.week],
    ['🗓️ 更远', buckets.later],
    ['🕊️ 没有期限', buckets.none],
  ].filter(([, arr]) => arr.length)

  const totalOpen = groups.reduce((n, [, arr]) => n + arr.length, 0)

  let body
  if (state.loading) {
    body = `<div class="list">${'<div class="skeleton"></div>'.repeat(3)}</div>`
  } else if (totalOpen === 0 && doneList.length === 0) {
    body = `<div class="empty"><div class="empty-icon">✅</div><h3>暂时没有待办</h3><p>在收件箱里记下"要做的事"，它会自动被识别成待办。</p></div>`
  } else {
    body = groups
      .map(
        ([title, arr]) => `
      <div class="todo-group">
        <h3>${title} · ${arr.length}</h3>
        <div class="list">${arr.map(todoRowHtml).join('')}</div>
      </div>`
      )
      .join('')
    if (doneList.length) {
      body += `
      <div class="todo-group">
        <h3>已完成 · ${doneList.length}</h3>
        <div class="list">${doneList.map(todoRowHtml).join('')}</div>
      </div>`
    }
  }

  $('#view-todo').innerHTML = `
    <header class="view-head">
      <h1>待办</h1>
      <p>按紧急程度排好，逾期在最前 · ${totalOpen} 项未完成</p>
    </header>

    <div class="card">
      <div class="card-head">
        <span class="spacer"></span>
        <button class="btn btn-ghost btn-sm" id="btn-tidy" ${state.todoAdviceBusy ? 'disabled' : ''}>
          ${state.todoAdviceBusy ? '整理中…' : '✨ AI 整理建议'}
        </button>
      </div>
      ${
        state.todoAdvice || state.todoAdviceBusy
          ? `<div class="advice-box" id="advice-box">
               <h4>整理建议</h4>
               <div id="advice-body">${state.todoAdviceBusy ? '<div class="spinner"></div>' : renderRichText(state.todoAdvice)}</div>
             </div>`
          : `<p class="card-sub" style="margin:0">点右上角的「AI 整理建议」，让它帮你排优先级、找重复项、判断哪些该放弃。</p>`
      }
    </div>
    ${body}`

  const btn = $('#btn-tidy')
  if (btn) btn.addEventListener('click', handleTidy)
}

/* ------------------------------------------------------------ 问答 */

function askSuggestions() {
  const out = []
  const open = activeEntries().filter((e) => e.kind === 'todo' && e.status !== 'done')
  if (open.length) out.push('我有哪些待办快到期了？')
  const tagCount = {}
  for (const e of activeEntries()) for (const t of e.tags || []) tagCount[t] = (tagCount[t] || 0) + 1
  const topTag = Object.entries(tagCount).sort((a, b) => b[1] - a[1])[0]?.[0]
  if (topTag) out.push(`帮我梳理一下关于「${topTag}」的记录`)
  out.push('我最近主要在关注什么？')
  out.push('有哪些想法一直没有推进？')
  return out.slice(0, 4)
}

function renderAsk() {
  const { messages, busy } = state.ask
  const thread = messages.length
    ? messages
        .map((m, i) => {
          const isUser = m.role === 'user'
          const streaming = !isUser && i === messages.length - 1 && busy
          return `
        <div class="msg ${isUser ? 'user' : 'assistant'}">
          <div class="msg-avatar">${isUser ? '🙋' : '🐾'}</div>
          <div class="msg-body">
            <div class="msg-role">${isUser ? '你' : '信息管家'}</div>
            <div class="msg-text" ${streaming ? 'data-streaming="1"' : ''}>${
            m.content ? renderRichText(m.content) : busy ? '<div class="spinner"></div>' : ''
          }</div>
          </div>
        </div>`
        })
        .join('')
    : `<div class="empty"><div class="empty-icon">💬</div><h3>问点什么吧</h3><p>它只会依据你自己的记录回答，记录里没有的会直接告诉你没有。</p></div>`

  $('#view-ask').innerHTML = `
    <header class="view-head">
      <h1>问答</h1>
      <p>只依据你自己的记录回答，记录里没有的它会直说 · 基于 ${activeEntries().length} 条</p>
    </header>

    <div class="card">
      ${
        state.ask.messages.length
          ? '<div class="card-head"><span class="spacer"></span><button class="btn btn-ghost btn-sm" id="btn-clear-ask">清空对话</button></div>'
          : ''
      }
      ${
        state.ask.messages.length
          ? ''
          : `<div class="suggest-row">${askSuggestions()
              .map((s) => `<button class="chip" data-act="ask-suggest" data-q="${escapeHtml(s)}">${escapeHtml(s)}</button>`)
              .join('')}</div>`
      }
      <div class="ask-thread" id="ask-thread">${thread}</div>
      <div class="ask-input" style="margin-top:16px">
        <textarea id="ask-input" placeholder="比如：我上次记的那个想法后来推进了吗？"></textarea>
        ${
          busy
            ? '<button class="btn btn-ghost" id="btn-stop-ask">停止</button>'
            : '<button class="btn btn-primary" id="btn-ask">发送</button>'
        }
      </div>
    </div>`

  const threadEl = $('#ask-thread')
  if (threadEl) threadEl.scrollIntoView({ block: 'nearest' })

  const input = $('#ask-input')
  if (input) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleAsk()
      }
    })
  }
  $('#btn-ask')?.addEventListener('click', handleAsk)
  $('#btn-stop-ask')?.addEventListener('click', () => {
    state.ask.controller?.abort()
  })
  $('#btn-clear-ask')?.addEventListener('click', () => {
    state.ask.messages = []
    renderAsk()
  })
}

/* ------------------------------------------------------------ 复盘 */

function rangeBounds(range) {
  const end = new Date()
  if (range === 'all') return { start: null, end, label: '全部记录' }
  const days = Number(range)
  const start = new Date(end.getTime() - (days - 1) * 86400000)
  return { start, end, label: `最近 ${days} 天` }
}

function entriesInRange(range) {
  const { start, end } = rangeBounds(range)
  if (!start) return activeEntries()
  const s = start.getTime()
  const e = end.getTime() + 86399999
  return activeEntries().filter((x) => {
    const t = new Date(x.created_at).getTime()
    return t >= s && t <= e
  })
}

function computeStats(list) {
  const byKind = { idea: 0, material: 0, todo: 0, note: 0 }
  let done = 0
  let pending = 0
  for (const e of list) {
    byKind[e.kind] = (byKind[e.kind] || 0) + 1
    if (e.status === 'done') done++
    if (e.kind === 'todo' && e.status !== 'done') pending++
  }
  return { total: list.length, byKind, done, pending }
}

function renderReview() {
  const rangeChips = [
    ['7', '最近 7 天'],
    ['30', '最近 30 天'],
    ['all', '全部'],
  ]
    .map(
      ([v, label]) =>
        `<button class="chip ${state.reviewRange === v ? 'active' : ''}" data-act="set-range" data-range="${v}">${label}</button>`
    )
    .join('')

  const scoped = entriesInRange(state.reviewRange)
  const stats = computeStats(scoped)

  const history = state.reviews.length
    ? state.reviews
        .map(
          (r) => `
      <div class="review-item">
        <div class="review-head">
          <h3>${escapeHtml(r.period_label)}</h3>
          <span class="badge badge-soft">${r.entry_count} 条记录</span>
          <span class="card-sub">${fmtDateTime(r.created_at)}</span>
          <span class="spacer"></span>
          <button class="link" data-act="delete-review" data-id="${r.id}">删除</button>
        </div>
        <div class="review-body">${renderRichText(r.summary || '')}</div>
        ${
          r.actions?.length
            ? `<div class="review-actions">
                 <h4>后续行动建议</h4>
                 ${r.actions
                   .map(
                     (a, i) => `<div class="action-item"><span class="action-num">${i + 1}</span><span>${escapeHtml(
                       a
                     )}</span></div>`
                   )
                   .join('')}
               </div>`
            : ''
        }
      </div>`
        )
        .join('')
    : `<div class="empty"><div class="empty-icon">📊</div><h3>还没有复盘</h3><p>积累几条记录后，点「生成复盘」看看这段时间的轨迹。</p></div>`

  $('#view-review').innerHTML = `
    <header class="view-head">
      <h1>复盘</h1>
      <p>把一段时间的记录收拢成一页结论与后续行动</p>
    </header>

    <div class="card">
      <div class="card-head">
        <span class="spacer"></span>
        <button class="btn btn-primary btn-sm" id="btn-review" ${state.reviewBusy ? 'disabled' : ''}>
          ${state.reviewBusy ? '生成中…' : '✨ 生成复盘'}
        </button>
      </div>
      <div class="filters" style="margin:0 0 14px">
        <span class="ink-group" data-ink="range">
          ${rangeChips}<span class="filter-ink" aria-hidden="true"></span>
        </span>
      </div>
      <div class="stat-grid">
        <div class="stat-cell"><b>${stats.total}</b><span>区间内记录</span></div>
        <div class="stat-cell"><b>${stats.byKind.idea || 0}</b><span>想法</span></div>
        <div class="stat-cell"><b>${stats.byKind.material || 0}</b><span>资料</span></div>
        <div class="stat-cell"><b>${stats.byKind.todo || 0}</b><span>待办</span></div>
        <div class="stat-cell"><b>${stats.pending}</b><span>未完成待办</span></div>
        <div class="stat-cell"><b>${stats.done}</b><span>已完成</span></div>
      </div>
      ${
        state.loading
          ? '<div class="skeleton" style="height:60px"></div>'
          : stats.total === 0
          ? `<p class="card-sub" style="margin:0">这段时间还没有记录，换个区间或先去收件箱记点什么。</p>`
          : state.reviewBusy
          ? '<div class="advice-box"><div class="spinner"></div> <span id="review-progress">正在读取记录并生成总结…</span></div>'
          : ''
      }
    </div>

    <div class="card">
      <div class="card-head"><h2>历史复盘</h2><span class="card-sub">${state.reviews.length} 份</span></div>
      ${history}
    </div>`

  $('#btn-review')?.addEventListener('click', handleReview)
  scheduleFilterInk()
}

/* --------------------------------------------------- 拖拽导入 .md */

function hasFiles(e) {
  const dt = e.dataTransfer
  return !!dt && Array.from(dt.types || []).includes('Files')
}

function isMarkdown(file) {
  return /\.(md|markdown|mdx|txt)$/i.test(file.name) || file.type === 'text/markdown'
}

/**
 * 把 .md 直接拖进右栏即导入 —— 比去找按钮顺手，平时也完全不占视觉。
 *
 * 三个坑：
 * 1. dragenter/dragleave 会在子元素之间反复触发，必须用计数器判断真正离开；
 * 2. **dragleave 的 dataTransfer 在部分浏览器里取不到 types**，所以这里不能再判断
 *    「是不是文件」，否则计数只增不减、高亮会一直卡在界面上；
 * 3. Esc 取消拖拽、拖出窗口等情况可能收不到 dragleave，用一个空闲计时器兜底。
 */
function bindDropImport() {
  const rail = $('#compose-rail')
  const hint = $('#rail-drop-hint')
  if (!rail) return

  let depth = 0
  let active = false
  let idleTimer = null

  const clear = () => {
    depth = 0
    active = false
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = null
    rail.classList.remove('drag-over')
    // 用 class 而非 hidden 属性：作者的 display 会盖掉 UA 的 [hidden]{display:none}
    if (hint) hint.classList.remove('show')
  }

  // 只要还在 dragover，就不断续期；停止超过 1.2 秒即认为拖拽已结束
  const keepAlive = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(clear, 1200)
  }

  rail.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    active = true
    depth++
    rail.classList.add('drag-over')
    if (hint) hint.classList.add('show')
    keepAlive()
  })

  rail.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    keepAlive()
  })

  // 不判断 hasFiles：拖拽离开时 dataTransfer.types 可能为空
  rail.addEventListener('dragleave', () => {
    if (!active) return
    depth = Math.max(0, depth - 1)
    if (depth === 0) clear()
  })

  rail.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    clear()
    const files = Array.from(e.dataTransfer.files || []).filter(isMarkdown)
    if (!files.length) {
      toast('只支持 .md / .markdown / .mdx / .txt 文件', 'warn', 4000)
      return
    }
    handleMdFiles(files)
  })

  // 拖拽结束、拖出窗口、拖拽被取消 —— 都要把高亮收掉
  window.addEventListener('dragend', clear)
  window.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget) clear() // relatedTarget 为空 = 真离开了窗口
  })
  // 拖到页面其他位置时别让浏览器直接打开文件
  window.addEventListener('dragover', (e) => {
    if (hasFiles(e)) e.preventDefault()
  })
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    clear()
  })
}

/* ============================================================== 交互动作 */

function setAiStage(visible, text) {
  const el = $('#ai-stage')
  if (!el) return
  el.classList.toggle('hidden', !visible)
  if (text) $('#ai-stage-text').textContent = text
}

/**
 * 保存一条记录并跑 AI 分析（分类 / 标题 / 摘要 / 重点 / 行动项 / 标签 / 优先级 / 关联）。
 * 手动记录与 md 导入共用这条路径。
 */
async function saveEntryAndAnalyze(rawText, { titleHint = '' } = {}) {
  const created = await db.createEntry(rawText)
  state.entries = [created, ...state.entries]
  state.analyzing.add(created.id)
  renderView()

  try {
    const result = await ai.analyzeEntry({
      rawText,
      existingEntries: state.entries.filter((e) => e.id !== created.id),
    })

    const updated = await db.updateEntry(created.id, {
      kind: result.kind,
      title: result.title || titleHint || created.raw_text.slice(0, 20),
      summary: result.summary,
      key_points: result.key_points,
      action_items: result.action_items,
      tags: result.tags,
      priority: result.priority,
      due_date: result.due_date,
      ai_state: 'done',
    })
    setEntry(updated)

    if (result.related_ids.length) {
      const valid = result.related_ids.filter(
        (id) => state.entries.some((e) => e.id === id && e.id !== created.id)
      )
      if (valid.length) {
        await db.replaceLinks(created.id, valid, result.related_reason)
        state.links = (await db.listLinks()) || []
      }
    }
    return { ok: true, entry: updated, result }
  } catch (err) {
    try {
      setEntry(await db.updateEntry(created.id, { ai_state: 'failed' }))
    } catch {
      /* 标记失败本身失败时不阻塞用户 */
    }
    return { ok: false, error: err }
  } finally {
    state.analyzing.delete(created.id)
  }
}

async function handleCapture() {
  const input = $('#capture-input')
  if (!input) return
  const text = input.value.trim()
  if (!text) {
    toast('先写点什么再记录吧', 'warn')
    return
  }

  input.value = ''
  setAiStage(true, '正在保存…')
  const res = await saveEntryAndAnalyze(text)
  setAiStage(false)
  renderView()

  if (res.ok) {
    const km = kindMeta(res.result.kind)
    const extra = res.result.related_ids.length ? `，关联到 ${res.result.related_ids.length} 条已有记录` : ''
    toast(`已归类为「${km.label}」${extra}`, 'success')
  } else {
    toast(`AI 分析失败：${describeError(res.error)}`, 'error', 6000)
  }
  input.focus()
}

/* ------------------------------------------------------------ md 导入 */

const MD_MAX_BYTES = 512 * 1024
const MD_MAX_FILES = 10

/** 标题优先取文件里的第一个 markdown 标题，其次用文件名 */
function mdTitle(text, filename) {
  const m = text.match(/^#{1,3}\s+(.+)$/m)
  if (m) return m[1].trim().slice(0, 60)
  return filename.replace(/\.(md|markdown|mdx|txt)$/i, '').slice(0, 60)
}

/** 读取 .md 文件内容，逐个作为记录保存并交给 AI 分析（串行，避免同时打模型） */
async function handleMdFiles(files) {
  const picked = files.slice(0, MD_MAX_FILES)
  if (files.length > MD_MAX_FILES) {
    toast(`一次最多导入 ${MD_MAX_FILES} 个文件，其余已忽略`, 'warn', 5000)
  }

  let done = 0
  let skipped = 0
  let lastError = null

  for (let i = 0; i < picked.length; i++) {
    const file = picked[i]
    setAiStage(true, `导入中 ${i + 1}/${picked.length}：${file.name}`)
    try {
      if (file.size > MD_MAX_BYTES) {
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

  setAiStage(false)
  renderView()

  if (done) {
    toast(`已导入 ${done} 个文件${skipped ? `，${skipped} 个跳过或失败` : ''}`, 'success', 4500)
  } else if (lastError) {
    toast(`导入失败：${describeError(lastError)}`, 'error', 6000)
  } else {
    toast('没有可导入的内容（空文件或超出大小限制）', 'warn', 4500)
  }
}

async function toggleEntry(id) {
  const e = entryById(id)
  if (!e) return
  const next = e.status === 'done' ? 'inbox' : 'done'
  try {
    const updated = await db.updateEntry(id, { status: next })
    setEntry(updated)
    toast(next === 'done' ? '已完成 ✓' : '已恢复为未完成', 'success')
    renderView()
    if (!$('#drawer').classList.contains('hidden')) openEntry(id)
  } catch (err) {
    toast(describeError(err), 'error')
  }
}

/** 删除：先从界面移除并给出撤销窗口，到点才真正落库 */
function removeEntry(id) {
  const e = entryById(id)
  if (!e || pendingDeletes.has(id)) return
  const label = (e.title || e.raw_text).replace(/\s+/g, ' ').slice(0, 18)

  closeDrawer()
  pendingDeletes.set(id, { timer: null })
  renderView()

  toast(`已删除「${label}」`, 'info', UNDO_MS, { label: '撤销', onClick: () => undoDelete(id) })

  const rec = pendingDeletes.get(id)
  if (rec) rec.timer = setTimeout(() => commitDelete(id), UNDO_MS)
}

function undoDelete(id) {
  const rec = pendingDeletes.get(id)
  if (!rec) return
  if (rec.timer) clearTimeout(rec.timer)
  pendingDeletes.delete(id)
  renderView()
  toast('已恢复', 'success', 2200)
}

async function commitDelete(id) {
  if (!pendingDeletes.has(id)) return
  pendingDeletes.delete(id)
  try {
    await db.deleteLinksFor(id)
    await db.deleteEntry(id)
    state.entries = state.entries.filter((x) => x.id !== id)
    state.searchResults = state.searchResults.filter((x) => x.id !== id)
    state.links = state.links.filter((l) => l.source_id !== id && l.target_id !== id)
  } catch (err) {
    // 删除失败就让条目回到列表，别让用户以为已经删掉了
    toast(`删除失败：${describeError(err)}`, 'error', 6000)
  }
  renderView()
}

async function reanalyzeEntry(id) {
  const e = entryById(id)
  if (!e) return
  state.analyzing.add(id)
  renderView()
  openEntry(id)
  try {
    const result = await ai.analyzeEntry({
      rawText: e.raw_text,
      existingEntries: state.entries.filter((x) => x.id !== id),
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
    state.entries = state.entries.map((x) => (x.id === id ? updated : x))
    const valid = result.related_ids.filter((rid) => rid !== id && state.entries.some((x) => x.id === rid))
    await db.replaceLinks(id, valid, result.related_reason)
    state.links = (await db.listLinks()) || []
    toast('已重新分析', 'success')
  } catch (err) {
    toast(`重新分析失败：${describeError(err)}`, 'error', 6000)
  } finally {
    state.analyzing.delete(id)
    renderView()
    openEntry(id)
  }
}

async function handleTidy() {
  const { buckets } = todoBuckets()
  const todos = [...buckets.over, ...buckets.today, ...buckets.week, ...buckets.later, ...buckets.none]
  if (todos.length === 0) {
    toast('现在没有待办需要整理', 'warn')
    return
  }
  state.todoAdviceBusy = true
  state.todoAdvice = ''
  renderTodo()
  try {
    const body = $('#advice-body')
    const text = await ai.tidyTodos({
      todos: todos.map((t) => ({
        title: t.title || t.raw_text.slice(0, 40),
        due_date: t.due_date,
        priority: PRIORITY_META[t.priority]?.label,
      })),
      onDelta: (d) => {
        state.todoAdvice += d
        if (body) body.innerHTML = renderRichText(state.todoAdvice)
      },
    })
    state.todoAdvice = text
  } catch (err) {
    toast(`整理失败：${describeError(err)}`, 'error', 6000)
    state.todoAdvice = ''
  } finally {
    state.todoAdviceBusy = false
    renderTodo()
  }
}

async function handleAsk() {
  const input = $('#ask-input')
  if (!input || state.ask.busy) return
  const text = input.value.trim()
  if (!text) return

  if (activeEntries().length === 0) {
    toast('还没有记录可以检索，先去收件箱记几条', 'warn')
    return
  }

  input.value = ''
  state.ask.messages.push({ role: 'user', content: text })
  state.ask.busy = true
  state.ask.messages.push({ role: 'assistant', content: '' })
  const assistant = state.ask.messages[state.ask.messages.length - 1]
  state.ask.controller = new AbortController()
  renderAsk()

  const history = state.ask.messages
    .slice(0, -2)
    .slice(-6)
    .filter((m) => m.content)

  try {
    await ai.answerQuestion({
      question: text,
      entries: activeEntries(),
      history,
      signal: state.ask.controller.signal,
      onDelta: (d) => {
        assistant.content += d
        const node = document.querySelector('[data-streaming="1"]')
        if (node) node.innerHTML = renderRichText(assistant.content)
      },
    })
    if (!assistant.content) assistant.content = '（没有生成内容，请重试）'
  } catch (err) {
    const aborted = controller.signal.aborted || err?.name === 'AbortError'
    if (aborted) {
      if (!assistant.content) assistant.content = '（已停止）'
    } else {
      assistant.content = assistant.content
        ? `${assistant.content}\n\n（生成中断：${describeError(err)}）`
        : `抱歉，回答失败了：${describeError(err)}`
      toast(describeError(err), 'error', 6000)
    }
  } finally {
    state.ask.busy = false
    state.ask.controller = null
    renderAsk()
  }
}

async function handleReview() {
  const scoped = entriesInRange(state.reviewRange)
  if (scoped.length === 0) {
    toast('这个区间还没有记录', 'warn')
    return
  }
  state.reviewBusy = true
  renderReview()
  try {
    const { start, end, label } = rangeBounds(state.reviewRange)
    const periodLabel =
      state.reviewRange === 'all'
        ? `全部记录（截至 ${fmtDate(end.toISOString())}）`
        : `${label}（${fmtDate(start.toISOString())} ~ ${fmtDate(end.toISOString())}）`

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
    state.reviews = [created, ...state.reviews]
    toast('复盘已生成并保存到云端', 'success')
  } catch (err) {
    toast(`生成失败：${describeError(err)}`, 'error', 6000)
  } finally {
    state.reviewBusy = false
    renderView()
  }
}

async function removeReview(id) {
  const ok = await confirmDialog({
    title: '删除这份复盘？',
    message: '删除后无法恢复。',
    confirmText: '删除',
    danger: true,
  })
  if (!ok) return
  try {
    await db.deleteReview(id)
    state.reviews = state.reviews.filter((r) => r.id !== id)
    renderReview()
    toast('已删除', 'success')
  } catch (err) {
    toast(describeError(err), 'error')
  }
}

/* ================================================================== 抽屉 */

function closeDrawer({ restoreFocus = true } = {}) {
  const host = $('#drawer')
  if (host) {
    host.classList.add('hidden')
    host.innerHTML = ''
  }
  $('#drawer-mask').classList.add('hidden')
  unlockScroll('drawer')
  refreshInert()
  // 焦点回到主内容区（列表项本身可能已被重渲染，直接聚焦容器更稳）
  const main = $('#main-content')
  if (restoreFocus && main && !document.body.classList.contains('nav-open')) {
    main.focus({ preventScroll: true })
  }
}

function openEntry(id) {
  const e = entryById(id)
  if (!e) return
  const km = kindMeta(e.kind)
  const st = STATUS_META[e.status] || STATUS_META.inbox
  const due = dueHint(e.due_date)
  const related = linksOf(id)
    .map((l) => {
      const t = entryById(l.id)
      if (!t) return ''
      const tkm = kindMeta(t.kind)
      return `<div class="related-item" data-act="open-entry" data-id="${t.id}">
        <span class="badge ${tkm.cls}">${tkm.icon}</span>
        <span class="t"><strong>${escapeHtml((t.title || t.raw_text).slice(0, 44))}</strong>
        <small>${escapeHtml(l.reason || '内容相关')}</small></span>
      </div>`
    })
    .filter(Boolean)
    .join('')

  const analyzing = state.analyzing.has(id) || e.ai_state === 'pending'

  $('#drawer').innerHTML = `
    <div class="drawer-head">
      <h2 id="drawer-title">${escapeHtml(e.title || '未命名记录')}</h2>
      <button class="btn btn-ghost btn-sm" data-act="close-drawer">关闭</button>
    </div>
    <div class="entry-top" style="margin-bottom:4px">
      <span class="badge ${km.cls}">${km.icon} ${km.label}</span>
      <span class="badge badge-soft">${st.label}</span>
      <span class="badge badge-soft">优先级 ${PRIORITY_META[e.priority]?.label || '中'}</span>
      ${due ? `<span class="badge ${due.level === 'over' ? 'badge-over' : 'badge-due'}">${escapeHtml(due.text)}</span>` : ''}
      ${analyzing ? '<span class="badge badge-ai">AI 分析中…</span>' : ''}
    </div>
    <p class="card-sub" style="margin:8px 0 0">记录于 ${fmtDateTime(e.created_at)}${
    e.updated_at && e.updated_at !== e.created_at ? ` · 更新于 ${fmtDateTime(e.updated_at)}` : ''
  }</p>

    ${e.summary ? `<div class="drawer-section"><h3>摘要</h3><div class="raw-box">${escapeHtml(e.summary)}</div></div>` : ''}
    ${
      e.key_points?.length
        ? `<div class="drawer-section"><h3>重点信息</h3><ul class="kv-list">${e.key_points
            .map((p) => `<li>${escapeHtml(p)}</li>`)
            .join('')}</ul></div>`
        : ''
    }
    ${
      e.action_items?.length
        ? `<div class="drawer-section"><h3>行动项</h3><ul class="kv-list">${e.action_items
            .map((p) => `<li>${escapeHtml(p)}</li>`)
            .join('')}</ul></div>`
        : ''
    }
    ${
      e.tags?.length
        ? `<div class="drawer-section"><h3>标签</h3><div class="entry-tags">${e.tags
            .map((t) => `<span class="tag">${escapeHtml(t)}</span>`)
            .join('')}</div></div>`
        : ''
    }

    <div class="drawer-section">
      <h3>原文 ${state.editingId === id ? '' : '<button class="link" data-act="edit-raw" data-id="' + id + '">编辑</button>'}</h3>
      <div id="raw-area">
        <div class="raw-box">${escapeHtml(e.raw_text)}</div>
      </div>
    </div>

    <div class="drawer-section">
      <h3>关联内容 ${related ? `· ${linksOf(id).length}` : ''}</h3>
      ${related || '<p class="card-sub" style="margin:0">暂时没有找到关联的记录。</p>'}
    </div>

    <div class="drawer-actions">
      <button class="btn btn-ghost btn-sm" data-act="toggle-entry" data-id="${e.id}">${
    e.status === 'done' ? '标记为未完成' : '标记完成'
  }</button>
      <button class="btn btn-ghost btn-sm" data-act="reanalyze" data-id="${e.id}">重新分析</button>
      <span class="spacer" style="flex:1"></span>
      <button class="btn btn-danger btn-sm" data-act="delete-entry" data-id="${e.id}">删除</button>
    </div>`

  $('#drawer').classList.remove('hidden')
  $('#drawer-mask').classList.remove('hidden')
  lockScroll('drawer')
  refreshInert()
  setTimeout(() => {
    const focusTarget = $('#drawer').querySelector('button, [href], input, textarea, [tabindex]:not([tabindex="-1"])')
    if (focusTarget) focusTarget.focus({ preventScroll: true })
  }, 70)
}

function startEditRaw(id) {
  const e = entryById(id)
  if (!e) return
  const area = $('#raw-area')
  if (!area) return
  area.innerHTML = `
    <textarea id="raw-edit" style="width:100%;min-height:140px;padding:12px;border:1px solid var(--line-strong);border-radius:11px;line-height:1.75;outline:none">${escapeHtml(
      e.raw_text
    )}</textarea>
    <div style="display:flex;gap:8px;margin-top:10px">
      <button class="btn btn-primary btn-sm" data-act="save-raw" data-id="${id}">保存并重新分析</button>
      <button class="btn btn-ghost btn-sm" data-act="cancel-raw" data-id="${id}">取消</button>
    </div>`
}

async function saveRaw(id) {
  const ta = $('#raw-edit')
  if (!ta) return
  const text = ta.value.trim()
  if (!text) {
    toast('内容不能为空', 'warn')
    return
  }
  try {
    const updated = await db.updateEntry(id, { raw_text: text, ai_state: 'pending' })
    state.entries = state.entries.map((x) => (x.id === id ? updated : x))
    toast('已保存，正在重新分析…', 'success')
  } catch (err) {
    toast(describeError(err), 'error')
    return
  }
  await reanalyzeEntry(id)
}

/* ============================================================== 事件绑定 */

function bindGlobal() {
  // 视图切换
  $('#tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('[data-view]')
    if (!tab) return
    state.view = tab.dataset.view
    renderView()
    if (narrowQuery.matches) closeNav({ restoreFocus: false }) // 窄屏选完即收起抽屉
  })

  // 窄屏的两个抽屉：左菜单栏与右随手记
  $('#nav-toggle').addEventListener('click', () => {
    if (document.body.classList.contains('nav-open')) closeNav({ restoreFocus: true })
    else openNav()
  })
  $('#rail-toggle').addEventListener('click', () => {
    if (document.body.classList.contains('rail-open')) closeRail({ restoreFocus: true })
    else openRail()
  })
  $('#rail-close').addEventListener('click', () => closeRail({ restoreFocus: true }))
  $('#sidebar-scrim').addEventListener('click', () => {
    if (document.body.classList.contains('nav-open')) closeNav({ restoreFocus: true })
    else closeRail({ restoreFocus: true })
  })

  // 键盘：/ 定位搜索，n 定位随手记
  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return
    const t = e.target
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return

    // 方向键：上下切视图，左右切栏目
    if (
      e.key === 'ArrowUp' ||
      e.key === 'ArrowDown' ||
      e.key === 'ArrowLeft' ||
      e.key === 'ArrowRight'
    ) {
      // 手柄自己用上下键调悬浮方块的位置，别抢
      if (t && t.closest && t.closest('[data-grip]')) return
      if (document.querySelector('.modal-mask')) return
      if ($('#app-view').classList.contains('hidden')) return // 还没登录，别在看不见的地方改视图
      if (!$('#settings-panel').classList.contains('hidden')) return // 面板里的滑杆要用左右键调值
      if (document.body.classList.contains('nav-open')) return
      if (document.body.classList.contains('rail-open')) return
      const delta = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1
      const moved =
        e.key === 'ArrowUp' || e.key === 'ArrowDown' ? cycleView(delta) : cycleFilter(delta)
      // 只有真的接管了才阻止默认行为：待办 / 问答页没有筛选栏，左右键仍留给页面自己处理
      if (moved) e.preventDefault()
      return
    }

    if (e.key === '/') {
      e.preventDefault()
      $('#global-search').focus()
    } else if (e.key === 'n' || e.key === 'N') {
      e.preventDefault()
      focusCapture()
    }
  })

  // 退出
  $('#btn-logout').addEventListener('click', async () => {
    const ok = await confirmDialog({ title: '退出登录？', message: '退出后需要重新登录才能查看你的记录。', confirmText: '退出' })
    if (!ok) return
    // 先把还没落盘的设置写上去，否则登出后请求会因会话失效而失败
    if (settingsSaveTimer) {
      clearTimeout(settingsSaveTimer)
      settingsSaveTimer = null
      await saveSettingsNow()
    }
    closeSettings()
    try {
      await db.auth.signOut()
    } catch {
      /* 退出失败也回到登录页 */
    }
    state.session = null
    state.entries = []
    state.searchResults = []
    state.links = []
    state.reviews = []
    state.ask.messages = []
    clearCachedSettings()
    useSettings(normalizeSettings(DEFAULT_SETTINGS), { persist: false })
    showAuth()
  })

  // 全局搜索
  const search = $('#global-search')
  const doSearch = () => {
    const value = search.value.trim()
    state.filter.keyword = value
    $('#search-clear').hidden = !value
    state.view = 'inbox'
    refreshEntries()
  }
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      doSearch()
    }
  })
  search.addEventListener('input', debounce(() => {
    if (!search.value.trim() && state.filter.keyword) doSearch()
  }, 400))
  $('#search-clear').addEventListener('click', () => {
    search.value = ''
    doSearch()
  })

  // 侧栏「随手记」：输入框常驻于侧栏，只在初始化时绑定一次
  const captureInput = $('#capture-input')
  captureInput.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      handleCapture()
    }
  })
  $('#btn-capture').addEventListener('click', handleCapture)
  $('#btn-upload-md').addEventListener('click', () => $('#md-file').click())
  $('#md-file').addEventListener('change', (e) => {
    const files = Array.from(e.target.files || [])
    e.target.value = ''
    if (files.length) handleMdFiles(files)
  })
  bindDropImport()

  // 设置面板
  $('#btn-settings').addEventListener('click', openSettings)
  $('#settings-mask').addEventListener('click', closeSettings)
  $('#settings-panel').addEventListener('settings-close', closeSettings)

  // 抽屉遮罩
  $('#drawer-mask').addEventListener('click', () => closeDrawer())
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return
    if (document.querySelector('.modal-mask')) return // 确认框自己处理
    if (document.body.classList.contains('nav-open')) return closeNav({ restoreFocus: true })
    if (document.body.classList.contains('rail-open')) return closeRail({ restoreFocus: true })
    if (!$('#settings-panel').classList.contains('hidden')) return closeSettings()
    closeDrawer()
  })

  // 统一事件委托
  document.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-act]')
    if (!el) return
    const act = el.dataset.act

    if (act === 'open-entry') {
      openEntry(Number(el.dataset.id))
      return
    }
    if (act === 'set-kind') {
      if (state.filter.kind === el.dataset.kind) return // 重复点同一项不该重放动画
      state.filter.kind = el.dataset.kind
      swapping = true
      applyFilterSelection() // 先动起来，再等数据
      refreshEntries()
      return
    }
    if (act === 'set-scope') {
      if (state.filter.scope === el.dataset.scope) return
      state.filter.scope = el.dataset.scope
      swapping = true
      applyFilterSelection()
      renderView()
      return
    }
    if (act === 'set-range') {
      if (state.reviewRange === el.dataset.range) return
      state.reviewRange = el.dataset.range
      applyFilterSelection()
      renderReview()
      return
    }
    if (act === 'ask-suggest') {
      const input = $('#ask-input')
      if (input) {
        input.value = el.dataset.q
        handleAsk()
      }
      return
    }
    if (act === 'close-drawer') return closeDrawer()
    if (act === 'toggle-entry') {
      ev.stopPropagation()
      toggleEntry(Number(el.dataset.id))
      return
    }
    if (act === 'delete-entry') return removeEntry(Number(el.dataset.id))
    if (act === 'reanalyze') return reanalyzeEntry(Number(el.dataset.id))
    if (act === 'edit-raw') return startEditRaw(Number(el.dataset.id))
    if (act === 'save-raw') return saveRaw(Number(el.dataset.id))
    if (act === 'cancel-raw') return openEntry(Number(el.dataset.id))
    if (act === 'delete-review') return removeReview(Number(el.dataset.id))
  })
}

/* ==================================================================== 入口 */

// 窗口尺寸变化会让 chip 换行、宽度改变，指示器必须重新贴合（不加过渡，否则会飘着追）
window.addEventListener('resize', () => scheduleFilterInk(false))
bindFloatDrag()

// 先用本地缓存把外观铺上，避免首屏闪一下默认配色；登录后再以云端偏好为准
initEffects(document.getElementById('fx-layer'))
useSettings(readCachedSettings(), { persist: false })

bindAuth()
bindGlobal()
boot()
