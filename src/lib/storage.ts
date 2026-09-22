/** 本地存储：只放"这台机器、这个窗口"的偏好，不占云端设置的结构 */

export const SETTINGS_CACHE_KEY = 'pma.settings.cache'
export const FLOAT_POS_KEY = 'pma.floatPos'

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* 隐私模式下写入失败，忽略 */
  }
}

function remove(key: string) {
  try {
    localStorage.removeItem(key)
  } catch {
    /* 同上 */
  }
}

export function readFloatPos(): Record<string, number> {
  try {
    const raw = read(FLOAT_POS_KEY)
    const parsed = raw ? JSON.parse(raw) : {}
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export function writeFloatPos(key: string, top: number) {
  try {
    const all = readFloatPos()
    all[key] = Math.round(top)
    write(FLOAT_POS_KEY, JSON.stringify(all))
  } catch {
    /* 隐私模式下写不了就算了，不影响使用 */
  }
}

export function readRaw(key: string): string | null {
  return read(key)
}

export function writeRaw(key: string, value: string) {
  write(key, value)
}

export function removeKey(key: string) {
  remove(key)
}
