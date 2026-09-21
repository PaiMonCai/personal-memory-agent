/**
 * 云服务公开配置。
 *
 * 这两个值直接来自云服务激活时返回的 publicConfig，是**唯一**允许出现在前端的云配置：
 *  - endpoint      当前应用的发布域数据平面地址（登录与数据请求都走它）
 *  - publishableKey 只标识"是哪个应用"，本身不带任何权限，服务端另做 Origin 精确校验
 *
 * 不要用 location、环境变量或猜出来的域名替换 endpoint。
 */
export const PUBLIC_CONFIG = {
  endpoint: 'https://personal-memory-agent-50179.app.workbuddy.host',
  publishableKey: 'wbpk_ouBOgeQin1g7hol8qg1s5R_O2IiS1RceObvHSv11Z21ST7GifB7a3g0',
}

/** 应用自身的信息（仅用于界面展示） */
export const APP_INFO = {
  name: '信息管家',
  tagline: '零散想法、资料与待办的统一收件箱',
}
