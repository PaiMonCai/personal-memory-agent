/**
 * dom-test 入口：由 tools/dom-test.mjs 用 esbuild 打成单个 IIFE，在 jsdom 里执行。
 *
 * 两个职责：
 *  1. 挂载应用。这里刻意用 legacy 的 ReactDOM.render 而不是 createRoot ——
 *     测试用例里有大量「点击后立即断言 DOM」的写法，那是旧实现（同步渲染）的契约；
 *     createRoot 的并发调度会让断言读到上一帧的 DOM。
 *  2. 把 effects / settings / ai 三个模块单例挂到 window.__pma。
 *     测试直接调用它们（编译自定义动效、规范化设置、模拟自定义供应商），
 *     必须与页面用到的是同一份实例，否则两边状态各走各的。
 */
import { render } from 'react-dom'
import App from '../src/App'
import * as fx from '../src/lib/effects'
import * as settingsMod from '../src/lib/settings'
import * as aiMod from '../src/lib/ai'

declare global {
  interface Window {
    __pma?: {
      fx: typeof fx
      settings: typeof settingsMod
      ai: typeof aiMod
    }
  }
}

window.__pma = { fx, settings: settingsMod, ai: aiMod }

render(<App />, document.getElementById('root')!)
