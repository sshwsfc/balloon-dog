import { Router, Request, Response } from 'express';
import { ah } from '../../shared/asyncHandler';
import { authenticate, authenticateDevice } from '../../middleware/auth';
import { currentUserId, parsePagination, resolveDevice } from '../../shared/deviceScope';
import { mediaService } from './media.service';
import { verifyMediaToken } from './media.signedUrl';
import { mediaUpload } from './media.storage';
import { verifyToken, extractBearer } from '../../shared/tokens';
import { BadRequestError } from '../../errors';

/**
 * 媒体访问路由。
 *
 * `GET /api/media/:mediaId` 有两条合法路径：
 *  1. `?t=<签名>` —— 供 `<img src>` 使用（签名绑定 mediaId 且短时效）；
 *  2. `Authorization: Bearer <家长令牌>` —— 供程序化下载使用。
 * 两条都不满足则 403。绝不提供「无凭据直读」的路径 —— 这是孩子屏幕内容，最敏感的数据。
 */
export const mediaRoutes = Router();

/** GET /api/media —— 列出当前设备的媒体（需登录）。 */
mediaRoutes.get(
  '/',
  authenticate,
  ah(async (req: Request, res: Response) => {
    const { take } = parsePagination(req.query, 50);
    const kind = typeof req.query.kind === 'string' ? req.query.kind : undefined;
    const device = await resolveDevice(req);
    const media = await mediaService.listForDevice(currentUserId(req), device.id, kind, take);
    res.json({ media });
  }),
);

/** GET /api/media/:mediaId —— 读原始文件（签名 或 家长令牌）。 */
mediaRoutes.get(
  '/:mediaId',
  ah(async (req: Request, res: Response) => {
    const mediaId = String(req.params.mediaId);
    const token = typeof req.query.t === 'string' ? req.query.t : '';

    let asset;
    if (token) {
      verifyMediaToken(mediaId, token);
      asset = await mediaService.findById(mediaId);
    } else {
      const payload = verifyToken(extractBearer(req));
      if (payload.kind !== 'user') throw new BadRequestError('该接口仅家长账号可访问');
      asset = await mediaService.getOwned(payload.sub, mediaId);
    }

    if (!asset) {
      return res.status(404).json({
        title: 'NOT_FOUND',
        status: 404,
        message: '媒体文件不存在',
        detail: null,
        errors: null,
        request_id: req.requestId,
      });
    }

    const { filePath, mimeType, sizeBytes } = await mediaService.readFile(asset);
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Length', String(sizeBytes));
    // 私有内容：禁止中间代理缓存；浏览器可短时缓存（签名本身会过期）
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.sendFile(filePath);
  }),
);

/** DELETE /api/media/:mediaId */
mediaRoutes.delete(
  '/:mediaId',
  authenticate,
  ah(async (req: Request, res: Response) => {
    res.json(await mediaService.remove(currentUserId(req), String(req.params.mediaId)));
  }),
);

/**
 * 设备端上传路由（挂载在 /api/agent/media）。
 * 设备把照片/截图/音视频回传，服务端落盘并关联到对应指令。
 */
export const mediaAgentRoutes = Router();

mediaAgentRoutes.post(
  '/',
  authenticateDevice,
  mediaUpload.single('file'),
  ah(async (req: Request, res: Response) => {
    const file = req.file;
    if (!file) throw new BadRequestError('请上传文件（表单字段名应为 file）');

    const kind = String(req.body?.kind ?? '').trim();
    if (!['photo', 'screenshot', 'video', 'audio'].includes(kind)) {
      throw new BadRequestError('kind 必须是 photo / screenshot / video / audio');
    }
    if (req.auth?.kind !== 'device') throw new BadRequestError('该接口仅设备端可访问');

    const asset = await mediaService.saveFromDevice({
      deviceId: req.auth.id,
      userId: req.auth.userId,
      kind,
      filename: file.filename,
      mimeType: file.mimetype,
      sizeBytes: file.size,
      commandId: req.body?.commandId ? String(req.body.commandId) : undefined,
    });

    res.status(201).json({ success: true, media: asset });
  }),
);
