import { createRoot } from 'react-dom/client'
import './styles/app.css'
import Root from './App'

// 挂载点由 index.html 提供。这里刻意不用 StrictMode：
//  StrictMode 在开发模式下会双调用 effect，而特效引擎的初始化没有配对清理，
//  挂两次会叠加 resize / visibilitychange 监听。生产构建本就不会双调用。
const host = document.getElementById('root')
if (!host) throw new Error('找不到 #root 挂载点')

createRoot(host).render(<Root />)
