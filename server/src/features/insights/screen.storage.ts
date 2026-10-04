import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { config } from '../../config';
import { BadRequestError } from '../../errors';
import { logger } from '../../logger';
import { mediaRootDir } from '../media/media.storage';

/**
 * 截屏包的落盘与解包。
 *
 * <h3>为什么自己解 zip 而不引依赖</h3>
 * 设备端上传的是「10 张低分辨率 JPEG 打成的 zip」。这里只需要读取能力，
 * 而 ZIP 的中央目录结构非常简单（比引入一个包再担心它的安全公告划算）。
 * 同时刻意支持 stored 与 deflate 两种方式：
 * 设备端用的是 stored（JPEG 本身已压缩，再 deflate 一遍几乎不省空间还费 CPU），
 * 但支持 deflate 意味着任何标准工具生成的 zip 也能被接受，便于人工排查。
 *
 * <h3>安全</h3>
 * 一律拒绝含路径分隔符或 `..` 的条目名（zip-slip），并且限制单包条目数与总大小 ——
 * 上传接口是设备令牌可调的，不能假设调用方善意。
 */

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;

export interface ZipEntry {
  name: string;
  data: Buffer;
}

/** 极简 ZIP 读取。只做需要的部分，遇到不支持的压缩方式直接报错而不是猜。 */
export function readZip(buffer: Buffer): ZipEntry[] {
  if (buffer.length < 22) throw new BadRequestError('上传内容不是有效的 zip 包（太短）');

  // 从尾部向前找 EOCD（末尾可能有最长 64KB 的注释）
  let eocd = -1;
  const minPos = Math.max(0, buffer.length - 22 - 0xffff);
  for (let i = buffer.length - 22; i >= minPos; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new BadRequestError('上传内容不是有效的 zip 包（找不到中央目录结尾）');

  const entryCount = buffer.readUInt16LE(eocd + 10);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  if (cdOffset >= buffer.length) throw new BadRequestError('zip 中央目录偏移越界');

  const entries: ZipEntry[] = [];
  let cursor = cdOffset;

  for (let i = 0; i < entryCount; i++) {
    if (cursor + 46 > buffer.length) break;
    if (buffer.readUInt32LE(cursor) !== CD_SIG) break;

    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);

    if (localOffset + 30 > buffer.length) throw new BadRequestError('zip 条目偏移越界');
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length) throw new BadRequestError('zip 条目数据越界');

    const raw = buffer.subarray(dataStart, dataEnd);
    let data: Buffer;
    if (method === 0) {
      data = Buffer.from(raw);
    } else if (method === 8) {
      data = zlib.inflateRawSync(raw);
    } else {
      throw new BadRequestError(`zip 使用了不支持的压缩方式（method=${method}）`);
    }

    entries.push({ name: safeEntryName(name), data });
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  if (entries.length === 0) throw new BadRequestError('zip 包里没有任何文件');
  if (entries.length > config.SCREEN_BATCH_MAX_FRAMES + 5) {
    // +5 是给 manifest.json 之类的小文件留余量
    throw new BadRequestError(`zip 包内文件过多（${entries.length}），超出上限`);
  }
  return entries;
}

/** 拒绝 zip-slip 与可疑路径，只保留纯文件名。 */
function safeEntryName(name: string): string {
  const normalized = name.replace(/\\/g, '/');
  if (normalized.includes('..') || normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
    throw new BadRequestError(`zip 内含非法路径：${name}`);
  }
  return path.basename(normalized);
}

/** 截屏包的根目录（挂在 MEDIA_DIR 下，跟着媒体一起备份/清理）。 */
export function screenBatchRoot(subDir = ''): string {
  const root = path.join(mediaRootDir(), 'screen-batches');
  return subDir ? path.join(root, subDir) : root;
}

/** 帧图对外暴露的相对路径（相对 MEDIA_DIR），存库用这个而不是绝对路径。 */
export function screenBatchRelativePath(batchId: string): string {
  return `screen-batches/${batchId}`;
}

/**
 * 落盘一个批次的帧图。
 *
 * @returns 实际写入的帧文件名与字节数
 */
export function persistBatchFrames(
  batchId: string,
  frames: { seq: number; data: Buffer }[],
): { files: { seq: number; filename: string; sizeBytes: number }[]; totalBytes: number } {
  const dir = screenBatchRoot(batchId);
  fs.mkdirSync(dir, { recursive: true });

  const files: { seq: number; filename: string; sizeBytes: number }[] = [];
  let totalBytes = 0;

  for (const frame of frames) {
    // 文件名由服务端生成：绝不采信客户端传来的名字（可能是 `../../x.jpg`）
    const filename = `frame-${String(frame.seq).padStart(4, '0')}.jpg`;
    fs.writeFileSync(path.join(dir, filename), frame.data);
    files.push({ seq: frame.seq, filename, sizeBytes: frame.data.length });
    totalBytes += frame.data.length;
  }

  logger.info({ msg: 'screen batch persisted', batchId, frames: files.length, totalBytes });
  return { files, totalBytes };
}

/** 删除一个批次的磁盘目录（清理过期数据、或入库失败时回滚）。 */
export function removeBatchFiles(batchId: string): void {
  const dir = screenBatchRoot(batchId);
  fs.rm(dir, { recursive: true, force: true }, () => {
    /* 删除失败不影响主流程 */
  });
}

/** 帧图的绝对路径。basename 兜一层，即使库里被写入恶意路径也读不到工作区外。 */
export function frameFilePath(relativePath: string): string {
  const safe = relativePath
    .split('/')
    .map((part) => path.basename(part))
    .join('/');
  return path.join(mediaRootDir(), safe);
}

/** 磁盘占用，用于配额与清理。 */
export function screenBatchDiskUsageBytes(): number {
  const root = screenBatchRoot();
  if (!fs.existsSync(root)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    for (const file of fs.readdirSync(dir)) {
      try {
        total += fs.statSync(path.join(dir, file)).size;
      } catch {
        /* 并发删除时忽略 */
      }
    }
  }
  return total;
}
