import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import { config } from '../../config';
import { BadRequestError } from '../../errors';

/**
 * 上传落盘配置（multer）。
 *
 * 安全要点：
 *  - 文件名由服务端随机生成，绝不采用客户端传来的文件名（防路径穿越 `../../x`）；
 *  - 扩展名从白名单 mime → ext 映射得到，而不是从原文件名截取；
 *  - 大小上限来自配置，避免一个请求写满磁盘。
 */

/** 上传根目录（相对 server 运行目录或绝对路径）。 */
export function mediaRootDir(): string {
  return path.isAbsolute(config.MEDIA_DIR)
    ? config.MEDIA_DIR
    : path.resolve(process.cwd(), config.MEDIA_DIR);
}

export function ensureMediaDir(): string {
  const dir = mediaRootDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 允许的媒体类型 → 落盘扩展名。 */
const MIME_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'audio/aac': '.aac',
  'audio/wav': '.wav',
};

export function extForMime(mime: string): string | null {
  return MIME_EXT[mime] ?? null;
}

/** 根据媒体种类返回允许的 mime 前缀。 */
export function allowedMimePrefixes(kind: string): string[] {
  switch (kind) {
    case 'photo':
    case 'screenshot':
      return ['image/'];
    case 'video':
      return ['video/'];
    case 'audio':
      return ['audio/'];
    default:
      return ['image/', 'video/', 'audio/'];
  }
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    try {
      cb(null, ensureMediaDir());
    } catch (err) {
      cb(err as Error, '');
    }
  },
  filename: (_req, file, cb) => {
    const ext = extForMime(file.mimetype) ?? '.bin';
    // 随机名 + 时间前缀：既避免碰撞，也便于按时间排查
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
  },
});

export const mediaUpload = multer({
  storage,
  limits: { fileSize: Math.round(config.MEDIA_MAX_SIZE_MB * 1024 * 1024), files: 1 },
  fileFilter: (_req, file, cb) => {
    const ext = extForMime(file.mimetype);
    if (!ext) {
      return cb(new BadRequestError(`不支持的媒体类型：${file.mimetype}`));
    }
    cb(null, true);
  },
});

/** 删除落盘文件（设备被解绑、媒体被清理时调用）。 */
export function removeMediaFile(filename: string): void {
  const target = path.join(mediaRootDir(), path.basename(filename));
  fs.rm(target, { force: true }, () => {
    /* 删除失败不影响主流程 */
  });
}

export function mediaFilePath(filename: string): string {
  // basename 再兜一层：即使数据库被写入恶意文件名，也不会读工作区外的文件
  return path.join(mediaRootDir(), path.basename(filename));
}
