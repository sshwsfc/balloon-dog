import crypto from 'node:crypto';
import { config } from '../../config';
import { ForbiddenError } from '../../errors';

/**
 * 应用图标访问签名。
 *
 * 为什么不用 Authorization 头：图标要能直接放进 `<img src>`，而 `<img>` 带不了
 * 自定义请求头（和媒体文件是同一个问题，见 media.signedUrl.ts）。
 *
 * 和媒体签名的区别只有两点，都是为了长期缓存：
 *  - TTL 长得多：图标几乎不会变，没必要每次打开页面都重签；
 *  - URL 里带上 `v=<iconHash>`：图标内容变了 hash 就变、URL 也跟着变，
 *    所以浏览器可以放心 `immutable` 缓存，永远不会显示旧图。
 *
 * 格式：`<expireEpochSeconds>.<hmacHex>`，签名内容绑定 DeviceApp.id。
 */

/** 图标链接有效期（7 天）。与下发接口里的 Cache-Control max-age 保持一致。 */
export const APP_ICON_URL_TTL_SECONDS = 7 * 24 * 3600;

function sign(appId: string, expireAt: number): string {
  return crypto
    .createHmac('sha256', config.JWT_SECRET)
    .update(`app-icon:${appId}:${expireAt}`)
    .digest('hex');
}

/**
 * 把过期时间对齐到 7 天的整数倍窗口。
 *
 * 一开始这里写的是 `now + 7 天`，结果是**同一张图每次请求都拿到不同的 URL** ——
 * 签名里带着当前时间，URL 就永远在变，浏览器 `immutable` 缓存一次都命不中，
 * 家长端每翻一页都要把几十张图标重新下一遍。
 *
 * 改成按窗口对齐之后，同一个 7 天窗口内签出来的链接完全一致；窗口滚动时才换一次。
 * 用 `+2 * TTL` 而不是 `+1`：`+1` 会让窗口末尾签发的链接只剩一瞬间有效期，
 * 而前端拿到的 `Cache-Control: max-age=7 天` 会让浏览器缓存它整整 7 天 ——
 * 缓存还没过期链接就先失效了。`+2` 保证签发时**至少**还有 7 天，最多 14 天。
 */
function windowedExpiry(nowSeconds: number): number {
  const windows = Math.floor(nowSeconds / APP_ICON_URL_TTL_SECONDS);
  return (windows + 2) * APP_ICON_URL_TTL_SECONDS;
}

/** 生成带签名的图标访问路径（相对路径，前端直接用）。 */
export function signAppIconPath(appId: string, iconHash: string): string {
  const expireAt = windowedExpiry(Math.floor(Date.now() / 1000));
  return `/api/app-icons/${appId}?v=${encodeURIComponent(iconHash)}&t=${expireAt}.${sign(appId, expireAt)}`;
}

/** 校验签名串；失败抛 403。 */
export function verifyAppIconToken(appId: string, token: string): void {
  const [expireStr, signature] = token.split('.');
  const expireAt = Number(expireStr);
  if (!Number.isFinite(expireAt) || !signature) {
    throw new ForbiddenError('图标访问令牌无效');
  }
  if (expireAt * 1000 < Date.now()) {
    throw new ForbiddenError('图标访问链接已过期，请刷新页面');
  }
  const expected = sign(appId, expireAt);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new ForbiddenError('图标访问令牌无效');
  }
}
