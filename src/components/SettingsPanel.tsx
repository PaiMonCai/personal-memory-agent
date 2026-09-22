/**
 * 个性设置面板：主题预设、自定义配色、背景、动效、AI 模型、界面。
 *
 * 面板内部维护一份 cur（规范化后的设置副本），每次改动实时预览并回调 onChange 触发保存。
 * 数据结构与云端 preferences 列一致，随设置一起同步。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useStore } from '../state/store'
import {
  CUSTOM_SAMPLE,
  PRESETS,
  VENDOR_LIMITS,
  activePickKey,
  applyPreset,
  customModelIssue,
  normalizeSettings,
  parsePick,
} from '../lib/settings'
import { EFFECTS } from '../lib/effects'
import { uid } from '../lib/settings'
import { escapeHtml } from '../lib/ui'
import { listModels } from '../lib/data'
import { admin, type AdminMailSettings } from '../lib/api'
import type { ModelInfo, Settings, Vendor } from '../lib/types'

/** 写回并返回新设置。一律展开原对象，新增的设置组不会在这里被丢掉 */
function writeSet(cur: Settings, key: string, value: unknown): Settings {
  if (key === 'customCode') return { ...cur, effect: { ...cur.effect, custom: { code: String(value) } } }
  if (key.startsWith('ai.')) {
    const keys = key.slice(3).split('.')
    const ai = { ...cur.ai } as Record<string, unknown>
    let node = ai
    for (let i = 0; i < keys.length - 1; i++) {
      const k = keys[i]
      node[k] = { ...((node[k] as Record<string, unknown>) || {}) }
      node = node[k] as Record<string, unknown>
    }
    node[keys[keys.length - 1]] = value
    return { ...cur, ai: ai as unknown as Settings['ai'] }
  }
  if (key in cur.theme) {
    // 手动改色即进入自定义模式，但保留当前深浅基调
    const presetTouched = ['accent', 'bgFrom', 'bgTo'].includes(key)
    return {
      ...cur,
      theme: { ...cur.theme, [key]: value, ...(presetTouched ? { preset: 'custom' } : {}) } as Settings['theme'],
    }
  }
  return { ...cur, effect: { ...cur.effect, [key]: value } as Settings['effect'] }
}

function SliderRow({ label, value, min, max, step, dataKey, disabled, onChange }: {
  label: string
  value: number
  min: number
  max: number
  step: number
  dataKey: string
  disabled?: boolean
  onChange: (v: number) => void
}) {
  return (
    <label className={`set-row ${disabled ? 'is-disabled' : ''}`}>
      <span className="set-label">{label}</span>
      <input
        type="range"
        data-set={dataKey}
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <b className="set-out" data-out={dataKey}>
        {Math.round(value * 10) / 10}
      </b>
    </label>
  )
}

function SwitchRow({ label, checked, dataKey, onChange }: {
  label: string
  checked: boolean
  dataKey: string
  onChange: (v: boolean) => void
}) {
  return (
    <label className="set-row set-switch">
      <span className="set-label">{label}</span>
      <input type="checkbox" data-set={dataKey} checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  )
}

interface VendorCardProps {
  vendor: Vendor
  picked: string
  onField: (field: 'name' | 'baseUrl' | 'apiKey', value: string) => void
  onPick: (key: string) => void
  onDeleteVendor: () => void
  onAddModel: (name: string) => void
  onDeleteModel: (modelId: string) => void
}

function VendorCard({ vendor, picked, onField, onPick, onDeleteVendor, onAddModel, onDeleteModel }: VendorCardProps) {
  const [fresh, setFresh] = useState('')
  return (
    <div className="vendor" data-vendor={escapeHtml(vendor.id)}>
      <div className="vendor-head">
        <input
          type="text"
          className="vendor-name"
          data-vendor-field="name"
          data-vendor-id={vendor.id}
          placeholder="供应商名（如 DeepSeek）"
          value={vendor.name}
          aria-label="供应商名"
          onChange={(e) => onField('name', e.target.value)}
        />
        <button
          type="button"
          className="vendor-del"
          data-vendor-del={vendor.id}
          aria-label={`删除供应商 ${vendor.name}`}
          title="删除供应商"
          onClick={onDeleteVendor}
        >
          ×
        </button>
      </div>
      <input
        type="url"
        className="set-input"
        data-vendor-field="baseUrl"
        data-vendor-id={vendor.id}
        placeholder="https://api.example.com/v1"
        value={vendor.baseUrl}
        aria-label="接口地址"
        onChange={(e) => onField('baseUrl', e.target.value)}
      />
      <input
        type="password"
        className="set-input"
        data-vendor-field="apiKey"
        data-vendor-id={vendor.id}
        placeholder="API Key（sk-…）"
        value={vendor.apiKey}
        autoComplete="off"
        aria-label="API Key"
        onChange={(e) => onField('apiKey', e.target.value)}
      />
      <div className="model-list">
        {vendor.models.length ? (
          vendor.models.map((m) => {
            const key = `${vendor.id}::${m.id}`
            const on = key === picked
            return (
              <div className={`model-row ${on ? 'active' : ''}`} key={m.id}>
                <button type="button" className="model-pick" data-pick={escapeHtml(key)} aria-pressed={on} onClick={() => onPick(key)}>
                  <span className="model-name">{m.name}</span>
                </button>
                <button
                  type="button"
                  className="model-del"
                  data-model-del={escapeHtml(key)}
                  aria-label={`删除模型 ${m.name}`}
                  title="删除模型"
                  onClick={() => onDeleteModel(key)}
                >
                  ×
                </button>
              </div>
            )
          })
        ) : (
          <p className="ai-models-msg">这家下面还没有模型</p>
        )}
      </div>
      <div className="model-add">
        <input
          type="text"
          className="model-new"
          data-model-new={vendor.id}
          placeholder="模型名，回车添加"
          aria-label="新增模型名"
          value={fresh}
          onChange={(e) => setFresh(e.target.value)}
          onKeyDown={(e) => {
            // 回车即可添加模型，省得每次都要去点按钮
            if (e.key === 'Enter') {
              e.preventDefault()
              const name = fresh.trim()
              if (!name) return
              onAddModel(name)
              setFresh('')
            }
          }}
        />
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          data-set-act="add-model"
          data-vendor-add={vendor.id}
          onClick={() => {
            const name = fresh.trim()
            if (!name) return
            onAddModel(name)
            setFresh('')
          }}
        >
          添加模型
        </button>
      </div>
    </div>
  )
}

const EMPTY_MAIL: AdminMailSettings = {
  host: '',
  port: 465,
  secure: true,
  user: '',
  from: '',
  configured: false,
  hasPassword: false,
  source: 'environment',
}

function AdminMailPanel({ adminEmail, open }: { adminEmail: string; open: boolean }) {
  const [mail, setMail] = useState<AdminMailSettings>(EMPTY_MAIL)
  const [password, setPassword] = useState('')
  const [status, setStatus] = useState('尚未读取邮件配置')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    let alive = true
    void (async () => {
      setStatus('正在读取邮件配置…')
      try {
        const value = await admin.getMail()
        if (!alive) return
        setMail(value)
        setStatus(value.configured ? `SMTP 已配置（${value.source === 'database' ? '后台配置' : '环境变量'}）` : 'SMTP 尚未配置')
      } catch (err) {
        if (alive) setStatus((err as Error)?.message || '读取 SMTP 配置失败')
      }
    })()
    return () => { alive = false }
  }, [open])

  const patch = <K extends keyof AdminMailSettings>(key: K, value: AdminMailSettings[K]) =>
    setMail((cur) => ({ ...cur, [key]: value }))

  const save = async () => {
    setBusy(true)
    setStatus('正在保存…')
    try {
      const value = await admin.saveMail({
        host: mail.host.trim(),
        port: Number(mail.port) || 465,
        secure: mail.secure,
        user: mail.user.trim(),
        ...(password ? { password } : {}),
        from: mail.from.trim(),
      })
      setMail(value)
      setPassword('')
      setStatus('SMTP 已保存并立即生效')
    } catch (err) {
      setStatus((err as Error)?.message || '保存 SMTP 配置失败')
    } finally {
      setBusy(false)
    }
  }

  const test = async () => {
    setBusy(true)
    setStatus(`正在向 ${adminEmail} 发送测试邮件…`)
    try {
      await admin.testMail(adminEmail)
      setStatus('测试邮件已发送，请检查管理员邮箱')
    } catch (err) {
      setStatus((err as Error)?.message || '测试邮件发送失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="set-group" data-admin-mail>
      <h3>管理员 · 邮件服务</h3>
      <input className="set-input" type="text" aria-label="SMTP Host" placeholder="SMTP Host，例如 smtp.example.com"
        value={mail.host} onChange={(e) => patch('host', e.target.value)} />
      <div className="set-row">
        <span className="set-label">SMTP 端口</span>
        <input className="set-input" style={{ maxWidth: 128 }} type="number" min={1} max={65535}
          value={mail.port} onChange={(e) => patch('port', Number(e.target.value))} />
      </div>
      <SwitchRow label="SSL/TLS（通常 465 开启，587 关闭）" checked={mail.secure} dataKey="smtp.secure" onChange={(v) => patch('secure', v)} />
      <input className="set-input" type="text" aria-label="SMTP 用户名" placeholder="SMTP 用户名"
        value={mail.user} onChange={(e) => patch('user', e.target.value)} />
      <input className="set-input" type="password" aria-label="SMTP 密码" autoComplete="new-password"
        placeholder={mail.hasPassword ? 'SMTP 密码（留空保留现有密码）' : 'SMTP 密码'}
        value={password} onChange={(e) => setPassword(e.target.value)} />
      <input className="set-input" type="text" aria-label="发件人" placeholder="信息管家 <mailer@example.com>"
        value={mail.from} onChange={(e) => patch('from', e.target.value)} />
      <div className="model-add">
        <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void save()}>
          保存 SMTP
        </button>
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy || !mail.configured} onClick={() => void test()}>
          发送测试
        </button>
      </div>
      <p className="set-hint">保存后无需重启容器；SMTP 密码会加密存入数据库。</p>
      <p className="set-hint" aria-live="polite">{status}</p>
    </section>
  )
}

export function SettingsPanel() {
  const { state, actions } = useStore()
  const [cur, setCur] = useState<Settings>(() => normalizeSettings(state.settings))
  const [models, setModels] = useState<ModelInfo[] | null>(null)
  const [modelsError, setModelsError] = useState('')
  const [fxStatus, setFxStatus] = useState('')
  const [fxFailed, setFxFailed] = useState(false)
  const codeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const modelsAbort = useRef<AbortController | null>(null)
  const onChange = actions.onSettingsChange

  // 面板常驻 DOM；每次重新打开时从 store 同步一次，保留旧版“关闭后再开即取最新设置”的行为。
  useLayoutEffect(() => {
    if (state.panelOpen) setCur(normalizeSettings(state.settings))
    // 只在开合边沿同步；layout 阶段完成，避免打开后第一下操作被晚到的 effect 覆盖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.panelOpen])

  /**
   * 模型目录是权威来源，拿不到就把**真实原因**摆出来并给重试按钮 ——
   * 静默降级成"暂无模型"会让人以为是服务端没有模型，而不是读取失败了。
   */
  const reloadModels = async () => {
    if (modelsAbort.current) modelsAbort.current.abort()
    const ctl = new AbortController()
    modelsAbort.current = ctl
    setModels(null)
    setModelsError('')
    try {
      const list = await listModels()
      if (ctl.signal.aborted) return
      setModels(list || [])
    } catch (err) {
      if (ctl.signal.aborted) return
      setModelsError((err as { message?: string })?.message || '未知错误')
    }
  }

  // 模型目录只在服务器模式下有意义，自定义模式不必发这个请求
  useEffect(() => {
    if (state.panelOpen && cur.ai.mode === 'cloud') void reloadModels()
    return () => modelsAbort.current?.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cur.ai.mode, state.panelOpen])

  // 动效代码编译失败 / 自动停用时，把原因显示在面板里
  useEffect(() => {
    const onFail = (e: Event) => {
      const detail = (e as CustomEvent<{ reason?: string }>).detail
      setFxStatus(detail?.reason || '自定义动效已停用')
      setFxFailed(true)
    }
    document.addEventListener('fx-custom-failed', onFail)
    return () => document.removeEventListener('fx-custom-failed', onFail)
  }, [])

  // 关闭面板时撤销待执行的编译，避免面板关了还在跑
  useEffect(
    () => () => {
      if (codeTimer.current) clearTimeout(codeTimer.current)
    },
    []
  )

  const commit = (next: Settings) => {
    setCur(normalizeSettings(next))
    onChange(next)
  }

  /** 改供应商清单。一律过 normalize 补 id、去尾斜杠；地址/密钥改动不触发重画，避免打断输入 */
  const commitVendors = (list: Vendor[], opts: { pick?: string } = {}) => {
    const next = normalizeSettings({
      ...cur,
      ai: { ...cur.ai, custom: { ...cur.ai.custom, vendors: list, pick: opts.pick ?? cur.ai.custom.pick } },
    })
    setCur(next)
    onChange(next)
  }

  const onField = (vendorId: string, field: 'name' | 'baseUrl' | 'apiKey', value: string) => {
    commitVendors(cur.ai.custom.vendors.map((v) => (v.id === vendorId ? { ...v, [field]: value } : v)))
  }

  const addVendor = () => {
    if (cur.ai.custom.vendors.length >= VENDOR_LIMITS.vendors) return
    commitVendors([...cur.ai.custom.vendors, { id: uid(), name: '', baseUrl: '', apiKey: '', models: [] }])
  }

  const addModel = (vendorId: string, name: string) => {
    // id 必须在这里就定下来：交给 normalize 补的话，每次规范化都会新生成一个，
    // 于是"先算 id 再选中"会选中一个根本不存在的 id（表现是选中态根本没变）。
    const fresh = { id: uid('m'), name }
    commitVendors(
      cur.ai.custom.vendors.map((v) => (v.id === vendorId ? { ...v, models: [...v.models, fresh] } : v)),
      // 刚添加的模型通常就是想用的那个 —— 直接选中它
      { pick: `${vendorId}::${fresh.id}` }
    )
  }

  const customIssue = customModelIssue(cur.ai)
  const customStatus = customIssue ? `还不能用：${customIssue}` : '配置完整 ✓'
  const picked = activePickKey(cur.ai.custom)
  const usableModels = (models || []).filter((m) => m && m.disabled !== true && m.enabled !== false)
  const fxOff = cur.effect.type === 'none'
  const onCustom = cur.effect.type === 'custom'

  return (
    <aside className={`settings-panel ${state.panelOpen ? '' : 'hidden'}`} id="settings-panel" role="dialog" aria-modal="true" aria-label="个性设置">
      <div className="set-head">
        <h2>个性设置</h2>
        <button type="button" className="btn btn-ghost btn-sm" data-set-act="close" onClick={actions.closeSettings}>
          关闭
        </button>
      </div>
      <div className="set-body">
        <section className="set-group">
          <h3>主题配色</h3>
          <div className="preset-grid">
            {PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`preset ${p.id === cur.theme.preset ? 'active' : ''}`}
                data-preset={p.id}
                title={p.label}
                onClick={() => commit({ ...applyPreset(cur, p.id), effect: cur.effect })}
              >
                <span
                  className="preset-swatch"
                  style={{
                    background: `linear-gradient(135deg,${p.bgFrom},${p.bgTo})`,
                    borderColor: p.accent,
                  }}
                >
                  <i style={{ background: p.accent }}></i>
                </span>
                <span className="preset-label">{p.label}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="set-group">
          <h3>自定义颜色</h3>
          <label className="set-row">
            <span className="set-label">强调色</span>
            <input type="color" data-set="accent" value={cur.theme.accent} onChange={(e) => commit(writeSet(cur, 'accent', e.target.value))} />
          </label>
          <label className="set-row">
            <span className="set-label">背景起色</span>
            <input type="color" data-set="bgFrom" value={cur.theme.bgFrom} onChange={(e) => commit(writeSet(cur, 'bgFrom', e.target.value))} />
          </label>
          <label className="set-row">
            <span className="set-label">背景止色</span>
            <input type="color" data-set="bgTo" value={cur.theme.bgTo} onChange={(e) => commit(writeSet(cur, 'bgTo', e.target.value))} />
          </label>
          <p className="set-hint">改任意颜色会切到「自定义」，深/浅色基调保持不变。</p>
        </section>

        <section className="set-group">
          <h3>背景图片</h3>
          <input
            type="url"
            className="set-input"
            data-set="bgImage"
            placeholder="粘贴图片直链 https://…（留空则只用渐变色）"
            value={cur.theme.bgImage}
            onChange={(e) => commit(writeSet(cur, 'bgImage', e.target.value))}
          />
          <p className="set-hint">建议用 https 图片直链，http 链接可能被浏览器拦截而显示不出来。</p>
          <SliderRow label="模糊" value={cur.theme.blur} min={0} max={24} step={1} dataKey="blur" onChange={(v) => commit(writeSet(cur, 'blur', v))} />
          <SliderRow label="遮罩浓度" value={cur.theme.dim} min={0} max={80} step={1} dataKey="dim" onChange={(v) => commit(writeSet(cur, 'dim', v))} />
        </section>

        <section className="set-group">
          <h3>动态特效</h3>
          <div className="fx-grid">
            {EFFECTS.map((e) => (
              <button
                key={e.id}
                type="button"
                className={`fx-card ${e.id === cur.effect.type ? 'active' : ''}`}
                data-fx={e.id}
                title={e.hint}
                aria-pressed={e.id === cur.effect.type}
                onClick={() => commit(writeSet(cur, 'type', e.id))}
              >
                <span className="fx-demo" aria-hidden="true"><i></i><i></i><i></i></span>
                <span className="fx-name">{e.label}</span>
                <span className="fx-hint">{e.hint}</span>
              </button>
            ))}
          </div>
          <SliderRow
            label="密度"
            value={cur.effect.intensity}
            min={0.3}
            max={2}
            step={0.1}
            dataKey="intensity"
            disabled={fxOff}
            onChange={(v) => commit(writeSet(cur, 'intensity', v))}
          />
          <SliderRow
            label="速度"
            value={cur.effect.speed}
            min={0.2}
            max={3}
            step={0.1}
            dataKey="speed"
            disabled={fxOff}
            onChange={(v) => commit(writeSet(cur, 'speed', v))}
          />

          <div className={`fx-code ${onCustom ? '' : 'is-off'}`} data-fx-code>
            <div className="fx-code-head">
              <span>自定义 JS（每帧执行）</span>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                data-set-act="sample"
                onClick={() => commit(writeSet(cur, 'customCode', CUSTOM_SAMPLE))}
              >
                填入示例
              </button>
            </div>
            <textarea
              className="fx-code-area"
              data-set="customCode"
              spellCheck={false}
              placeholder="写一个函数体，参数 fx。例如：fx.ctx.fillRect(0, 0, 10, 10)"
              rows={10}
              value={cur.effect.custom.code}
              onChange={(e) => {
                const next = writeSet(cur, 'customCode', e.target.value)
                setCur(next)
                setFxStatus('输入中…')
                setFxFailed(false)
                // 每敲一个字符就重编译太浪费，等停手 600ms 再真正落库
                if (codeTimer.current) clearTimeout(codeTimer.current)
                codeTimer.current = setTimeout(() => commit(next), 600)
              }}
            ></textarea>
            <p className={`fx-code-status ${fxFailed ? 'is-error' : ''}`} data-fx-status>
              {fxStatus}
            </p>
            <p className="set-hint">
              这段代码在你的浏览器里以本页身份运行，只粘贴你自己写的或信任的代码。
              连续出错 3 次或每帧耗时持续超过 60ms 会自动停用。
            </p>
          </div>
        </section>

        <section className="set-group">
          <h3>AI 模型</h3>
          <div className="ai-mode" role="tablist" aria-label="模型来源">
            <button
              type="button"
              className={`ai-mode-tab ${cur.ai.mode === 'cloud' ? 'active' : ''}`}
              role="tab"
              aria-selected={cur.ai.mode === 'cloud'}
              data-ai-mode="cloud"
              onClick={() => commit(writeSet(cur, 'ai.mode', 'cloud'))}
            >
              服务器模型
            </button>
            <button
              type="button"
              className={`ai-mode-tab ${cur.ai.mode === 'custom' ? 'active' : ''}`}
              role="tab"
              aria-selected={cur.ai.mode === 'custom'}
              data-ai-mode="custom"
              onClick={() => commit(writeSet(cur, 'ai.mode', 'custom'))}
            >
              自定义接口
            </button>
          </div>

          <div className={`ai-pane ${cur.ai.mode === 'cloud' ? '' : 'is-off'}`} data-ai-pane="cloud">
            <div className="ai-models" data-ai-models>
              {models === null && !modelsError ? (
                <p className="ai-models-msg">正在读取可用模型…</p>
              ) : modelsError ? (
                <>
                  <p className="ai-models-msg is-error">读取模型失败：{modelsError}</p>
                  <button type="button" className="btn btn-ghost btn-sm" data-set-act="ai-refresh" onClick={() => void reloadModels()}>
                    重试
                  </button>
                </>
              ) : usableModels.length ? (
                <>
                  {[
                    { id: '', label: '自动', hint: '使用第一个可用模型' },
                    ...usableModels.map((m) => ({ id: String(m.id), label: String(m.id), hint: m.provider || m.owned_by || '' })),
                  ].map((m) => (
                    <button
                      key={m.id || 'auto'}
                      type="button"
                      className={`ai-model ${m.id === cur.ai.modelId ? 'active' : ''}`}
                      data-ai-model={escapeHtml(m.id)}
                      aria-pressed={m.id === cur.ai.modelId}
                      onClick={() => commit(writeSet(cur, 'ai.modelId', m.id))}
                    >
                      <span className="ai-model-name">{m.label}</span>
                      {m.hint ? <span className="ai-model-hint">{m.hint}</span> : null}
                    </button>
                  ))}
                  {/* 手填了一个目录里没有的 ID 时，列表里没有能点亮的项，得说清楚 */}
                  <p className="ai-models-msg">
                    {cur.ai.modelId && !usableModels.some((m) => String(m.id) === cur.ai.modelId)
                      ? `正在使用目录外的模型 ID「${cur.ai.modelId}」`
                      : `共 ${usableModels.length} 个可用模型`}
                  </p>
                </>
              ) : (
                <p className="ai-models-msg is-error">服务端没有返回可用模型，请到管理页确认模型配置</p>
              )}
            </div>
            <div className="ai-pick">
              <label className="ai-pick-label" htmlFor="ai-model-manual">
                手动指定模型 ID
              </label>
              <div className="ai-pick-row">
                <input
                  type="text"
                  id="ai-model-manual"
                  className="set-input"
                  data-set="ai.modelId"
                  placeholder="留空 = 自动使用第一个可用模型"
                  value={cur.ai.modelId}
                  onChange={(e) => commit(writeSet(cur, 'ai.modelId', e.target.value))}
                />
                <button type="button" className="btn btn-ghost btn-sm" data-set-act="ai-refresh" onClick={() => void reloadModels()}>
                  刷新
                </button>
              </div>
            </div>
            <p className="set-hint">
              模型由自建服务器提供，按当前应用的名义调用，不需要你填密钥。目录里没列出的模型也可以手填 ID 试试。
            </p>
          </div>

          <div className={`ai-pane ${cur.ai.mode === 'custom' ? '' : 'is-off'}`} data-ai-pane="custom">
            <div className="vendor-list" data-vendor-list>
              {cur.ai.custom.vendors.length ? (
                cur.ai.custom.vendors.map((v) => (
                  <VendorCard
                    key={v.id}
                    vendor={v}
                    picked={picked}
                    onField={(field, value) => onField(v.id, field, value)}
                    onPick={(key) => commitVendors(cur.ai.custom.vendors, { pick: key })}
                    onDeleteVendor={() => {
                      commitVendors(cur.ai.custom.vendors.filter((x) => x.id !== v.id))
                      // 焦点原本在被删掉的按钮上，重画后它不存在了 —— 还给"添加"按钮，别掉进虚空
                      document.querySelector<HTMLElement>('[data-set-act="add-vendor"]')?.focus()
                    }}
                    onAddModel={(name) => addModel(v.id, name)}
                    onDeleteModel={(modelId) =>
                      commitVendors(
                        cur.ai.custom.vendors.map((x) =>
                          x.id === v.id ? { ...x, models: x.models.filter((m) => m.id !== parsePick(modelId).modelId) } : x
                        )
                      )
                    }
                  />
                ))
              ) : (
                <p className="ai-models-msg">还没有供应商，点下面的「+ 添加供应商」开始。</p>
              )}
            </div>
            <button type="button" className="btn btn-ghost btn-sm" data-set-act="add-vendor" onClick={addVendor}>
              + 添加供应商
            </button>
            <p className={`set-hint ${customIssue ? 'is-error' : ''}`} data-ai-custom-status>
              {customStatus}
            </p>
            <p className="set-hint set-warn">
              <strong>密钥会随设置同步到云端</strong>，换设备免重填；请只在信任的环境里填。
              地址需兼容 OpenAI 的 <code>/chat/completions</code>；浏览器直连要求对方允许跨域，
              被拦时请填你自己的中转地址。
            </p>
          </div>

          <SliderRow
            label="温度"
            value={cur.ai.temperature}
            min={0}
            max={2}
            step={0.1}
            dataKey="ai.temperature"
            onChange={(v) => commit(writeSet(cur, 'ai.temperature', v))}
          />
          <p className="set-hint">越高越发散，越低越稳。整理笔记建议 0.3~0.7。</p>
          <SliderRow
            label="最大长度"
            value={cur.ai.maxTokens}
            min={0}
            max={8192}
            step={256}
            dataKey="ai.maxTokens"
            onChange={(v) => commit(writeSet(cur, 'ai.maxTokens', v))}
          />
          <p className="set-hint">单次回复的 token 上限，0 表示交给服务端默认。</p>
        </section>

        {state.user?.role === 'admin' ? (
          <AdminMailPanel adminEmail={state.user.email} open={state.panelOpen} />
        ) : null}

        <section className="set-group">
          <h3>界面</h3>
          <SliderRow label="圆角" value={cur.theme.radius} min={0} max={24} step={1} dataKey="radius" onChange={(v) => commit(writeSet(cur, 'radius', v))} />
          <SwitchRow label="紧凑列表" checked={cur.theme.compact} dataKey="compact" onChange={(v) => commit(writeSet(cur, 'compact', v))} />
        </section>
      </div>
      <div className="set-foot">
        <button type="button" className="btn btn-ghost btn-sm" data-set-act="reset" onClick={actions.resetSettings}>
          恢复默认
        </button>
        <span className="set-status" data-set-status>
          {state.settingsStatus || '改动会自动保存到云端'}
        </span>
      </div>
    </aside>
  )
}
