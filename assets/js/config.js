/**
 * 自建部署公开配置。
 * 默认前后端同域，Nginx 把 /api 反代给 Hono 服务。
 * 若前后端分离，可把 apiBase 改成完整 HTTPS 地址，并同步配置服务端 APP_ORIGIN/CORS。
 */
export const APP_CONFIG = {
  apiBase: '/api',
}

export const APP_INFO = {
  name: '信息管家',
  tagline: '零散想法、资料与待办的统一收件箱',
}
