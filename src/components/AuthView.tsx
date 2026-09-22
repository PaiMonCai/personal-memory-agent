/**
 * 登录 / 注册 / 重置密码。
 *
 * 界面是"两步式"：先点发送验证码、用户去收信、再填码提交。因此**必须**把发送时拿到的
 * 挑战对象缓存下来供提交时复用；若在提交时再调一次发送接口，会让上一封验证码立即失效，
 * 用户永远填不对 —— 这正是曾经的缺陷。
 */
import { useCallback, useRef, useState } from 'react'
import * as db from '../lib/api'
import { describeError } from '../lib/data'
import type { OtpScope } from '../lib/types-auth'
import { toast } from '../lib/overlays'

type Tab = 'login' | 'signup' | 'reset'
type LoginMode = 'password' | 'otp'

interface Challenge {
  email: string
  payload: Awaited<ReturnType<typeof db.auth.signInWithOtp>> | Awaited<ReturnType<typeof db.auth.sendOtp>> | Awaited<ReturnType<typeof db.auth.resetPasswordForEmail>>
}

export function AuthView({ active, onAuthed }: { active: boolean; onAuthed: (session: { user: { id: string; email: string; role: string } }) => void }) {
  const [tab, setTab] = useState<Tab>('login')
  const [loginMode, setLoginMode] = useState<LoginMode>('password')
  const [error, setError] = useState('')
  const [pendingBtn, setPendingBtn] = useState<string | null>(null)
  /** 三个表单各自走不同的发送通道，返回的挑战对象形态也不同 */
  const challenges = useRef(new Map<OtpScope, Challenge>())
  const cooldowns = useRef(new Map<OtpScope, number>())

  const withLoading = useCallback(async (key: string, label: string, fn: () => Promise<void>) => {
    setPendingBtn(key ? `${key}:${label}` : label)
    try {
      await fn()
    } finally {
      setPendingBtn(null)
    }
  }, [])

  const showError = (msg: string) => setError(msg)

  function takeChallenge(scope: 'login-otp', email: string): Awaited<ReturnType<typeof db.auth.signInWithOtp>> | null
  function takeChallenge(scope: 'signup', email: string): Awaited<ReturnType<typeof db.auth.sendOtp>> | null
  function takeChallenge(scope: 'reset', email: string): Awaited<ReturnType<typeof db.auth.resetPasswordForEmail>> | null
  function takeChallenge(scope: OtpScope, email: string): Challenge['payload'] | null {
    const c = challenges.current.get(scope)
    if (!c || c.email !== email) return null
    return c.payload
  }

  const clearChallenge = (scope: OtpScope) => {
    challenges.current.delete(scope)
  }

  /** 发送后进入冷却，避免连点导致验证码反复失效 */
  const startCooldown = (scope: OtpScope, btn: HTMLButtonElement, seconds = 60) => {
    const original = '发送验证码'
    let left = seconds
    btn.dataset.cooling = '1'
    btn.disabled = true
    btn.textContent = `${left}s 后可重发`
    cooldowns.current.set(
      scope,
      window.setInterval(() => {
        left -= 1
        if (left <= 0) {
          const t = cooldowns.current.get(scope)
          if (t) clearInterval(t)
          cooldowns.current.delete(scope)
          if (document.body.contains(btn)) {
            btn.dataset.cooling = '0'
            btn.disabled = false
            btn.textContent = original
          }
          return
        }
        btn.textContent = `${left}s 后可重发`
      }, 1000)
    )
  }

  const sendVerificationCode = async (scope: OtpScope, email: string) => {
    if (scope === 'login-otp') {
      const res = await db.auth.signInWithOtp(email)
      if (res.error) throw res.error
      return res // data.verify({ token })
    }
    if (scope === 'signup') {
      const res = await db.auth.sendOtp(email)
      if (res.error) throw res.error
      return res // data.verificationId / data.isExistingUser
    }
    const res = await db.auth.resetPasswordForEmail(email)
    if (res.error) throw res.error
    return res // data.updateUser({ nonce, password })
  }

  const handleSend = async (scope: OtpScope, email: string, btn: HTMLButtonElement) => {
    if (btn.dataset.cooling === '1') return
    if (!email) return showError('请先填写邮箱')
    showError('')
    let sent = false
    await withLoading(`${scope}-send`, '发送中…', async () => {
      try {
        challenges.current.set(scope, { email, payload: await sendVerificationCode(scope, email) })
        toast('验证码已发送，请查收邮箱', 'success')
        sent = true
      } catch (err) {
        showError(describeError(err))
      }
    })
    if (sent) startCooldown(scope, btn)
  }

  const afterAuth = async () => {
    const session = await db.getSession()
    if (!session) throw new Error('登录未成功，请重试')
    onAuthed(session)
  }

  const submitPasswordLogin = async (form: HTMLFormElement) => {
    const email = (form.elements.namedItem('email') as HTMLInputElement).value.trim()
    const password = (form.elements.namedItem('password') as HTMLInputElement).value
    showError('')
    await withLoading('login', '登录中…', async () => {
      try {
        const { error } = await db.auth.signInWithPassword(email, password)
        if (error) throw error
        await afterAuth()
      } catch (err) {
        const code = (err as { code?: string })?.code
        showError(code === 'invalid_grant' || code === 'unauthenticated' ? '邮箱或密码不正确' : describeError(err))
      }
    })
  }

  const submitOtpLogin = async (form: HTMLFormElement) => {
    const email = (form.elements.namedItem('email') as HTMLInputElement).value.trim()
    const token = (form.elements.namedItem('code') as HTMLInputElement).value.trim()
    showError('')
    const challenge = takeChallenge('login-otp', email)
    if (!challenge || !challenge.data) return showError('请先点「发送验证码」获取邮箱验证码，再填入下方')
    await withLoading('login-otp', '登录中…', async () => {
      try {
        const completed = await challenge.data.verify({ token })
        if (completed.error) throw completed.error
        clearChallenge('login-otp')
        await afterAuth()
      } catch (err) {
        showError(describeError(err))
      }
    })
  }

  /** 注册：先验证邮箱，再带着密码完成注册 */
  const submitSignup = async (form: HTMLFormElement) => {
    const email = (form.elements.namedItem('email') as HTMLInputElement).value.trim()
    const token = (form.elements.namedItem('code') as HTMLInputElement).value.trim()
    const password = (form.elements.namedItem('password') as HTMLInputElement).value
    showError('')
    const challenge = takeChallenge('signup', email)
    if (!challenge || !challenge.data) return showError('请先点「发送验证码」获取邮箱验证码，再填入下方')
    await withLoading('signup', '注册中…', async () => {
      try {
        const d = challenge.data
        if (!d || !('verificationId' in d)) throw new Error('验证码状态异常，请重新获取')
        const completed = await db.auth.verifyOtp({
          verificationId: d.verificationId as string,
          token,
          email,
          isExistingUser: !!(d as { isExistingUser?: boolean }).isExistingUser,
          password: (d as { isExistingUser?: boolean }).isExistingUser ? undefined : password,
        })
        if (completed.error) throw completed.error
        if ((d as { isExistingUser?: boolean }).isExistingUser) {
          // 两个登录表单都把邮箱带上，用户不必重输
          setTab('login')
          showError('该邮箱已注册，请直接登录')
          setLoginMode('password')
          return
        }
        clearChallenge('signup')
        await afterAuth()
      } catch (err) {
        showError(describeError(err))
      }
    })
  }

  const submitReset = async (form: HTMLFormElement) => {
    const email = (form.elements.namedItem('email') as HTMLInputElement).value.trim()
    const nonce = (form.elements.namedItem('code') as HTMLInputElement).value.trim()
    const password = (form.elements.namedItem('password') as HTMLInputElement).value
    showError('')
    const challenge = takeChallenge('reset', email)
    if (!challenge || !challenge.data) return showError('请先点「发送验证码」获取密码重置验证码，再填入下方')
    await withLoading('reset', '处理中…', async () => {
      try {
        const completed = await challenge.data.updateUser({ nonce, password })
        if (completed.error) throw completed.error
        clearChallenge('reset')
        await afterAuth()
      } catch (err) {
        showError(describeError(err))
      }
    })
  }

  const sendBtn = (scope: OtpScope) => (
    <button
      type="button"
      className="btn btn-ghost"
      data-send-otp={scope}
      onClick={(e) => {
        const form = e.currentTarget.closest('form')
        const email = (form?.querySelector('input[name="email"]') as HTMLInputElement | null)?.value.trim() || ''
        void handleSend(scope, email, e.currentTarget)
      }}
    >
      发送验证码
    </button>
  )

  return (
    <div id="auth-view" className={`auth ${active ? '' : 'hidden'}`}>
      <div className="auth-brand">
        <div className="auth-brand-inner">
          <div className="brand-mark">🐾</div>
          <h1>信息管家</h1>
          <p className="auth-slogan">零散想法、资料与待办的统一收件箱</p>
          <ul className="auth-points">
            <li><span>✦</span> 随手记下，AI 自动分类、摘要、提炼重点</li>
            <li><span>✦</span> 自动发现内容之间的关联，不再孤立</li>
            <li><span>✦</span> 关键词检索与智能问答，随时找回记忆</li>
            <li><span>✦</span> 待办整理与阶段复盘，给出下一步行动</li>
          </ul>
          <p className="auth-foot">数据保存在你的自建服务器，与账号绑定，换设备也能接着用。</p>
        </div>
      </div>

      <div className="auth-panel">
        <div className="auth-card">
          <div className="auth-tabs" role="tablist">
            <button
              type="button"
              className={`auth-tab ${tab === 'login' ? 'active' : ''}`}
              data-auth-tab="login"
              role="tab"
              onClick={() => { setTab('login'); setError('') }}
            >
              登录
            </button>
            <button
              type="button"
              className={`auth-tab ${tab === 'signup' ? 'active' : ''}`}
              data-auth-tab="signup"
              role="tab"
              onClick={() => { setTab('signup'); setError('') }}
            >
              注册
            </button>
          </div>

          <div className={`auth-body ${tab === 'login' ? '' : 'hidden'}`} data-auth-panel="login">
            <div className="seg" id="login-mode">
              <button
                type="button"
                className={`seg-btn ${loginMode === 'password' ? 'active' : ''}`}
                data-login-mode="password"
                onClick={() => { setLoginMode('password'); setError('') }}
              >
                密码登录
              </button>
              <button
                type="button"
                className={`seg-btn ${loginMode === 'otp' ? 'active' : ''}`}
                data-login-mode="otp"
                onClick={() => { setLoginMode('otp'); setError('') }}
              >
                验证码登录
              </button>
            </div>

            <form
              id="form-login-password"
              className={`form ${loginMode === 'password' ? '' : 'hidden'}`}
              onSubmit={(e) => {
                e.preventDefault()
                void submitPasswordLogin(e.currentTarget)
              }}
            >
              <label className="field">
                <span>邮箱</span>
                <input type="email" name="email" autoComplete="email" placeholder="you@example.com" required />
              </label>
              <label className="field">
                <span>密码</span>
                <input type="password" name="password" autoComplete="current-password" placeholder="请输入密码" required />
              </label>
              <button type="submit" className="btn btn-primary btn-block" disabled={pendingBtn?.startsWith('login')}>
                {pendingBtn?.startsWith('login') ? pendingBtn.slice('login:'.length) : '登录'}
              </button>
              <div className="form-links">
                <button type="button" className="link" data-goto="reset" onClick={() => { setTab('reset'); setError('') }}>
                  忘记密码？
                </button>
              </div>
            </form>

            <form
              id="form-login-otp"
              className={`form ${loginMode === 'otp' ? '' : 'hidden'}`}
              onSubmit={(e) => {
                e.preventDefault()
                void submitOtpLogin(e.currentTarget)
              }}
            >
              <label className="field">
                <span>邮箱</span>
                <input type="email" name="email" autoComplete="email" placeholder="you@example.com" required />
              </label>
              <div className="field">
                <span>验证码</span>
                <div className="inline">
                  <input type="text" name="code" inputMode="numeric" autoComplete="one-time-code" placeholder="6 位验证码" required />
                  {sendBtn('login-otp')}
                </div>
              </div>
              <button type="submit" className="btn btn-primary btn-block">
                {pendingBtn?.startsWith('login-otp') ? pendingBtn.slice('login-otp:'.length) : '登录'}
              </button>
            </form>
          </div>

          <div className={`auth-body ${tab === 'signup' ? '' : 'hidden'}`} data-auth-panel="signup">
            <form
              id="form-signup"
              className="form"
              onSubmit={(e) => {
                e.preventDefault()
                void submitSignup(e.currentTarget)
              }}
            >
              <label className="field">
                <span>邮箱</span>
                <input type="email" name="email" autoComplete="email" placeholder="you@example.com" required />
              </label>
              <div className="field">
                <span>验证码</span>
                <div className="inline">
                  <input type="text" name="code" inputMode="numeric" autoComplete="one-time-code" placeholder="6 位验证码" required />
                  {sendBtn('signup')}
                </div>
              </div>
              <label className="field">
                <span>设置密码</span>
                <input type="password" name="password" autoComplete="new-password" placeholder="至少 8 位" required minLength={8} />
              </label>
              <button type="submit" className="btn btn-primary btn-block">
                {pendingBtn?.startsWith('signup') ? pendingBtn.slice('signup:'.length) : '注册并登录'}
              </button>
              <p className="form-note">注册需要先验证邮箱，验证码会发送到上面的邮箱地址。</p>
            </form>
          </div>

          <div className={`auth-body ${tab === 'reset' ? '' : 'hidden'}`} data-auth-panel="reset">
            <form
              id="form-reset"
              className="form"
              onSubmit={(e) => {
                e.preventDefault()
                void submitReset(e.currentTarget)
              }}
            >
              <label className="field">
                <span>邮箱</span>
                <input type="email" name="email" autoComplete="email" placeholder="you@example.com" required />
              </label>
              <div className="field">
                <span>验证码</span>
                <div className="inline">
                  <input type="text" name="code" inputMode="numeric" autoComplete="one-time-code" placeholder="6 位验证码" required />
                  {sendBtn('reset')}
                </div>
              </div>
              <label className="field">
                <span>新密码</span>
                <input type="password" name="password" autoComplete="new-password" placeholder="至少 8 位" required minLength={8} />
              </label>
              <button type="submit" className="btn btn-primary btn-block">
                {pendingBtn?.startsWith('reset') ? pendingBtn.slice('reset:'.length) : '重置密码并登录'}
              </button>
              <div className="form-links">
                <button type="button" className="link" data-goto="login" onClick={() => { setTab('login'); setError('') }}>
                  返回登录
                </button>
              </div>
            </form>
          </div>

          <p className={`auth-err ${error ? '' : 'hidden'}`} id="auth-error" role="alert">
            {error}
          </p>
        </div>
        <p className="auth-tip">认证、数据与默认 AI 均由你自己的服务器提供。</p>
      </div>
    </div>
  )
}
