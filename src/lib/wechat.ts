/**
 * 微信 JS-SDK 的最小封装，只为「扫一扫」服务。
 *
 * 三条必须遵守的微信侧规矩，写在最前面免得后来人踩：
 *  1. **签名只能在服务端算**。jsapi_ticket 要用公众号 appSecret 去换，任何放进
 *     前端的密钥都等于公开。
 *  2. **签名里的 url 必须与调用时的页面 URL 完全一致**（去 hash，带 query）。
 *     所以这里每次都拿当前地址现换一次签名，不做跨页缓存 —— 缓存一份到处复用
 *     是 `invalid signature` 最常见的原因。
 *  3. **JS 接口安全域名必须在公众号后台配好**，否则 `wx.config` 直接失败。
 *     配好之前这条链路走不通，调用方要能优雅退回手输（见 ScanCodeDialog）。
 */
import { wechatApi } from '@/services/api'

/** 微信 JS-SDK 的最小类型声明：只声明我们真正用到的部分。 */
interface WxScanResult {
  resultStr?: string
}

interface WxConfigOptions {
  debug: boolean
  appId: string
  timestamp: number
  nonceStr: string
  signature: string
  jsApiList: string[]
}

interface WxSdk {
  config(options: WxConfigOptions): void
  ready(callback: () => void): void
  error(callback: (error: unknown) => void): void
  scanQRCode(options: {
    needResult: 0 | 1
    scanType: string[]
    success?: (result: WxScanResult) => void
    fail?: (error: unknown) => void
    error?: (error: unknown) => void
  }): void
}

declare global {
  interface Window {
    wx?: WxSdk
  }
}

const SDK_SRC = 'https://res.wx.qq.com/open/js/jweixin-1.6.0.js'

let sdkPromise: Promise<WxSdk> | null = null

/** 是否在微信内置浏览器里。微信的 UA 里带 `MicroMessenger`。 */
export function isWechatBrowser(): boolean {
  return /micromessenger/i.test(navigator.userAgent)
}

/** 动态加载 JS-SDK；同一个页面只加载一次，失败后允许重试。 */
function loadSdk(): Promise<WxSdk> {
  if (window.wx) return Promise.resolve(window.wx)
  if (sdkPromise) return sdkPromise

  sdkPromise = new Promise<WxSdk>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = SDK_SRC
    script.async = true
    script.onload = () => {
      if (window.wx) resolve(window.wx)
      else reject(new Error('微信 JS-SDK 已加载但没有挂上 window.wx'))
    }
    script.onerror = () => {
      // 失败后清掉缓存的 promise，下次点击还能再试一次
      sdkPromise = null
      reject(new Error('微信 JS-SDK 脚本加载失败'))
    }
    document.head.appendChild(script)
  })
  return sdkPromise
}

/** 把当前页面地址去 hash —— 微信要求签名用的 URL 不含 `#` 之后的部分。 */
function currentUrl(): string {
  return window.location.href.split('#')[0]
}

/** 拉签名并完成 wx.config，返回可用的 SDK 实例。 */
async function configureWx(): Promise<WxSdk> {
  const wx = await loadSdk()
  const { appId, timestamp, nonceStr, signature } = await wechatApi.jsapiSignature(currentUrl())

  await new Promise<void>((resolve, reject) => {
    wx.ready(() => resolve())
    wx.error((error) => reject(new Error(`微信 JS-SDK 配置失败：${JSON.stringify(error)}`)))
    wx.config({ debug: false, appId, timestamp, nonceStr, signature, jsApiList: ['scanQRCode'] })
  })

  return wx
}

/**
 * 调起微信扫一扫，返回扫到的原始字符串（此处就是孩子端的裸绑定码）。
 *
 * 失败时抛错，由调用方决定退回哪种方式 —— 常见失败原因：公众号没配
 * JS 接口安全域名、当前公众号没有「扫一扫」权限、用户在微信里点了取消。
 */
export async function scanWithWechat(): Promise<string> {
  const wx = await configureWx()

  return new Promise<string>((resolve, reject) => {
    wx.scanQRCode({
      // needResult: 1 —— 让微信把结果交给我们处理。设为 0 时微信扫完会
      // 自己跳去解析结果，我们就拿不到那串绑定码了。
      needResult: 1,
      scanType: ['qrCode'],
      success: (result) => resolve((result.resultStr ?? '').trim()),
      fail: () => reject(new Error('微信扫一扫未完成')),
      error: () => reject(new Error('微信扫一扫调用失败')),
    })
  })
}
