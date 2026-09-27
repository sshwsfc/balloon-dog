import crypto from 'node:crypto';
import { config } from '../../config';
import { ForbiddenError } from '../../errors';

/**
 * 媒体访问签名。
 *
 * 为什么不用 Authorization 头：图片要能直接放进 `<img src>`，
 * 而 `<img>` 无法携带自定义请求头。所以后端签发一个「短时效 + 绑定资源 id」的
 * 签名串拼在 URL 上，既不暴露长期凭据，也不允许换 id 越权访问别人家孩子的照片。
 *
 * 格式：<expireEpochSeconds>.<hmacHex>
 */

function sign(mediaId: string, expireAt: number): string {
  return crypto
    .createHmac('sha256', config.JWT_SECRET)
    .update(`${mediaId}:${expireAt}`)
    .digest('hex');
}

/** 生成带签名的访问路径（可用 PUBLIC_BASE_URL 拼成绝对 URL）。 */
export function signMediaPath(mediaId: string): string {
  const expireAt = Math.floor(Date.now() / 1000) + config.MEDIA_URL_TTL_SECONDS;
  const signature = sign(mediaId, expireAt);
  return `/api/media/${mediaId}?t=${expireAt}.${signature}`;
}

export function signMediaUrl(mediaId: string): string {
  const path = signMediaPath(mediaId);
  const base = config.PUBLIC_BASE_URL.trim();
  return base ? `${base.replace(/\/$/, '')}${path}` : path;
}

/** 校验签名串；失败抛 403。 */
export function verifyMediaToken(mediaId: string, token: string): void {
  const [expireStr, signature] = token.split('.');
  const expireAt = Number(expireStr);
  if (!Number.isFinite(expireAt) || !signature) {
    throw new ForbiddenError('媒体访问令牌无效');
  }
  if (expireAt * 1000 < Date.now()) {
    throw new ForbiddenError('媒体访问链接已过期，请刷新页面');
  }
  const expected = sign(mediaId, expireAt);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new ForbiddenError('媒体访问令牌无效');
  }
}
