import { defineConfig, loadEnv } from 'vite'
import type { Connect } from 'vite'
import { readFileSync } from 'node:fs'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

// 后端独立运行在 4000（见 server/），开发时用 Vite 代理把 /api 转发过去。
// 这样前端代码里一律写相对路径 `/api/...`：
//  - 开发环境由 Vite 代理到 localhost:4000；
//  - 生产环境由反向代理把 /api 转给后端，前端产物本身无需改任何配置。
const API_TARGET = process.env.VITE_API_TARGET || 'http://localhost:4000'

// 版本号只从 package.json 读一处，避免「代码里写死 1.0.0、package.json 已经 1.2.0」
// 这种最常见的版本漂移。用 readFileSync 而不是 `import pkg from './package.json'`，
// 是为了不依赖 tsconfig 的 resolveJsonModule 设置。
const APP_VERSION: string = JSON.parse(readFileSync('./package.json', 'utf8')).version

/**
 * 对外访问端口，**固定** 2727，由 `vite preview` 提供。
 *
 * 这里跑的是 `npm run build` 的产物（dist/），是静态文件直出，远程访问很快。
 * 外网反向代理（https://ballondog.hd.takin.cc）指的就是这个端口。
 *
 * 为什么不用 `vite dev` 对外：dev server 按需转换每个模块、还挂着 HMR websocket，
 * 走公网代理时首屏明显更慢（实测就是这个原因才换过来的）。dev 只服务本机开发，
 * 用 Vite 自己的默认端口（5173，被占用时自动 +1），不再被任何脚本写死引用。
 *
 * 用 strictPort 而不是让它自动递增，是为了让下列引用处能写死一个确定的值：
 * `scripts/browser-e2e.mjs` 的 APP_URL 默认值、README 里的访问地址。端口被占用时
 * 宁可直接报错，也不要悄悄换一个 —— 本项目踩过这个坑：另一个项目（smart-caigou）
 * 的 Vite 先占了 5173 且只绑 [::1]，于是响应式 E2E 打的是别人家的 SPA，
 * 所有「页面标题找不到」的断言失败全是假的。
 */
const PREVIEW_PORT = 2727

export default defineConfig(({ mode }) => {
  /**
   * 读仓库根目录的 .env（模板 .env.example）。
   *
   * 注意第三个参数传 `''`：它控制「哪些前缀的变量算数」，传 '' 表示全部都要。
   * 只写 `loadEnv(mode, process.cwd())` 的话只会拿到 VITE_ 开头的，
   * 现在虽然只用 VITE_SERVER_URL，但把话说清楚，以后加别的变量不会踩坑。
   */
  const env = loadEnv(mode, process.cwd(), '')

  /**
   * 对外访问基址（家长端页面 + /api + 孩子端安装包下载都挂在这个域名下）。
   * 同一个值还要被 android/app/build.gradle 读去烘焙孩子端 APK 里的后端地址。
   */
  const serverUrl = (env.VITE_SERVER_URL || '').trim().replace(/\/+$/, '')

  /** 反代域名。Vite 默认只信任 localhost 与 IP，不把域名加进来会直接被拒。 */
  const serverHost = (() => {
    if (!serverUrl) return null
    try {
      return new URL(serverUrl).hostname
    } catch {
      console.warn(`[balloon] VITE_SERVER_URL 不是合法的 URL，已忽略：${serverUrl}`)
      return null
    }
  })()

  /**
   * dev 与 preview 共用的监听/代理设置：两者都要能被反向代理连进来，
   * 都要把 `/api` 转给后端，都要放行反代域名的 Host 头。
   */
  const sharedServerOptions = {
    /** 监听所有网卡：反向代理（可能跑在另一台机器/容器里）要能连进来。 */
    host: true,
    /**
     * Vite 会校验请求的 Host 头，默认只放行 localhost 与本机 IP；用域名
     * （例如 ballondog.hd.takin.cc）访问而没加进白名单，会被回一句
     * "Blocked request. This host is not allowed."。
     */
    ...(serverHost ? { allowedHosts: [serverHost] } : {}),
    proxy: {
      '/api': {
        target: API_TARGET,
        changeOrigin: true,
      },
    },
  }

  /**
   * 管理后台 SPA（basename /admin）：深层路由回落到 admin/index.html，
   * 否则刷新 /admin/users 会 404。dev 与 preview 两个服务器都要装，
   * 漏掉 preview 的话「本地开发能刷新、预览版刷新回首页」会很难查。
   */
  const installAdminFallback = (middlewares: Connect.Server) => {
    middlewares.use((req, _res, next) => {
      // 去掉 query 再判断是否静态资源（避免把带点的 query 误判成文件）
      const url = (req.url || '').split('?')[0]
      if ((url === '/admin' || url.startsWith('/admin/')) && !url.includes('.')) {
        req.url = '/admin/index.html'
      }
      next()
    })
  }

  /** 启动时把生效的配置打出来，免得「以为读到了 .env 其实没有」这种静默失败。 */
  const logEffectiveBaseUrl = () =>
    console.log(
      `[balloon] 对外访问基址：${serverUrl || '(未配置 VITE_SERVER_URL，回落当前页面 origin)'}`,
    )

  return {
    plugins: [
      {
        name: 'admin-history-fallback',
        configureServer(server) {
          console.log('[balloon] 开发服务器：见下方 Vite 输出（带 HMR，仅本机开发用）')
          logEffectiveBaseUrl()
          installAdminFallback(server.middlewares)
        },
        configurePreviewServer(server) {
          console.log(
            `[balloon] 预览服务器：http://localhost:${PREVIEW_PORT}（跑 dist/ 产物，对外反代指到这里）`,
          )
          logEffectiveBaseUrl()
          installAdminFallback(server.middlewares)
        },
      },
      react(),
      tailwindcss(),
    ],
    define: {
      __APP_VERSION__: JSON.stringify(APP_VERSION),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      ...sharedServerOptions,
      /**
       * 没有显式配置 hmr —— 这是有意的。
       *
       * Vite 的 HMR 客户端在没配置时，会从 `location` 自己推导协议/主机/端口：
       * 用 http://localhost:5173 打开就连 ws://localhost:5173。
       * 一旦在这里写死 `hmr: { protocol: 'wss', clientPort: 443 }`，本机直连
       * 那一侧的热更新反而会连到 443 上而失效。
       */
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
    preview: {
      ...sharedServerOptions,
      port: PREVIEW_PORT,
      strictPort: true,
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
  }
})
