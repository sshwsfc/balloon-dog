/**
 * 「对外访问基址」（serverUrl）的唯一出处。
 *
 * 家长端页面、后端 `/api`、孩子端安装包下载都挂在**同一个域名**下（由反向代理
 * 统一入口，线上是 https://bdog.gtsiot.cn），这个域名在构建期由
 * `VITE_SERVER_URL` 注入，配置写在仓库根目录的 `.env`（模板 `.env.example`）。
 *
 * 为什么不直接用 `window.location.origin`：
 *  1. 下载二维码要把地址编码进一张图、让**孩子手机**去扫，必须是绝对地址；
 *  2. 页面可能是用局域网 IP、localhost、甚至临时隧道打开的，那时 origin 与对外
 *     域名并不一致，二维码就会指向一个孩子手机打不开的地址；
 *  3. 孩子端 APK 里的后端地址也在构建期烘焙（`android/app/build.gradle` 读同一个
 *     `VITE_SERVER_URL`），两边必须来自同一个值，否则会出现「家长端连线上、
 *     孩子端连本机」这种最难查的对不上。
 *
 * 留空则回落到当前页面的 origin —— 只适合本机开发，界面会据此给出提示
 * （见 `isLocalServerUrl`）。
 */

/** 构建期注入的值，去掉末尾斜杠；空字符串表示「没配」。 */
const CONFIGURED_SERVER_URL = (import.meta.env.VITE_SERVER_URL ?? '').trim().replace(/\/+$/, '')

/**
 * 对外基址，形如 `https://bdog.gtsiot.cn`（**不带**末尾斜杠）。
 *
 * 拼接时一律写成 `${serverUrl()}/path`。
 */
export function serverUrl(): string {
  return CONFIGURED_SERVER_URL || window.location.origin
}

/**
 * 对外基址是不是「只有本机能访问」的地址。
 *
 * 注意判断的是 **serverUrl 的主机名**，而不是当前页面的主机名：本机用
 * localhost 打开、但 `.env` 里已经配好公网域名时，二维码是有效的，不该报警告。
 */
export function isLocalServerUrl(): boolean {
  let host: string
  try {
    host = new URL(serverUrl()).hostname
  } catch {
    // serverUrl() 一定是可解析的（origin 或配置值），真解析不了就算了，不打扰用户
    return false
  }
  // IPv6 的 hostname 会带方括号，例如 [::1]
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host === '[::1]'
  )
}
