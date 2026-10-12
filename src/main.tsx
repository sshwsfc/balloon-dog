import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
// 副作用导入：初始化 i18next 并把语言同步到 <html lang> / 文档标题
import './i18n'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
