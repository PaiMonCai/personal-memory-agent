import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 纯静态前端：构建产物是 dist/，由 Nginx 提供；/api 反代给 Hono 服务。
// base 用相对路径，以便 dist/ 既能挂在域名根下，也能挂在子路径。
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
    target: 'es2022',
    sourcemap: false,
  },
  server: {
    port: 5173,
    proxy: {
      // 本地开发时把 /api 转到自建后端
      '/api': {
        target: process.env.API_ORIGIN || 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
    },
  },
})
