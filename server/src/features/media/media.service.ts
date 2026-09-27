import fs from 'node:fs';
import { prisma } from '../../prisma';
import { logger } from '../../logger';
import { BadRequestError, ForbiddenError, NotFoundError } from '../../errors';
import { signMediaUrl } from './media.signedUrl';
import { allowedMimePrefixes, mediaFilePath, removeMediaFile } from './media.storage';
import type { MediaAsset } from '@prisma/client';

function toMediaView(asset: MediaAsset) {
  return {
    id: asset.id,
    deviceId: asset.deviceId,
    kind: asset.kind,
    mimeType: asset.mimeType,
    sizeBytes: asset.sizeBytes,
    commandId: asset.commandId,
    createdAt: asset.createdAt,
    // 带短时效签名，前端可直接喂给 <img src>
    url: signMediaUrl(asset.id),
  };
}

export const mediaService = {
  /** 设备端上传媒体，落库并返回可访问 URL。 */
  async saveFromDevice(input: {
    deviceId: string;
    userId: number | null;
    kind: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    commandId?: string;
  }) {
    const prefixes = allowedMimePrefixes(input.kind);
    if (!prefixes.some((p) => input.mimeType.startsWith(p))) {
      // 先落盘后校验的情况要清掉文件，避免留下无人引用的垃圾
      removeMediaFile(input.filename);
      throw new BadRequestError(`媒体类型 ${input.mimeType} 与用途 ${input.kind} 不匹配`);
    }

    // commandId 必须属于本设备，防止设备把文件挂到别的指令上
    if (input.commandId) {
      const command = await prisma.deviceCommand.findFirst({
        where: { id: input.commandId, deviceId: input.deviceId },
        select: { id: true },
      });
      if (!command) {
        removeMediaFile(input.filename);
        throw new BadRequestError('关联的指令不存在或不属于该设备');
      }
    }

    const asset = await prisma.mediaAsset.create({
      data: {
        deviceId: input.deviceId,
        userId: input.userId,
        kind: input.kind,
        filename: input.filename,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        commandId: input.commandId ?? null,
      },
    });

    logger.info({
      msg: 'media saved',
      mediaId: asset.id,
      deviceId: input.deviceId,
      kind: input.kind,
      sizeBytes: input.sizeBytes,
    });
    return toMediaView(asset);
  },

  /** 家长端：列出某设备的媒体（可筛选类型）。 */
  async listForDevice(userId: number, deviceId: string, kind?: string, limit = 50) {
    const rows = await prisma.mediaAsset.findMany({
      where: { deviceId, userId, ...(kind ? { kind } : {}) },
      orderBy: { createdAt: 'desc' },
      take: Math.min(200, Math.max(1, limit)),
    });
    return rows.map(toMediaView);
  },

  /** 取单个媒体（家长端）；越权访问他人媒体一律 403。 */
  async getOwned(userId: number, mediaId: string) {
    const asset = await prisma.mediaAsset.findUnique({ where: { id: mediaId } });
    if (!asset) throw new NotFoundError('媒体文件', mediaId);
    if (asset.userId !== userId) throw new ForbiddenError('无权访问该媒体');
    return asset;
  },

  /** 读取文件流所需的绝对路径与元信息。 */
  async readFile(asset: MediaAsset) {
    const filePath = mediaFilePath(asset.filename);
    if (!fs.existsSync(filePath)) {
      throw new NotFoundError('媒体文件（文件可能已被清理）', asset.id);
    }
    return { filePath, mimeType: asset.mimeType, sizeBytes: asset.sizeBytes };
  },

  async findById(mediaId: string) {
    return prisma.mediaAsset.findUnique({ where: { id: mediaId } });
  },

  /** 删除媒体（同时删文件）。 */
  async remove(userId: number, mediaId: string) {
    const asset = await this.getOwned(userId, mediaId);
    await prisma.mediaAsset.delete({ where: { id: asset.id } });
    removeMediaFile(asset.filename);
    return { success: true };
  },

  /** 设备被解绑时清理其媒体文件（数据库行由 cascade 删除，磁盘文件要手动删）。 */
  async purgeDeviceFiles(deviceId: string) {
    const assets = await prisma.mediaAsset.findMany({
      where: { deviceId },
      select: { filename: true },
    });
    for (const a of assets) removeMediaFile(a.filename);
    return assets.length;
  },
};

export { toMediaView };
