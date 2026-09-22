#!/usr/bin/env python3
"""静态契约校验 —— 只做文本层面的断言，不渲染、不跑浏览器。

为什么要有它：React 测试断言的是「属性 / class / 状态」，而真正决定用户看到什么的是 CSS。
两者脱节就会漏 bug —— 例如靠 hidden 属性切换显隐的元素，属性设成 true 了，
但作者的 display:grid 盖掉 UA 的 [hidden]{display:none}，界面上照旧显示。
所以凡是「显隐」「布局」这类契约，必须在 CSS 文本层面再断言一次。

前端已迁移到 Vite + React + TypeScript：原来的 index.html + assets/js/*.js
对应现在的 src/**/*.tsx 与 src/**/*.ts。DOM 契约（id / class / data-*）原文不变，
只是换了载体，因此下面的来源做了如下映射：
  css    -> src/styles/app.css
  html   -> src 下全部 TS/TSX 拼接（DOM 契约写在组件里）
  app    -> 同上（旧 app.js 的职责由 store / hooks / App.tsx 分担）
  sjs    -> src/lib/settings.ts + src/components/SettingsPanel.tsx
  fxjs   -> src/lib/effects.ts
  ajs    -> src/lib/ai.ts
  api_js -> src/lib/api.ts
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
css = (ROOT / 'src' / 'styles' / 'app.css').read_text(encoding='utf-8')

# src 按路径排序拼接：App.tsx 在前，其后是 components / hooks / lib / state。
# 这样「sidebar 在 corner-actions 之前出现」这类顺序断言仍然成立。
_src_files = sorted(list((ROOT / 'src').rglob('*.ts')) + list((ROOT / 'src').rglob('*.tsx')))
src = '\n'.join(p.read_text(encoding='utf-8') for p in _src_files)

html = src
app = src

flat_css = re.sub(r'\s+', '', css)
flat_html = re.sub(r'\s+', '', html)

fails = []


def check(name, ok):
    if not ok:
        fails.append(name)
    print(('  OK   ' if ok else '  FAIL '), name)


def rule_block(selector):
    """取某个选择器的规则块（扁平化后），便于断言块内属性。"""
    i = flat_css.find(selector + '{')
    if i < 0:
        return ''
    depth = 0
    for j in range(i + len(selector), len(flat_css)):
        if flat_css[j] == '{':
            depth += 1
        elif flat_css[j] == '}':
            depth -= 1
            if depth == 0:
                return flat_css[i:j + 1]
    return ''


print('=== [A] 显隐契约（hidden 属性必须真的能藏住）===')
# UA 的 [hidden]{display:none} 优先级低于作者样式表，任何 display:flex/grid 都会盖掉它。
# 这条 !important 是唯一的通用防线。
m = re.search(r'\[hidden\]\s*\{[^}]*display\s*:\s*none\s*!important', flat_css)
check('全局 [hidden] 规则存在且带 !important', bool(m))
check('全局 [hidden] 规则位于文件靠前处（不被后续规则覆盖）',
      bool(m) and m.start() < flat_css.find(':root{'))

print()
print('=== [B] 拖拽提示层（曾经的蓝色罩层 bug）===')
hint_block = rule_block('.rail-drop-hint')
check('.rail-drop-hint 存在', bool(hint_block))
check('.rail-drop-hint 默认 display:none', 'display:none' in hint_block)
check('.rail-drop-hint 默认不是 flex/grid/块（会常驻显示）',
      not re.search(r'display:(flex|grid|block)', hint_block))
check('.rail-drop-hint.show 才显示', '.rail-drop-hint.show{display:grid;}' in flat_css)
check('JSX 上不带 hidden 属性（避免 !important 与 .show 打架）',
      'id="rail-drop-hint"hidden' not in flat_html and 'id="rail-drop-hint"' in flat_html)
rail_src = (ROOT / 'src' / 'components' / 'ComposeRail.tsx').read_text(encoding='utf-8')
check('拖拽提示层用 class 切换而非 hidden 属性',
      "classList.add('show')" in rail_src and "classList.remove('show')" in rail_src
      and '.hidden' not in rail_src)
check('拖拽态样式仍在', '.compose-rail.drag-over{' in flat_css)
check('dragleave 不判断文件类型（types 可能为空）',
      "rail.addEventListener('dragleave'" in app and 'if(!active.current)return' in re.sub(r'\s+', '', app))
check('空闲兜底计时存在', 'setTimeout(clear, 1200)' in app)

print()
print('=== [C] 顶栏搜索居中 ===')
check('顶栏 justify-content:center', 'justify-content:center' in rule_block('.topbar'))
check('搜索定宽 440（flex:1 会撑满，撑满就无从居中）', 'flex:01440px' in flat_css)
check('窄屏恢复两端对齐', 'justify-content:space-between' in flat_css)

print()
print('=== [D] 右下角账号区 ===')
ca = rule_block('.corner-actions')
check('.corner-actions 固定在右下角', 'position:fixed' in ca and 'right:var(--float-gap)' in ca and 'bottom:var(--float-gap)' in ca)
sidebar_src = (ROOT / 'src' / 'components' / 'Sidebar.tsx').read_text(encoding='utf-8')
app_src = (ROOT / 'src' / 'App.tsx').read_text(encoding='utf-8')
check('账号区已不在左侧胶囊内',
      'user-chip' not in sidebar_src and 'user-chip' in app_src and 'corner-actions' in app_src)
check('旧的 side-foot 已彻底移除', 'side-foot' not in css and 'side-foot' not in src)
check('窄屏改底部居中', 'left:50%;right:auto;bottom:12px;transform:translateX(-50%)' in flat_css)

print()
print('=== [E] 断点一致性 ===')
# 只取 @media 里的断点。普通规则里的 max-width（容器宽度之类）不算，
# 否则会把 1080 / 96 这种无关数值也捞进来。
css_bp = set(re.findall(r'@media[^{]*\(max-width:\s*(\d+)px\)', css))
js_bp = set(re.findall(r"matchMedia\('\(max-width:\s*(\d+)px\)'", app))
# CSS 可以有多档响应式（这里是调侧栏宽度的 1280/1080/940 与紧凑档 520）。
# 真正要防的是 JS 用的那一档在 CSS 里没有对应规则 —— 那会让抽屉与导航状态错乱。
check(f'JS 的断点在 CSS 中存在 (JS={sorted(js_bp)} CSS={sorted(css_bp)})',
      bool(js_bp) and js_bp <= css_bp)
# 配套的下界断点（悬浮磁吸只在宽屏启用）必须正好比上界大 1，否则中间会漏一档
min_bp = set(re.findall(r'@media[^{]*\(min-width:\s*(\d+)px\)', css))
check(f'min-width 断点均为 max-width+1 (max={sorted(css_bp)} min={sorted(min_bp)})',
      all(int(x) - 1 in {int(y) for y in css_bp} for x in min_bp))

print()
print('=== [F] CSS 变量完整性 ===')
defined = set(re.findall(r'^\s*(--[a-z0-9-]+)\s*:', css, re.M))
used = set(re.findall(r'var\((--[a-z0-9-]+)', css))
injected = {'--brand', '--brand-2', '--brand-soft', '--brand-line', '--brand-ring',
            '--brand-fg', '--bg-from', '--bg-to', '--bg-image', '--bg-blur',
            '--bg-dim', '--radius', '--radius-sm', '--fx-color'}
undef = sorted(used - defined - injected)
check(f'变量均已定义（未定义：{undef or "无"}）', not undef)
# 自引用（--x: var(--x)）是循环依赖，该变量整体失效。
# 浅色模式曾因此丢失 --surface-3 / --line-hover，hover 反馈全部失效。
selfref = re.findall(r'(^--[a-z0-9-]+)\s*:\s*var\(\1\)', css, re.M)
check(f'变量无自引用（{selfref or "无"}）', not selfref)
zbad = [z for z in re.findall(r'z-index:\s*(\d+)', css) if int(z) > 20]
check(f'无越界裸 z-index（{zbad or "无"}）', not zbad)

print()
print('=== [G] 特效设置与交互 ===')
sjs = re.sub(r'\s+', '', (ROOT / 'src' / 'lib' / 'settings.ts').read_text(encoding='utf-8')
             + (ROOT / 'src' / 'components' / 'SettingsPanel.tsx').read_text(encoding='utf-8'))
fjs = sjs  # 旧 settings.js 的职责由 settings.ts（数据/规范化）与 SettingsPanel.tsx（渲染）分担
check('浅色 --surface-3 有真值', '--surface-3:#eceef6' in flat_css)
check('浅色 --line-hover 有真值', '--line-hover:#c8cde3' in flat_css)
check('特效卡片带预览带（fx-demo）', 'className="fx-demo"' in src)
for fx in ['none', 'stars', 'snow', 'bubbles', 'aurora', 'orbit']:
    check(f'预览动画 [{fx}] 存在', f".fx-card[data-fx='{fx}']" in flat_css)
check('禁用态样式存在', '.set-row.is-disabled{opacity:0.42;' in flat_css)
check('滑杆禁用逻辑存在', 'dataKey="intensity"' in sjs and 'disabled={fxOff}' in sjs)
check('aria-pressed 随状态同步', 'aria-pressed={' in sjs)
check('按钮按压反馈', 'transform:translateY(1px)scale(0.985)' in flat_css)
check('reduced-motion 全局降级存在', 'prefers-reduced-motion:reduce' in flat_css)

print()
print('=== [H] 自定义 JS 动效 ===')
fxjs = re.sub(r'\s+', '', (ROOT / 'src' / 'lib' / 'effects.ts').read_text(encoding='utf-8'))
check('自定义进入特效列表', "id:'custom'" in fxjs)
check('用 new Function 编译（非 eval）', "newFunction('fx'" in fxjs)
check('编译失败返回错误不外抛', 'ok:false' in fxjs and 'catch(e)' in fxjs)
check('代码长度上限', 'maxCode:' in fxjs)
check('连续出错自动停用', 'failCustom(' in fxjs and 'maxErrors' in fxjs)
check('卡帧自动停用', 'slowMs' in fxjs)
check('停用会广播事件', "'fx-custom-failed'" in fxjs)
check('代码区样式存在', bool(re.search(r'\.fx-code\.is-off\{display:none\s*;?\}', flat_css)))
check('代码区等宽字体', 'ui-monospace' in flat_css)
check('错误状态样式', '.fx-code-status.is-error{' in flat_css)
# 示例是用户看到的第一段代码，必须存在且引用了真实可用的 API
check('内置示例存在', 'CUSTOM_SAMPLE' in fjs)
check('示例用到 fx.ctx / fx.state', 'fx.ctx' in (ROOT / 'src' / 'lib' / 'settings.ts').read_text(encoding='utf-8'))

print()
print('=== [I] 筛选栏的滑动指示器 ===')
flat_app = re.sub(r'\s+', '', app)
check('指示器组是定位上下文', '.ink-group{position:relative;' in flat_css)
check('组内 chip 不再各自展开下划线', '.ink-group.chip::after{display:none;}' in flat_css)
check('指示器本体存在', '.filter-ink{' in flat_css)
check('指示器过渡 transform 与 width',
      bool(re.search(r'\.filter-ink\{[^}]*transition:transform[^}]*width', flat_css)))
check('收件箱两组都挂了指示器', src.count('className="ink-group" data-ink=') >= 2)
check('复盘页区间组也挂了', 'data-ink="range"' in app)
check('渲染后重排指示器', 'scheduleFilterInk()' in app)
check('切换视图时重置几何（不跨页滑）', 'if(switched)resetFilterInk()' in flat_app)
check('重复点同一项直接返回',
      'if(state.filter.kind===k)return' in flat_app and 'if(state.filter.scope===s)return' in flat_app)
check('列表切换淡入', '.list.is-swapping{animation:listSwap' in flat_css)
check('窗口尺寸变化时重排（不动画）', 'scheduleFilterInk(false)' in app)

print()
print('=== [J] 悬浮方块的拖动与磁吸 ===')
check('两栏都有拖动手柄', 'data-grip="sidebar"' in html and 'data-grip="rail"' in html)
check('手柄是 button（键盘可达）', flat_html.count('<buttontype="button"className="float-grip"') == 2)
check('手柄有无障碍名称', html.count('aria-label="拖动调整') == 2)
check('拖动态锁住过渡', '.sidebar.dragging,.compose-rail.dragging{transition:none;' in flat_css)
check('拖动态覆盖 hover 位移', re.search(
    r'\.sidebar\.dragging,\.compose-rail\.dragging\{[^}]*transform:translateY\(-50%\)', flat_css) is not None)
check('松手后位置有过渡（磁吸不是瞬移）', re.search(
    r'\.sidebar,\.compose-rail\{transition:transform', flat_css) is not None)
check('三档吸附位', 'functionfloatSlots(' in flat_app)
check('位置钳制在视口内', 'functionclampTop(' in flat_app)
check('位置持久化', 'writeFloatPos(' in app and 'readFloatPos(' in app)
check('窄屏抽屉模式隐藏手柄', 'max-width:860px' in flat_css and '.float-grip{display:none;}' in flat_css)
check('触屏手势不被当成滚动', 'touch-action:none' in flat_css)
# 手柄是可交互控件，静默态也需 ≥3:1。用 opacity 压会把 4.8:1 打到 1.7:1 —— 等于看不见
grip = re.search(r'\.float-grip>span\{[^}]*\}', flat_css)
check('手柄静默态不靠 opacity 削弱', grip is not None and 'opacity:' not in grip.group(0))
check('手柄用校验过的文字色', grip is not None and 'background:var(--text-3)' in grip.group(0))
check('窗口变矮后重新钳位', "addEventListener('resize'" in app and 'clampTop(panel' in app)
check('零位移不算拖动（3px 阈值）', re.search(r'Math\.abs\(dy\)\s*<\s*3', app) is not None)

print()
print('=== [K] 点击即时反馈与内容居中 ===')
check('点击后先动指示器再等数据',
      'actions.setFilterKind(k)' in flat_app and 'scheduleFilterInk()' in flat_app)
check('内容区左右让道对称', re.search(
    r'\.app-main\{[^}]*padding-left:calc\(max\(var\(--nav-w\),var\(--rail-w\)\)', flat_css) is not None
    and re.search(
        r'\.app-main\{[^}]*padding-right:calc\(max\(var\(--nav-w\),var\(--rail-w\)\)', flat_css) is not None)

print()
print('=== [L] 键盘：上下切视图 / 左右切栏目 ===')
check('存在只给读屏的播报区', 'id="key-live"' in html and 'aria-live="polite"' in html)
check('播报区视觉隐藏但可读屏', re.search(r'\.sr-only\{[^}]*clip-path:inset\(50%\)', flat_css) is not None)
check('播报区不用 display:none（那样读屏也读不到）',
      re.search(r'\.sr-only\{[^}]*display:none', flat_css) is None)
check('键盘用法有可见提示', 'className="side-hint"' in html and '↑↓' in html and '←→' in html)
check('上下切视图', 'constcycleView=' in flat_app)
check('左右切栏目', 'constcycleFilter=' in flat_app)
check('顺序从 DOM 读，不另维护常量', "'#tabs [data-view]'" in app)
check('键盘走 store action（不另写一套切换逻辑）',
      'actions.setView(next.dataset.view as ViewName)' in app
      and 'actions.setFilterKind(value)' in app
      and 'actions.setReviewRange(value)' in app)
check('只在接管时才 preventDefault', 'if(moved)e.preventDefault()' in flat_app)
check('手柄聚焦时不抢上下键', "closest?.('[data-grip]'))return" in flat_app)
check('未登录时不响应（别在看不见的地方改视图）',
      "state.phase!=='app')return" in flat_app)
check('浮层打开时让路（模态 / 设置 / 抽屉）',
      "querySelector('.modal-mask'))return" in flat_app
      and 'if(state.navOpen)return' in flat_app
      and 'if(state.railOpen)return' in flat_app)
check('修饰键组合不触发方向键导航', 'metaKey||e.ctrlKey||e.altKey||e.repeat' in flat_app)
check('播报去掉 emoji', 'Extended_Pictographic' in app)

print()
print('=== [M] 焦点环：落点容器不该画环 ===')
# main 是 tabindex="-1" 的落点（供「跳到主要内容」）。点击内容区空白时浏览器会把焦点
# 交给最近的 focusable 祖先 —— 也就是 main，之后一按键盘 :focus-visible 就生效，
# 一圈 2px 环几乎框住整页，看着像 bug。
check('tabindex="-1" 的落点不画焦点环',
      "[tabindex='-1']:focus,[tabindex='-1']:focus-visible{outline:none;}" in flat_css)
check('主内容容器确实是 -1 落点',
      'id="main-content"tabIndex={-1}' in flat_html)
check('跳转链接存在（无障碍）', 'className="skip-link"' in html and '跳到主要内容' in html)
check('控件仍保留焦点环（别一并削掉）', ':focus-visible{outline:2pxsolidvar(--brand)' in flat_css)

print()
print('=== [N] AI 模型设置 ===')
ajs = re.sub(r'\s+', '', (ROOT / 'src' / 'lib' / 'ai.ts').read_text(encoding='utf-8'))
api_js = re.sub(r'\s+', '', (ROOT / 'src' / 'lib' / 'api.ts').read_text(encoding='utf-8'))
data_js = re.sub(r'\s+', '', (ROOT / 'src' / 'lib' / 'data.ts').read_text(encoding='utf-8'))
server_auth = re.sub(r'\s+', '', (ROOT / 'server' / 'src' / 'auth.js').read_text(encoding='utf-8'))
server_data = re.sub(r'\s+', '', (ROOT / 'server' / 'src' / 'data.js').read_text(encoding='utf-8'))
server_ai = re.sub(r'\s+', '', (ROOT / 'server' / 'src' / 'ai.js').read_text(encoding='utf-8'))
server_crypto = re.sub(r'\s+', '', (ROOT / 'server' / 'src' / 'crypto.js').read_text(encoding='utf-8'))
flat_app2 = re.sub(r'\s+', '', app)

check('设置里有 ai 组', 'ai:{' in sjs and "mode:'cloud'" in sjs)
check('模式只有云服务 / 自定义两种', "a.mode==='custom'?'custom':'cloud'" in sjs)
check('模型 ID 允许手填（目录外也认）', 'models.find((m)=>String(m.id)===want)||{id:want}' in ajs)
check('模型缓存带上所选 ID', '_modelKey=want' in ajs)
check('按路径读写设置字段', 'functionreadPath(' in sjs and 'functionwritePath' in sjs)
# 重建设置对象时必须展开原对象，否则新增的设置组会被静默丢掉
check('不再出现丢字段的重建写法',
      '{theme:cur.theme,effect:' not in sjs and '{theme:cur.theme,' not in sjs)
check('换主题预设不丢字段', 'return{...settings,theme:{' in sjs)
check('自定义接口有配置体检', 'exportfunctioncustomModelIssue(' in sjs)
check('地址合法性校验放行 http/https', "u.protocol==='https:'||u.protocol==='http:'" in sjs)
check('面板二选一用 class 不用 hidden', '.ai-pane.is-off{display:none;}' in flat_css)
check('模式切换同步 aria-selected', 'aria-selected={' in sjs)
check('模型目录读取失败要显示真实原因',
      '读取模型失败' in sjs and 'data-set-act="ai-refresh"' in sjs)
check('停用的模型不出现在列表', "m.disabled!==true&&m.enabled!==false" in sjs)
check('密钥字段用 password 类型', 'type="password"className="set-input"data-vendor-field="apiKey"' in sjs)

print()
print('=== [N2] 模型列表按供应商分组 ===')
check('默认设置里自定义是「选中项 + 供应商清单」', "custom:{pick:'',vendors:[]}" in sjs)
check('供应商清单的容量有上限（别让设置无限膨胀）', 'VENDOR_LIMITS={' in sjs)
check('供应商有规范化函数', 'functionnormVendor(' in sjs and 'exportfunctionnormalizeVendors(' in sjs)
check('旧的单条配置会被迁移而不是丢掉', 'functionmigrateCustom(' in sjs and 'migrateCustom(a' in sjs)
check('选中项形如 vendorId::modelId', "'::'" in sjs and 'functionparsePick(' in sjs)
check('解析选中项会回退到第一个可用的', 'exportfunctionresolveCustomPick(' in sjs)
check('按钮里不再嵌套按钮（点选与删除是兄弟）',
      sjs.count('className="model-pick"') == 1 and sjs.count('className="model-del"') == 1)
check('供应商字段用 data-vendor-field 而不是旧的 data-set 路径',
      'data-vendor-field="baseUrl"' in sjs and 'data-vendor-id=' in sjs)
check('改地址/密钥不重画清单（重画会打断输入）',
      'commitVendors(' in sjs and 'onField(' in sjs)
check('回车即可添加模型', "e.key==='Enter'" in sjs and 'data-model-new=' in sjs)
check('删掉供应商后把焦点还给添加按钮',
      "add-vendor\"]')?.focus()" in sjs)
check('新模型名不会与已有的重复', 'if(!label||seen.has(label))returnnull' in sjs)
check('地址尾斜杠会被去掉（拼路径不会变成 //）', r".replace(/\/+$/,'')" in sjs)
check('调用层按供应商取地址与密钥', 'vendor.baseUrl' in ajs and 'vendor.apiKey' in ajs)
check('调用层用解析出的模型名', 'model:model.name' in ajs)
check('分组用发丝线而不是色块',
      re.search(r'\.vendor\{[^}]*border-bottom:1pxsolidvar\(--line\)', flat_css) is not None
      and re.search(r'\.vendor\{[^}]*background:(?!none)', flat_css) is None)
check('模型行与云服务模型列表同一套指示条', '.model-pick::before{' in flat_css)
check('删除按钮不复用 .icon-btn（它在桌面是 display:none）',
      'className="icon-btn vendor-del"' not in sjs and 'className="icon-btn model-del"' not in sjs)
check('删除按钮有独立样式', '.vendor-del,.model-del{' in flat_css)
check('触屏下删除按钮放大到 44px',
      '@media(pointer:coarse){' in flat_css and '.model-del{width:44px;height:44px' in flat_css)
# 用 opacity 压淡会把对比度拉到 2.1:1（UI 组件要 3:1）—— 只能靠已过检的文字色
check('删除按钮不靠 opacity 压淡',
      re.search(r'\.vendor-del,\.model-del\{[^}]*opacity', flat_css) is None)
check('删除按钮用已过检的 --text-3',
      re.search(r'\.vendor-del,\.model-del\{[^}]*color:var\(--text-3\)', flat_css) is not None)

print()
print('=== [O] 自定义接口的调用层 ===')
check('直连走 fetch 而不是云 SDK', 'awaitfetch(url,{' in ajs)
check('手解 SSE 分片', "line.startsWith('data:')" in ajs and "payload==='[DONE]'" in ajs)
check('兼容非流式 JSON 响应', "includes('text/event-stream')" in ajs)
check('跨域失败要说清原因', '不允许浏览器跨域' in ajs)
check('HTTP 错误带状态码', '自定义接口返回${res.status}' in ajs)
check('取消请求不被当成失败吞掉', "name==='AbortError'" in ajs)
check('生成参数只在有效时才带上',
      'if(cfg.maxTokens>0)body.max_tokens=cfg.maxTokens' in ajs)
check('AI 层由外部注入设置', 'exportfunctionuseAiSettings(' in ajs)
check('AI 层不反向 import app', "from'./app.js" not in ajs)

print()
print('=== [P] 设置的持久化（含新增的 ai 列）===')
check('偏好读取走自建 API', "request<Partial<Settings>|null>('/preferences')" in data_js)
check('偏好保存走自建 API', "request('/preferences',{method:'PUT'" in data_js)
check('模型目录统一走自建 API', "request<ModelInfo[]>('/ai/models')" in data_js)
check('保存设置时带上 ai', 'ai:stateRef.current.settings.ai' in flat_app2)
check('面板自己拉取模型目录', "from'../lib/data'" in sjs and 'listModels' in sjs)
check('AI 层拿到当前设置', 'ai.useAiSettings(s.ai)' in flat_app2)
check('本地缓存剔掉密钥', "apiKey:''" in flat_app2 and 'writeRaw(SETTINGS_CACHE_KEY' in flat_app2)

print()
print('=== [Q] 自建后端、安全边界与记忆检索 ===')
check('本地缓存逐家剔掉 vendors[] 内的密钥',
      "vendors:custom.vendors.map((v)=>({...v,apiKey:''}))" in flat_app2)
check('问答使用局部 AbortController（catch 不会引用未定义变量）',
      'constcontroller=newAbortController()' in flat_app2
      and 'signal:controller.signal' in flat_app2
      and 'askController.current===controller' in flat_app2)
check('Ask 优先走相关记忆检索', 'db.retrieveEntries({query:question,limit:40})' in flat_app2)
check('长文本会切块并同步索引', 'memoryChunks(' in flat_app2 and 'replaceEntryChunks(' in flat_app2)
check('浏览器数据层只访问 /api', "constAPI=String(APP_CONFIG.apiBase)" in api_js)
check('默认 AI 经服务器代理', 'forawait(constchunkofstreamChat(params))' in ajs)
check('服务端数据查询按 owner_id 隔离', 'whereowner_id=$1' in server_data)
check('关联替换使用数据库事务', 'awaittx(async(client)=>' in server_data and 'deletefromentry_linkswhereowner_id=$1andsource_id=$2' in server_data)
check('会话 Cookie 为 HttpOnly', 'httpOnly:true' in server_auth)
check('数据库只保存会话 token 哈希', 'token_hash' in server_auth and 'sha256(token)' in server_auth)
check('邮箱验证码有频控与尝试次数限制', 'otpMaxPerHour' in server_auth and 'attempts>=5' in server_auth)
check('默认 AI 有按用户每日额度', 'ai_usage' in server_ai and 'dailyLimit' in server_ai)
check('自定义供应商 API Key 使用 AES-256-GCM', "createCipheriv('aes-256-gcm'" in server_crypto)

db_sql = (ROOT / 'database' / '001_baseline.sql').read_text(encoding='utf-8')
check('自建数据库包含本地账号与会话表',
      'create table if not exists users' in db_sql and 'create table if not exists sessions' in db_sql)
check('业务表 owner_id 关联本地 users',
      'owner_id uuid not null references users(id)' in db_sql)
check('旧托管认证函数已清除', 'auth.uid()' not in db_sql)

# 整个仓库不允许重新引入旧平台标识或旧 SDK。
forbidden_hits = []
for path in ROOT.rglob('*'):
    if not path.is_file() or '.git' in path.parts:
        continue
    if path.suffix.lower() not in {'.js', '.html', '.md', '.sql', '.yml', '.yaml', '.json', '.py', '.ts', '.tsx'}:
        continue
    try:
        text = path.read_text(encoding='utf-8').lower()
    except UnicodeDecodeError:
        continue
    legacy_name = 'work' + 'buddy'
    legacy_key = 'wb' + 'pk_'
    if legacy_name in text or legacy_key in text:
        forbidden_hits.append(str(path.relative_to(ROOT)))
check(f'旧平台代码与标识已彻底清除（{forbidden_hits or "无"}）', not forbidden_hits)

print()
print()
if fails:
    print(f'RESULT: {len(fails)} PROBLEM(S) -> {fails}')
    sys.exit(1)
print('RESULT: ALL STATIC CHECKS PASSED')
