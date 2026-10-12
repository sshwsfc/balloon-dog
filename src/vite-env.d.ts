/// <reference types="vite/client" />

/** 由 vite.config.ts 的 define 注入，值来自 package.json 的 version。 */
declare const __APP_VERSION__: string

/**
 * 本项目实际用到的自定义环境变量。
 *
 * 只有 `VITE_` 前缀的变量才会被 Vite 注入到客户端代码里 —— 其余（比如后端的
 * `WECHAT_APP_SECRET`）留在服务端，绝不能从这里读。
 */
interface ImportMetaEnv {
  /**
   * 对外访问基址，由仓库根目录的 .env 提供（见 .env.example）。
   *
   * 用途见 `src/lib/serverUrl.ts`：孩子端安装包下载地址、二维码内容、
   * 微信登录回跳地址，以及孩子端 APK 里烘焙的后端地址（android/app/build.gradle
   * 读同一个变量），都必须来自它。
   */
  readonly VITE_SERVER_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
