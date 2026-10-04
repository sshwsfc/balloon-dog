import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

// 后端独立运行在 4000（见 server/），开发时用 Vite 代理把 /api 转发过去。
// 这样前端代码里一律写相对路径 `/api/...`：
//  - 开发环境由 Vite 代理到 localhost:4000；
//  - 生产环境由 Nginx 把 /api 反代到后端，前端产物本身无需改任何配置。
const API_TARGET = process.env.VITE_API_TARGET || 'http://localhost:4000'

/**
 * 两个独立的 SPA，同一次构建产出：
 *  - 家长端： index.html        → 挂载 #root，路由 basename 无
 *  - 管理后台：admin/index.html → 挂载 #admin-root，路由 basename /admin
 *
 * 拆成两个入口而不是给家长端加路由，有两个好处：
 *  1. 后台代码不会进家长端的产物包（家长端用户永远下载不到后台 JS）；
 *  2. 后台入口独立，家长端的任何改动都不会意外暴露后台页面。
 */
export default defineConfig({
  plugins: [
    {
      name: 'admin-history-fallback',
      configureServer(server) {
        server.middlewares.use((req, _res, next) => {
          // 去掉 query 再判断是否静态资源（避免把带点的 query 误判成文件）
          const url = (req.url || '').split('?')[0]
          // 管理后台 SPA（basename /admin）：深层路由回落到 admin/index.html，
          // 否则刷新 /admin/users 会 404。
          if ((url === '/admin' || url.startsWith('/admin/')) && !url.includes('.')) {
            req.url = '/admin/index.html'
          }
          next()
        })
      },
    },
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    proxy: {
      '/api': {
        target: API_TARGET,
        changeOrigin: true,
      },
    },
    watch: {
      /**
       * 不要监视 android/ 与 server/。
       *
       * android/.android-home 里放着本机测试用的 AVD —— emulator 每次启动都会往
       * 那个目录写几百个文件（modem_simulator/**、read-snapshot.txt、快照等），
       * Vite 会因此疯狂触发整页 reload，既费电又会把 dev server 拖到不稳定
       * （实测日志里刷满了 `[vite] page reload android/.android-home/avd/...`）。
       *
       * server/ 由 tsx watch 自己管，前端不需要因为它改动而重载。
       * 顺带把构建产物目录也排掉，避免自己触发自己。
       */
      ignored: [
        '**/android/**',
        '**/server/**',
        '**/.gradle-home/**',
        '**/build/**',
        '**/dist/**',
      ],
    },
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        admin: path.resolve(__dirname, 'admin/index.html'),
      },
    },
  },
})
