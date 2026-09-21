/**
 * DOM 回归测试（jsdom）——验证静态检查抓不到的运行时行为：
 * 模块能否加载、顶层代码是否抛错、事件绑定是否生效、
 * 视图切换 / 导航抽屉 / 滚动锁 / 焦点管理 / 撤销删除是否按预期工作。
 *
 * 运行方式（需要 jsdom）：
 *   npm install jsdom --prefix <某个目录>
 *   NODE_PATH=<那个目录>/node_modules node tools/dom-test.mjs
 *
 * 例：
 *   NODE_PATH=C:\Users\me\.workbuddy\binaries\node\workspace\node_modules \
 *     node tools/dom-test.mjs
 *
 * 说明：云服务 SDK 用结构对齐的假实现替换，因此不发任何真实请求。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

let JSDOM
try {
  ;({ JSDOM } = require('jsdom'))
} catch {
  console.error('未找到 jsdom。请先安装，并用 NODE_PATH 指向它的 node_modules：')
  console.error('  npm install jsdom --prefix <dir>')
  console.error('  NODE_PATH=<dir>/node_modules node tools/dom-test.mjs')
  process.exit(1)
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const APP = path.resolve(__dirname, '..')
const SRC = path.join(APP, 'assets', 'js')

// ---------- 1) 生成可直接 import 的模块副本（去掉 ?v= 参数、改扩展名）
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pma-dom-test-'))
for (const f of fs.readdirSync(SRC).filter((n) => n.endsWith('.js'))) {
  let s = fs.readFileSync(path.join(SRC, f), 'utf8')
  s = s.replace(/from\s+'(\.[^']+?)\.js\?v=[^']+'/g, "from '$1.mjs'")
  s = s.replace(/from\s+'(\.[^']+?)\.js'/g, "from '$1.mjs'")
  fs.writeFileSync(path.join(TMP, f.replace(/\.js$/, '.mjs')), s)
}

// ---------- 2) 搭 DOM 环境
const html = fs.readFileSync(path.join(APP, 'index.html'), 'utf8')
const dom = new JSDOM(html, {
  url: 'https://personal-memory-agent-50179.app.workbuddy.host/',
  pretendToBeVisual: true,
  runScripts: 'outside-only',
})
const { window } = dom

// jsdom 未实现 canvas。返回一个"万能"假上下文：方法全是 noop、属性可读写，
// 这样特效引擎（包括自定义 JS 动效）能在测试里真正跑进绘制路径。
// 返回 null 的话 frame() 会在第一行 return，自定义代码永远执行不到 —— 那部分就成了盲区。
window.HTMLCanvasElement.prototype.getContext = () =>
  new Proxy(
    {},
    {
      get(t, k) {
        if (k === 'createLinearGradient') return () => ({ addColorStop() {} })
        if (k in t) return t[k]
        return () => {}
      },
      set(t, k, v) {
        t[k] = v
        return true
      },
    }
  )

let narrow = false
// 真实浏览器的 MediaQueryList.matches 是实时更新的，必须用 getter，
// 否则模块加载时创建的那一个 MQL 会把结果固化住。
window.matchMedia = (q) => {
  const mql = {
    media: q,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  }
  Object.defineProperty(mql, 'matches', {
    get: () => narrow && /max-width:\s*860px/.test(q),
  })
  return mql
}

const setGlobal = (k, v) => {
  try {
    globalThis[k] = v
  } catch {
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true })
  }
}
setGlobal('window', window)
setGlobal('document', window.document)
setGlobal('navigator', window.navigator)
setGlobal('location', window.location)
setGlobal('localStorage', window.localStorage)
setGlobal('HTMLElement', window.HTMLElement)
setGlobal('CustomEvent', window.CustomEvent)
setGlobal('Event', window.Event)
// 被测模块里的 new AbortController() 会解析到 Node realm 的实现，
// 而 jsdom 的 addEventListener({signal}) 只认自己 realm 的 AbortSignal —— 跨 realm 会抛
// TypeError，且只在使用 signal 的代码路径上暴露（如设置面板的监听器）。
setGlobal('AbortController', window.AbortController)
setGlobal('AbortSignal', window.AbortSignal)
setGlobal('getComputedStyle', window.getComputedStyle.bind(window))
setGlobal('requestAnimationFrame', (cb) => setTimeout(() => cb(performance.now()), 16))
setGlobal('cancelAnimationFrame', (id) => clearTimeout(id))

// ---------- 3) 假 SDK（结构对齐真实契约，不发请求）
const anyChain = (result) => {
  const p = Promise.resolve(result)
  const base = { then: p.then.bind(p), catch: p.catch.bind(p), finally: p.finally.bind(p) }
  return new Proxy(base, { get: (t, k) => (k in t ? t[k] : () => anyChain(result)) })
}
const empty = { data: [], error: null }
const now = new Date().toISOString()
const entryRow = {
  id: 1,
  raw_text: '把收件箱改成侧栏布局',
  title: '收件箱改成侧栏布局',
  kind: 'todo',
  summary: '把顶部横排菜单换成竖向侧栏，位置可配置',
  key_points: ['侧栏位置可切换'],
  action_items: ['写完响应式断点'],
  tags: ['前端'],
  status: 'inbox',
  priority: 'normal',
  due_date: null,
  ai_state: 'done',
  created_at: now,
  updated_at: now,
}
// 偏好表做成"能记住写入"的。若当成空表，savePreferences 每次都会抛
// "设置未能保存到云端" —— 保存这条路径就成了测试盲区（AI 设置尤其要验这个）。
let prefsRow = null
const prefsFrom = () => {
  const p = Promise.resolve({ data: prefsRow ? [prefsRow] : [], error: null })
  const base = { then: p.then.bind(p), catch: p.catch.bind(p), finally: p.finally.bind(p) }
  return new Proxy(base, {
    get(t, k) {
      if (k in t) return t[k]
      if (k === 'upsert') {
        return (row) => {
          window.__prefsWrite = row
          prefsRow = { id: 1, ...(prefsRow || {}), ...row }
          return prefsFrom()
        }
      }
      return () => prefsFrom()
    },
  })
}

window.WorkBuddyCloud = {
  createWorkBuddyCloud: () => ({
    config: {},
    auth: {
      getSession: async () => ({ data: { user: { email: 'tester@example.com' } }, error: null }),
      onAuthStateChange: () => () => {},
      signOut: async () => ({ error: null }),
      signInWithPassword: async () => ({ data: null, error: { message: 'stub' } }),
      sendOtp: async () => ({ data: { verificationId: 'v1', isExistingUser: false }, error: null }),
      signInWithOtp: async () => ({ data: { verify: async () => ({ data: {}, error: null }) }, error: null }),
      verifyOtp: async () => ({ data: {}, error: null }),
      resetPasswordForEmail: async () => ({ data: { updateUser: async () => ({}) }, error: null }),
    },
    database: {
      from: (table) => {
        if (table === 'entries') return anyChain({ data: [entryRow], error: null })
        if (table === 'preferences') return prefsFrom()
        return anyChain(empty)
      },
      rpc: () => anyChain(empty),
    },
    llm: {
      // 模型目录给两个可用 + 一个停用：设置面板要能验"停用的不出现"
      models: {
        list: async () => [
          { id: 'wb-fast', provider: '内置' },
          { id: 'wb-strong', provider: '内置' },
          { id: 'wb-retired', provider: '内置', disabled: true },
        ],
      },
      chat: { completions: { create: async function* () {} } },
    },
  }),
}

// ---------- 4) 加载被测应用
const errors = []
window.addEventListener('error', (e) => errors.push(String(e.message)))
await import(pathToFileURL(path.join(TMP, 'app.mjs')).href)
// 与 app 用的是同一份模块实例（同 URL 单例），状态共享。
// 必须在末尾删掉 TMP 之前取到引用，否则后面 import 会找不到文件。
const fxMod = await import(pathToFileURL(path.join(TMP, 'effects.mjs')).href)
const settingsMod = await import(pathToFileURL(path.join(TMP, 'settings.mjs')).href)
const aiMod = await import(pathToFileURL(path.join(TMP, 'ai.mjs')).href)
await new Promise((r) => setTimeout(r, 400))

// ---------- 5) 断言
let fail = 0
const $ = (s) => window.document.querySelector(s)
const $$ = (s) => Array.from(window.document.querySelectorAll(s))
const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
const key = (k) => window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true }))
const ok = (cond, name, extra = '') => {
  if (cond) console.log('  PASS ', name)
  else {
    fail++
    console.log('  FAIL ', name, extra)
  }
}

console.log('\n[1] 启动')
ok(errors.length === 0, '模块加载与顶层执行无异常', errors.join(' | '))
ok(!$('#app-view').classList.contains('hidden'), '已进入主界面')
ok($('#auth-view').classList.contains('hidden'), '登录页已隐藏')
ok($('#user-chip').textContent.includes('tester'), '账号已显示', $('#user-chip').textContent)
ok($$('#view-inbox .entry').length === 1, '列表渲染出 1 条记录', String($$('#view-inbox .entry').length))
ok($('#main-content').getAttribute('aria-busy') === 'false', '加载完成后 aria-busy=false')

console.log('\n[2] 视图切换')
const todoTab = $('#tabs [data-view="todo"]')
click(todoTab)
ok(!$('#view-todo').classList.contains('hidden'), '切到待办视图')
ok($('#view-inbox').classList.contains('hidden'), '收件箱已隐藏')
ok(todoTab.getAttribute('aria-current') === 'page', 'aria-current 落在当前项')
ok($('#tabs [data-view="inbox"]').getAttribute('aria-current') === null, '离开的项已清除 aria-current')

console.log('\n[3] 条目详情与滚动锁')
click($$('#view-todo .entry')[0])
ok(!$('#drawer').classList.contains('hidden'), '抽屉已打开')
ok(window.document.body.classList.contains('has-overlay'), '背景滚动已锁定')
ok($('#drawer').getAttribute('aria-modal') === 'true', '抽屉带 aria-modal')
ok($('#app-view').inert === true, '背景已置为 inert（焦点陷阱）')

console.log('\n[4] 撤销式删除')
click($('#drawer [data-act="delete-entry"]'))
ok($$('#view-todo .entry').length === 0, '条目已从列表移除')
ok($('#drawer').classList.contains('hidden'), '抽屉已关闭')
ok(!window.document.body.classList.contains('has-overlay'), '滚动锁已释放')
ok($('#app-view').inert === false, 'inert 已解除')
const undoBtn = $('.toast-action')
ok(!!undoBtn && undoBtn.textContent === '撤销', '出现「撤销」按钮')
click(undoBtn)
ok($$('#view-todo .entry').length === 1, '撤销后条目回到列表')

console.log('\n[5] 键盘快捷键')
key('/')
ok(window.document.activeElement === $('#global-search'), '/ 聚焦搜索框')
key('n')
ok(window.document.activeElement === $('#capture-input'), 'n 聚焦随手记')

console.log('\n[6] 窄屏导航抽屉')
narrow = true
click($('#nav-toggle'))
ok(window.document.body.classList.contains('nav-open'), '汉堡按钮打开侧栏抽屉')
ok($('#nav-toggle').getAttribute('aria-expanded') === 'true', 'aria-expanded=true')
ok(!$('#sidebar-scrim').hidden, '遮罩已显示')
ok(window.document.body.classList.contains('has-overlay'), '滚动已锁')
click($('#sidebar-scrim'))
ok(!window.document.body.classList.contains('nav-open'), '点遮罩关闭抽屉')
ok($('#nav-toggle').getAttribute('aria-expanded') === 'false', 'aria-expanded=false')

console.log('\n[6b] 三栏结构：右栏随手记')
ok($('#capture-input') !== null && $('#capture-input').closest('#compose-rail') !== null, '随手记输入框位于右栏内')
ok($('#capture-input').closest('.sidebar') === null, '随手记已不在左菜单栏里（三栏拆分正确）')
click($('#rail-toggle'))
ok(window.document.body.classList.contains('rail-open'), '＋ 按钮打开右栏抽屉')
await new Promise((r) => setTimeout(r, 420))
ok(window.document.activeElement === $('#capture-input'), '打开后自动聚焦输入框')
ok(!$('#sidebar-scrim').hidden, '遮罩已显示')
// 两个抽屉互斥
click($('#nav-toggle'))
ok(window.document.body.classList.contains('nav-open'), '左抽屉已打开')
ok(!window.document.body.classList.contains('rail-open'), '打开左抽屉时右抽屉自动收起')
ok($('#rail-toggle').getAttribute('aria-expanded') === 'false', '右抽屉按钮状态已复位')
key('Escape')
ok(!window.document.body.classList.contains('nav-open'), 'Esc 关闭左抽屉')

console.log('\n[7] Escape 关闭浮层')
click($('#nav-toggle'))
key('Escape')
ok(!window.document.body.classList.contains('nav-open'), 'Esc 关闭导航抽屉')
click($$('#view-todo .entry')[0])
key('Escape')
ok($('#drawer').classList.contains('hidden'), 'Esc 关闭详情抽屉')

fs.rmSync(TMP, { recursive: true, force: true })
console.log('\n[8] 拖拽导入 .md')
{
  const rail = $('#compose-rail')
  const hint = $('#rail-drop-hint')
  ok(!!hint, '存在拖拽提示层')

  // 显隐走 .show 类。不能断言 hidden 属性 —— 属性对了，CSS 也可能让它照常显示：
  // 作者的 display:grid 会盖掉 UA 的 [hidden]{display:none}，那正是这层蓝色罩层
  // 「关不掉」的真正原因。断言真正决定渲染的那个开关。
  const shown = () => hint.classList.contains('show')
  ok(!shown(), '提示层默认不显示')
  ok(!hint.hasAttribute('hidden'), '提示层不依赖 hidden 属性（避免 !important 与 .show 打架）')

  // jsdom 的事件不带 dataTransfer，手动挂一个
  const mkDrag = (type) => {
    const e = new window.Event(type, { bubbles: true, cancelable: true })
    Object.defineProperty(e, 'dataTransfer', { value: { types: ['Files'], files: [], dropEffect: '' } })
    return e
  }

  rail.dispatchEvent(mkDrag('dragenter'))
  ok(rail.classList.contains('drag-over'), '拖入右栏时进入拖拽态')
  ok(shown(), '拖拽时提示层显示')

  rail.dispatchEvent(mkDrag('dragleave'))
  ok(!rail.classList.contains('drag-over'), '拖离后拖拽态清除')
  ok(!shown(), '提示层重新隐藏')

  // 非文件拖拽（如选中文字）不应触发
  const textDrag = new window.Event('dragenter', { bubbles: true, cancelable: true })
  Object.defineProperty(textDrag, 'dataTransfer', { value: { types: ['text/plain'], files: [] } })
  rail.dispatchEvent(textDrag)
  ok(!rail.classList.contains('drag-over'), '拖动文本时不进入拖拽态')
  ok(!shown(), '拖动文本时提示层不出现')

  // 回归：部分浏览器的 dragleave 取不到 dataTransfer.types，
  // 早先的实现用 hasFiles 判断，导致计数只增不减、高亮永远卡在界面上
  rail.dispatchEvent(mkDrag('dragenter'))
  ok(rail.classList.contains('drag-over'), '再次拖入进入拖拽态')
  const emptyLeave = new window.Event('dragleave', { bubbles: true })
  Object.defineProperty(emptyLeave, 'dataTransfer', { value: { types: [] } })
  rail.dispatchEvent(emptyLeave)
  ok(!rail.classList.contains('drag-over'), 'dragleave 取不到 types 时也能收起高亮')
  ok(!shown(), '提示层同步收起')
}

console.log('\n[9] 右下角账号区')
{
  const corner = $('.corner-actions')
  ok(!!corner, '存在右下角账号区')
  ok(corner.querySelector('#btn-settings') !== null, '设置按钮在角落区里')
  ok(corner.querySelector('#btn-logout') !== null, '退出按钮在角落区里')
  ok($('#user-chip').closest('.sidebar') === null, '账号区已不在左侧胶囊内')
}

console.log('\n[10] 个性设置：特效预览与滑杆联动')
{
  $('#btn-settings').click()
  const panel = $('#settings-panel')
  ok(!panel.classList.contains('hidden'), '面板已打开')

  const cards = panel.querySelectorAll('.fx-card')
  ok(cards.length === 7, `七种特效卡片（含自定义，实际 ${cards.length}）`)
  ok(panel.querySelectorAll('.fx-demo').length === 7, '每张卡都带预览带')
  ok([...cards].every((c) => c.querySelector('.fx-demo i')), '预览带内有动画元素')

  const pressed = [...cards].filter((c) => c.getAttribute('aria-pressed') === 'true')
  ok(pressed.length === 1, '恰好一张卡处于选中态（aria-pressed）')

  const intensity = panel.querySelector('[data-set="intensity"]')
  const speed = panel.querySelector('[data-set="speed"]')
  ok(intensity.disabled && speed.disabled, '「无」特效时密度/速度被禁用')
  ok(intensity.closest('.set-row').classList.contains('is-disabled'), '禁用行已整行淡化')

  panel.querySelector('[data-fx="stars"]').click()
  ok(!intensity.disabled && !speed.disabled, '切到星空后滑杆恢复可用')
  ok(!intensity.closest('.set-row').classList.contains('is-disabled'), '淡化已解除')
  ok(
    panel.querySelector('[data-fx="stars"]').getAttribute('aria-pressed') === 'true',
    'aria-pressed 跟随切换'
  )

  panel.querySelector('[data-fx="none"]').click()
  ok(intensity.disabled, '切回「无」后滑杆再次禁用')

  panel.querySelector('[data-set-act="close"]').click()
  ok(panel.classList.contains('hidden'), '面板已关闭')
}

console.log('\n[11] 自定义 JS 动效')
{
  const fx = fxMod
  const { CUSTOM_SAMPLE } = settingsMod
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  // --- 编译期 ---
  ok(fx.compileCustom('fx.ctx.fillRect(0,0,1,1)').ok, '合法代码编译成功')
  ok(fx.customEffectError() === '', '编译成功后无错误')
  const bad = fx.compileCustom('fx.ctx.fillRect(((')
  ok(bad.ok === false && String(bad.error).length > 0, '语法错误被捕获且带原因')
  ok(fx.compileCustom('x'.repeat(fx.CUSTOM_LIMITS.maxCode + 1)).ok === false, '超长代码被拒绝')
  ok(fx.compileCustom('').ok, '空代码视为未启用（不算错误）')
  const sample = fx.compileCustom(CUSTOM_SAMPLE)
  ok(sample.ok, `内置示例可编译（${sample.error || 'ok'}）`)

  // --- 运行期：重新初始化，拿到非 null 的上下文 ---
  fx.initEffects(document.getElementById('fx-layer'))

  let failed = null
  const onFail = (e) => { failed = (e.detail && e.detail.reason) || '' }
  document.addEventListener('fx-custom-failed', onFail)

  // ① 正常代码应当每帧执行
  window.__customTicks = 0
  fx.setEffect({ type: 'custom', intensity: 1, speed: 1, custom: { code: 'window.__customTicks++' } })
  await sleep(120)
  ok(window.__customTicks > 0, `自定义代码在每帧执行（跑了 ${window.__customTicks} 帧）`)

  // ② 运行期抛错：连续出错达到上限后广播停用，且不向外抛（不炸调用方）
  window.__customTicks = 0
  fx.setEffect({ type: 'custom', intensity: 1, speed: 1, custom: { code: 'throw new Error("boom")' } })
  await sleep(160)
  ok(failed !== null, '连续运行出错后广播停用事件')
  ok(fx.customEffectError() !== '', '并记录停用原因')
  ok(window.__customTicks === 0, '出错代码没有留下副作用')

  document.removeEventListener('fx-custom-failed', onFail)
  fx.setEffect({ type: 'none', intensity: 1, speed: 1 })

  // --- 面板里的代码区 ---
  $('#btn-settings').click()
  const p = $('#settings-panel')
  const box = p.querySelector('[data-fx-code]')
  ok(!!box, '存在自定义代码区')
  ok(box.classList.contains('is-off'), '未选自定义时代码区隐藏')

  p.querySelector('[data-fx="custom"]').click()
  ok(!box.classList.contains('is-off'), '选「自定义」后代码区出现')

  const area = p.querySelector('[data-set="customCode"]')
  p.querySelector('[data-set-act="sample"]').click()
  ok(area.value.includes('fx.ctx'), '「填入示例」可用')

  // 回归：sync() 曾把 customCode 当作 effect.customCode（undefined）写回 textarea，
  // 用户敲到一半的代码会被清空
  p.querySelector('[data-fx="custom"]').click()
  ok(area.value.includes('fx.ctx'), '再次 sync 后代码仍在（不会被清空）')

  p.querySelector('[data-set-act="close"]').click()
  ok(p.classList.contains('hidden'), '面板已关闭')
}

console.log('\n[12] 筛选栏的滑动指示器')
{
  // jsdom 没有布局引擎，getBoundingClientRect 恒为 0 —— 那样指示器的位置永远算成 0，
  // 这段逻辑就等于没测。给它一个假布局：同一行里的 chip 依次横向排开，宽 60、间距 14。
  const CHIP_W = 60
  const GAP = 14
  const zero = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 }
  window.Element.prototype.getBoundingClientRect = function () {
    if (!this.classList || !this.classList.contains('chip')) return zero
    const sibs = Array.from(this.parentElement.children).filter((c) => c.classList.contains('chip'))
    const i = sibs.indexOf(this)
    const left = i * (CHIP_W + GAP)
    return { left, top: 0, right: left + CHIP_W, bottom: 20, width: CHIP_W, height: 20, x: left, y: 0 }
  }

  const frame = () => new Promise((r) => setTimeout(r, 40))
  const inkX = (group) => {
    const ink = $(`#view-inbox [data-ink="${group}"] .filter-ink`)
    const m = /translate3d\((-?[\d.]+)px/.exec(ink.style.transform || '')
    return m ? Number(m[1]) : null
  }
  const pick = async (kind) => {
    $(`#view-inbox [data-kind="${kind}"]`).click()
    await frame()
  }

  // 先回到收件箱：前面的用例把视图留在了待办，那样点收件箱的 chip 只会重渲染待办页
  $('#tabs [data-view="inbox"]').click()
  await frame()

  const kindRow = $('#view-inbox [data-ink="kind"]')
  const scopeRow = $('#view-inbox [data-ink="scope"]')
  ok(!!kindRow?.querySelector('.filter-ink'), '分类组有指示器')
  ok(!!scopeRow?.querySelector('.filter-ink'), '状态组有指示器')
  ok(kindRow.querySelectorAll('.chip').length === 6, '分类组六个栏目')

  await frame()
  ok(inkX('kind') === 0, `初始指示器贴在「全部」下（x=${inkX('kind')}）`)

  await pick('idea')
  ok(inkX('kind') === CHIP_W + GAP, `切到「想法」后指示器右移一格（x=${inkX('kind')}）`)
  ok(
    $('#view-inbox [data-kind="idea"]').classList.contains('active'),
    'active 已落到「想法」'
  )
  ok(
    !$('#view-inbox [data-kind="all"]').classList.contains('active'),
    '「全部」已摘掉 active'
  )

  await pick('todo')
  ok(inkX('kind') === 3 * (CHIP_W + GAP), `切到「待办」后继续右移（x=${inkX('kind')}）`)

  // 回到第一个：指示器要能反向滑动，而不是重置
  await pick('all')
  ok(inkX('kind') === 0, '回到「全部」时反向滑回原位')

  // 两组互不干扰
  const scopeBefore = inkX('scope')
  await pick('key')
  ok(inkX('scope') === scopeBefore, '动分类组不会带偏状态组')

  // 状态组自身也要跟着走
  $('#view-inbox [data-scope="done"]').click()
  await frame()
  ok(inkX('scope') === CHIP_W + GAP, `状态组指示器独立移动（x=${inkX('scope')}）`)

  // 切换筛选要触发列表位移淡入
  $('#view-inbox [data-kind="note"]').click()
  await frame()
  ok(
    ($('#view-inbox .list') || $('#view-inbox .empty')).classList.contains('is-swapping'),
    '切换筛选后列表带位移淡入'
  )

  // 重复点同一项不该重建列表 —— 元素不重建，动画自然不会重播
  const before = $('#view-inbox .list') || $('#view-inbox .empty')
  $('#view-inbox [data-kind="note"]').click()
  await frame()
  ok(before === ($('#view-inbox .list') || $('#view-inbox .empty')), '重复点同一项不重建列表')

  // 切到别的视图再回来，指示器不该从别的页面的位置滑过来（应直接贴合）
  // 此刻筛选是「随记」，在六个栏目里排第 5（下标 4）
  const KINDS = ['all', 'idea', 'material', 'todo', 'note', 'key']
  const expected = KINDS.indexOf('note') * (CHIP_W + GAP)
  $('#tabs [data-view="todo"]').click()
  await frame()
  $('#tabs [data-view="inbox"]').click()
  await frame()
  ok(inkX('kind') === expected, `跨视图返回后直接贴合当前位置（x=${inkX('kind')}，应为 ${expected}）`)
}

console.log('\n[13] 悬浮方块的上下拖动与磁吸')
{
  narrow = false // 前面抽屉用例留下的窄屏开关：窄屏是抽屉，拖动会直接跳过
  const nav = $('#sidebar')
  const rail = $('#compose-rail')
  ok(!!nav?.querySelector('[data-grip="sidebar"]'), '导航栏有拖动手柄')
  ok(!!rail?.querySelector('[data-grip="rail"]'), '随手记有拖动手柄')

  // jsdom 没有布局，offsetHeight 恒为 0 —— 那会让"中心点"和"顶边"两种算法算出同一个数，
  // 几何错误完全测不出来。给个真实高度，断言才有意义。
  const H = 320
  Object.defineProperty(nav, 'offsetHeight', { value: H, configurable: true })
  const G = 16
  const MIN = G + H / 2 // 中心点下限：顶边刚好贴到上边距
  const MAX = window.innerHeight - G - H / 2 // 中心点上限：底边刚好贴到下边距
  const MID = window.innerHeight / 2

  const grip = nav.querySelector('[data-grip="sidebar"]')
  const top = () => parseFloat(nav.style.top)
  const pointer = (type, clientY) => {
    const e = new window.Event(type, { bubbles: true, cancelable: true })
    Object.defineProperty(e, 'clientY', { value: clientY })
    Object.defineProperty(e, 'button', { value: 0 })
    Object.defineProperty(e, 'pointerId', { value: 1 })
    return e
  }
  const drag = (to) => {
    grip.dispatchEvent(pointer('pointerdown', 300))
    grip.dispatchEvent(pointer('pointermove', to))
    grip.dispatchEvent(pointer('pointerup', to))
  }

  // 拖到中间偏上：应吸附到最近档位
  drag(60)
  ok(Number.isFinite(top()), '拖动后写入了 top')
  const afterTop = top()
  // 贴顶 = 中心点在下限上；若按"顶边"算会得到 G（方块上半截被顶出视口）
  ok(afterTop === MIN, `贴顶时顶边刚好贴合上边距（top=${afterTop}，应为 ${MIN}）`)
  ok(!nav.classList.contains('dragging'), '松手后清除拖动态')

  // 位置要落盘，刷新后还在
  const saved = JSON.parse(localStorage.getItem('pma.floatPos') || '{}')
  ok(saved.sidebar === MIN, '位置已写入 localStorage')

  // 拖到底部：应吸附到贴底（dy 要足够大，否则会吸附到居中档）
  drag(1100)
  ok(
    top() === MAX,
    `贴底时底边刚好贴合下边距（top=${top()}，应为 ${MAX}，视口 ${window.innerHeight}）`
  )

  // 不会被拖出视口
  drag(-500)
  ok(top() === MIN, `不会拖到负位置（top=${top()}）`)

  // Home 回正中：中心点应落在视口中线
  const keydown = new window.KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true })
  grip.dispatchEvent(keydown)
  ok(top() === MID, `Home 回到视口中线（top=${top()}，应为 ${MID}）`)

  // 拖动起点必须是中心点，取 rect.top 会在按下瞬间跳半个方块
  grip.dispatchEvent(pointer('pointerdown', 300))
  grip.dispatchEvent(pointer('pointermove', 310)) // dy = +10，越过 3px 抖动阈值
  ok(
    Math.abs(top() - (MID + 10)) < 1,
    `从中心点起算，按下不跳位（top=${top()}，应为 ${MID + 10}）`
  )
  grip.dispatchEvent(pointer('pointerup', 310))

  // ↑ 微调
  const before = top()
  grip.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }))
  ok(top() < before, '↑ 向上微调')

  // 窄屏（抽屉模式）不响应拖动
  narrow = true
  const railGrip = rail.querySelector('[data-grip="rail"]')
  const railTopBefore = rail.style.top || ''
  railGrip.dispatchEvent(pointer('pointerdown', 300))
  railGrip.dispatchEvent(pointer('pointermove', 500))
  railGrip.dispatchEvent(pointer('pointerup', 500))
  ok(rail.style.top === railTopBefore, '窄屏抽屉模式不响应拖动')
  narrow = false
}

console.log('\n[14] 键盘：上下切视图 / 左右切栏目')
{
  narrow = false
  const frame = () => new Promise((r) => setTimeout(r, 0))
  // 前面的用例会把视图和筛选留在任意状态，先归位再断言
  $('#tabs [data-view="inbox"]').click()
  await frame()
  $('#view-inbox [data-kind="all"]').click()
  await frame()

  const view = () => $('#tabs .side-tab.active')?.dataset.view
  const kind = () => $('#view-inbox [data-ink="kind"] .chip.active')?.dataset.kind
  const live = () => $('#key-live')?.textContent || ''
  const press = (key, target = document.body) => {
    const e = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
    target.dispatchEvent(e)
    return e
  }

  ok(view() === 'inbox', '起始在收件箱')

  // 上下：↓ 到待办，↑ 回收件箱
  press('ArrowDown')
  await frame()
  ok(view() === 'todo', `↓ 切到待办（当前 ${view()}）`)
  ok(live().includes('待办'), `切视图有播报（"${live()}"）`)
  press('ArrowUp')
  await frame()
  ok(view() === 'inbox', `↑ 回收件箱（当前 ${view()}）`)

  // 到头要能绕回另一端
  press('ArrowUp')
  await frame()
  ok(view() === 'review', `在首项按 ↑ 绕到末项（当前 ${view()}）`)
  press('ArrowDown')
  await frame()
  ok(view() === 'inbox', `在末项按 ↓ 绕回首项（当前 ${view()}）`)

  // 左右：在收件箱切分类栏目
  ok(kind() === 'all', '分类起始在「全部」')
  press('ArrowRight')
  await frame()
  ok(kind() === 'idea', `→ 切到「想法」（当前 ${kind()}）`)
  // 播报要去掉 emoji，否则读屏会念出"灯泡 想法"之类的
  ok(live() === '栏目：想法', `切栏目播报不含 emoji（"${live()}"）`)
  press('ArrowLeft')
  await frame()
  ok(kind() === 'all', `← 回到「全部」（当前 ${kind()}）`)

  // 分类到头绕回
  press('ArrowLeft')
  await frame()
  ok(kind() === 'key', `在首项按 ← 绕到末项「重点」（当前 ${kind()}）`)
  $('#view-inbox [data-kind="all"]').click()
  await frame()

  // 待办页没有筛选栏 → 左右键不该被接管（不 preventDefault，留给页面）
  $('#tabs [data-view="todo"]').click()
  await frame()
  const eTodo = press('ArrowRight')
  ok(!eTodo.defaultPrevented, '待办页无筛选栏时左右键不被接管')
  $('#tabs [data-view="inbox"]').click()
  await frame()

  // 输入框里方向键要留给光标移动，不能切视图
  const search = $('#global-search')
  search.focus()
  const eInput = press('ArrowDown', search)
  ok(view() === 'inbox', '输入框内 ↓ 不切视图')
  ok(!eInput.defaultPrevented, '输入框内方向键不被接管')
  search.blur()

  // 手柄聚焦时上下键是调位置的，不能同时切视图
  const grip = $('#sidebar [data-grip="sidebar"]')
  grip.focus()
  press('ArrowDown', grip)
  await frame()
  ok(view() === 'inbox', '手柄聚焦时 ↓ 不切视图')
  grip.blur()

  // 浮层打开时键盘导航要让路
  document.body.classList.add('nav-open')
  press('ArrowDown')
  await frame()
  ok(view() === 'inbox', '抽屉打开时不切视图')
  document.body.classList.remove('nav-open')

  $('#settings-panel').classList.remove('hidden')
  press('ArrowDown')
  await frame()
  ok(view() === 'inbox', '设置面板打开时不切视图')
  $('#settings-panel').classList.add('hidden')

  const mask = document.createElement('div')
  mask.className = 'modal-mask'
  document.body.appendChild(mask)
  press('ArrowDown')
  await frame()
  ok(view() === 'inbox', '模态框打开时不切视图')
  mask.remove()

  // 修饰键组合（如 Cmd+↓）不该触发
  const eMod = new window.KeyboardEvent('keydown', {
    key: 'ArrowDown',
    metaKey: true,
    bubbles: true,
    cancelable: true,
  })
  document.body.dispatchEvent(eMod)
  await frame()
  ok(view() === 'inbox', '带修饰键的方向键不切视图')
}

console.log('\n[15] AI 模型设置')
{
  const frame = () => new Promise((r) => setTimeout(r, 0))
  const panel = $('#settings-panel')
  // openSettings 见到面板已经打开会直接返回，所以先确保它是关的
  if (!panel.classList.contains('hidden')) {
    panel.querySelector('[data-set-act="close"]').click()
    await frame()
  }
  $('#btn-settings').click()
  await frame()
  await frame()

  const modeTabs = panel.querySelectorAll('[data-ai-mode]')
  ok(modeTabs.length === 2, `模型来源两个选项（实际 ${modeTabs.length}）`)

  // 云服务模式：目录里停用的模型不该出现
  const names = Array.from(panel.querySelectorAll('[data-ai-model]')).map(
    (b) => b.dataset.aiModel
  )
  ok(names.includes(''), '列表含「自动」项')
  ok(names.includes('wb-fast') && names.includes('wb-strong'), '列出可用模型')
  ok(!names.includes('wb-retired'), '停用的模型不出现在列表里')
  ok(
    panel.querySelector('[data-ai-mode="cloud"]').classList.contains('active'),
    '默认在云服务模式'
  )

  // 选一个具体模型 → 写进设置并落盘
  panel.querySelector('[data-ai-model="wb-strong"]').click()
  await frame()
  ok(
    panel.querySelector('[data-ai-model="wb-strong"]').classList.contains('active'),
    '选中的模型被标记'
  )
  await new Promise((r) => setTimeout(r, 900)) // 等防抖保存
  const saved = window.__prefsWrite || {}
  ok(!!saved.ai, '设置里带上了 ai 配置')
  ok(saved.ai && saved.ai.modelId === 'wb-strong', `选中的模型已写入（${saved.ai && saved.ai.modelId}）`)

  // 手填一个目录外的 ID 也要能用
  const manual = panel.querySelector('[data-set="ai.modelId"]')
  manual.value = 'my-own-model'
  manual.dispatchEvent(new window.Event('input', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 900))
  ok(
    (window.__prefsWrite.ai || {}).modelId === 'my-own-model',
    `手填模型 ID 被接受（${(window.__prefsWrite.ai || {}).modelId}）`
  )
  manual.value = ''
  manual.dispatchEvent(new window.Event('input', { bubbles: true }))
  await frame()

  // 切到自定义接口
  panel.querySelector('[data-ai-mode="custom"]').click()
  await frame()
  ok(
    panel.querySelector('[data-ai-pane="custom"]').className.indexOf('is-off') < 0,
    '自定义面板展开'
  )
  ok(
    panel.querySelector('[data-ai-pane="cloud"]').className.indexOf('is-off') >= 0,
    '云服务面板收起'
  )
  ok(
    panel.querySelector('[data-ai-mode="custom"]').getAttribute('aria-selected') === 'true',
    '模式切换同步了 aria-selected'
  )

  // 配不齐时要明确说缺什么，而不是静默失败
  let status = panel.querySelector('[data-ai-custom-status]').textContent
  ok(status.indexOf('接口地址') >= 0, `缺地址时提示准确（"${status}"）`)

  const fill = (selector, value) => {
    const el = panel.querySelector(selector)
    el.value = value
    el.dispatchEvent(new window.Event('input', { bubbles: true }))
  }
  fill('[data-set="ai.custom.baseUrl"]', 'https://api.example.com/v1')
  await frame()
  status = panel.querySelector('[data-ai-custom-status]').textContent
  ok(status.indexOf('API Key') >= 0, `缺密钥时提示准确（"${status}"）`)

  fill('[data-set="ai.custom.apiKey"]', 'sk-test-123')
  await frame()
  status = panel.querySelector('[data-ai-custom-status]').textContent
  ok(status.indexOf('模型名') >= 0, `缺模型名时提示准确（"${status}"）`)

  fill('[data-set="ai.custom.model"]', 'deepseek-chat')
  await frame()
  status = panel.querySelector('[data-ai-custom-status]').textContent
  ok(status.indexOf('配置完整') >= 0, `配齐后提示完成（"${status}"）`)

  // 非法地址要被拦住
  fill('[data-set="ai.custom.baseUrl"]', 'javascript:alert(1)')
  await frame()
  status = panel.querySelector('[data-ai-custom-status]').textContent
  ok(status.indexOf('http') >= 0, `非 http(s) 地址被拒（"${status}"）`)
  fill('[data-set="ai.custom.baseUrl"]', 'https://api.example.com/v1')
  await frame()

  // 尾斜杠会被规范化掉，避免拼出 //chat/completions
  fill('[data-set="ai.custom.baseUrl"]', 'https://api.example.com/v1/')
  await new Promise((r) => setTimeout(r, 900))
  const c = (window.__prefsWrite.ai || {}).custom || {}
  ok(c.baseUrl === 'https://api.example.com/v1', `地址尾斜杠被规范化（${c.baseUrl}）`)
  ok(c.apiKey === 'sk-test-123', '密钥随设置保存')
  ok(c.model === 'deepseek-chat', '模型名随设置保存')

  // 生成参数
  const temp = panel.querySelector('[data-set="ai.temperature"]')
  temp.value = '0.3'
  temp.dispatchEvent(new window.Event('input', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 900))
  ok((window.__prefsWrite.ai || {}).temperature === 0.3, '温度被保存')
  const maxt = panel.querySelector('[data-set="ai.maxTokens"]')
  maxt.value = '1024'
  maxt.dispatchEvent(new window.Event('input', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 900))
  ok((window.__prefsWrite.ai || {}).maxTokens === 1024, '最大长度被保存')

  // 越界值要被夹紧，而不是原样写进设置
  const norm = settingsMod.normalizeSettings({
    ai: { mode: 'custom', temperature: 99, maxTokens: 999999, custom: { baseUrl: 'https://a.com/' } },
  })
  ok(norm.ai.temperature === 2, `温度越界被夹到上限（${norm.ai.temperature}）`)
  ok(norm.ai.maxTokens === 32000, `最大长度越界被夹到上限（${norm.ai.maxTokens}）`)
  ok(norm.ai.custom.baseUrl === 'https://a.com', '规范化时也去掉尾斜杠')
  ok(norm.ai.mode === 'custom', '自定义模式被保留')

  // 非法 mode 要回退到云服务，避免出现第三个分支
  const bad = settingsMod.normalizeSettings({ ai: { mode: 'evil' } })
  ok(bad.ai.mode === 'cloud', `非法模式回退到云服务（${bad.ai.mode}）`)

  // normalizeSettings 不能把 ai 弄丢 —— 它决定了设置能不能存下来
  const full = settingsMod.normalizeSettings({ theme: {}, effect: {}, ai: { modelId: 'x' } })
  ok(full.ai && full.ai.modelId === 'x', 'normalizeSettings 保留 ai 字段')
  // 切主题预设也不能把模型设置冲掉
  const preset = settingsMod.applyPreset(full, 'ink')
  ok(preset.ai && preset.ai.modelId === 'x', '换主题预设不丢 AI 设置')

  // 本地缓存里不该留密钥
  const cacheRaw = window.localStorage.getItem('pma.settings.cache') || ''
  ok(cacheRaw.indexOf('sk-test-123') < 0, '本地缓存不含 API Key')
  ok(cacheRaw.indexOf('deepseek-chat') >= 0, '本地缓存仍有非敏感字段')

  // 关掉面板，别影响后续用例
  panel.querySelector('[data-set-act="close"]').click()
  await frame()
}

console.log('\n[16] 自定义模型的真实调用路径')
{
  const savedFetch = globalThis.fetch
  const enc = new TextEncoder()
  const sseRes = (parts, status = 200, ctype = 'text/event-stream') =>
    new Response(
      new ReadableStream({
        start(c) {
          for (const p of parts) c.enqueue(enc.encode(p))
          c.close()
        },
      }),
      { status, headers: { 'content-type': ctype } }
    )

  aiMod.useAiSettings({
    mode: 'custom',
    temperature: 0.5,
    maxTokens: 128,
    custom: { baseUrl: 'https://api.example.com/v1/', apiKey: 'sk-x', model: 'demo' },
  })

  let seenUrl = ''
  let seenBody = null
  let seenHeaders = null
  const deltas = []

  globalThis.fetch = async (url, init) => {
    seenUrl = String(url)
    seenBody = JSON.parse(init.body)
    seenHeaders = init.headers
    return sseRes([
      'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"好"}}]}\n\n',
      ': keep-alive\n\n', // 心跳行，必须被忽略
      'data: [DONE]\n\n',
    ])
  }

  const text = await aiMod.answerQuestion({
    question: '在吗',
    entries: [],
    onDelta: (d) => deltas.push(d),
  })
  ok(text === '你好', `SSE 分片被拼成完整文本（"${text}"）`)
  ok(deltas.join('') === '你好', '流式回调逐片触发')
  ok(seenUrl === 'https://api.example.com/v1/chat/completions', `地址拼接去掉尾斜杠（${seenUrl}）`)
  ok(seenBody.model === 'demo', '请求带上模型名')
  ok(seenBody.stream === true, '请求是流式的')
  ok(seenBody.temperature === 0.5, '请求带上温度')
  ok(seenBody.max_tokens === 128, '请求带上最大长度')
  ok(seenHeaders.Authorization === 'Bearer sk-x', '带上 Authorization 头')
  ok(seenHeaders['Content-Type'] === 'application/json', '带上 Content-Type')

  // 有些网关不转发流，返回一次性 JSON —— 也要能读
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: '直接返回' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  const t2 = await aiMod.answerQuestion({ question: 'x', entries: [] })
  ok(t2 === '直接返回', `非流式 JSON 响应也能读（"${t2}"）`)

  // 分片被任意切断时，跨 chunk 的 JSON 也要能拼回来
  globalThis.fetch = async () =>
    sseRes(['data: {"choices":[{"delta":{"con', 'tent":"跨片"}}]}\n', '\ndata: [DONE]\n\n'])
  const t3 = await aiMod.answerQuestion({ question: 'x', entries: [] })
  ok(t3 === '跨片', `跨 chunk 的分片能拼回（"${t3}"）`)

  // HTTP 错误要把状态码和原因带出来，不能只说"失败"
  globalThis.fetch = async () =>
    new Response('{"error":{"message":"invalid api key"}}', {
      status: 401,
      headers: { 'content-type': 'application/json' },
    })
  let err401 = ''
  try {
    await aiMod.answerQuestion({ question: 'x', entries: [] })
  } catch (e) {
    err401 = String(e.message)
  }
  ok(err401.indexOf('401') >= 0, `HTTP 错误带状态码（"${err401}"）`)
  ok(err401.indexOf('invalid api key') >= 0, 'HTTP 错误带服务端原因')

  // 网络/跨域失败：这个原因必须点明，否则用户只会看到"加载失败"
  globalThis.fetch = async () => {
    throw new TypeError('Failed to fetch')
  }
  let errNet = ''
  try {
    await aiMod.answerQuestion({ question: 'x', entries: [] })
  } catch (e) {
    errNet = String(e.message)
  }
  ok(errNet.indexOf('跨域') >= 0, `网络失败提示提到跨域（"${errNet}"）`)

  // 配置不全时不发请求，直接说缺什么
  let called = false
  globalThis.fetch = async () => {
    called = true
    return sseRes([])
  }
  aiMod.useAiSettings({ mode: 'custom', custom: { baseUrl: '', apiKey: '', model: '' } })
  let errCfg = ''
  try {
    await aiMod.answerQuestion({ question: 'x', entries: [] })
  } catch (e) {
    errCfg = String(e.message)
  }
  ok(errCfg.indexOf('自定义模型') >= 0, `配置不全时明确报错（"${errCfg}"）`)
  ok(!called, '配置不全时根本不发请求')

  globalThis.fetch = savedFetch
  aiMod.useAiSettings(null)
}

console.log(fail === 0 ? '\nALL DOM TESTS PASSED' : `\n${fail} DOM TEST(S) FAILED`)
process.exit(fail ? 1 : 0)
