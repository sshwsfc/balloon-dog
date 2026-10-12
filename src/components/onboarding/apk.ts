import { serverUrl } from '@/lib/serverUrl'

/**
 * 孩子端安装包（APK）的地址。
 *
 * 构建后由 `npm run android:copy-apk` 把产物放到 `public/download/`，开发与生产
 * 都由静态资源直接提供，不需要后端参与。
 *
 * 这是**相对路径**，用于页面上的 `<a download>`（同源才保得住 download 语义）。
 * 要放进二维码、给别的设备扫的，用下面的 `agentApkUrl()`。
 */
export const AGENT_APK_PATH = '/download/balloon-dog-agent.apk'

/**
 * 拼成**绝对**地址，用于二维码与「手动下载」处展示。
 *
 * 用 `serverUrl()`（构建期注入的对外域名）而不是 `window.location.origin`：
 * 这个地址要编码进二维码、让**孩子手机**去扫，必须是一个孩子手机真能打开的
 * 公网地址；本机开发时页面 origin 是 localhost，写进二维码必然扫不开。
 */
export function agentApkUrl(): string {
  return `${serverUrl()}${AGENT_APK_PATH}`
}
