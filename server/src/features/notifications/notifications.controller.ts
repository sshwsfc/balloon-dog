import { Router, Request, Response } from 'express';
import { ah } from '../../shared/asyncHandler';
import { authenticate } from '../../middleware/auth';
import { currentUserId } from '../../shared/deviceScope';
import { notificationsService } from './notifications.service';
import {
  listNotificationsSchema,
  notificationIdSchema,
  testWechatSchema,
  updateNotificationPreferencesSchema,
} from './notifications.dto';

/**
 * 家长端消息中心（规划 §2.1 第一档）。
 *
 * 全部挂在这一个 router 下并整体要求登录：通知天然是「我的」，
 * 没有跨用户的读法。设备归属在这里**不需要**校验 —— 通知行本身是按
 * `userId` 写的（`notify` 的生产点都从已鉴权的家长链路进入），
 * 所以按 userId 查出来的行不可能属于别人。
 */
export const notificationRoutes = Router();
notificationRoutes.use(authenticate);

/** GET /api/notifications —— 消息中心列表（分页 + 未读筛选）。 */
notificationRoutes.get(
  '/',
  ah(async (req: Request, res: Response) => {
    const query = listNotificationsSchema.parse(req.query);
    res.json(await notificationsService.list(currentUserId(req), query));
  }),
);

/** GET /api/notifications/unread-count —— 未读角标。 */
notificationRoutes.get(
  '/unread-count',
  ah(async (req: Request, res: Response) => {
    res.json(await notificationsService.unreadCount(currentUserId(req)));
  }),
);

/** POST /api/notifications/read-all —— 全部标为已读。 */
notificationRoutes.post(
  '/read-all',
  ah(async (req: Request, res: Response) => {
    res.json(await notificationsService.markAllRead(currentUserId(req)));
  }),
);

/** GET /api/notifications/preferences —— 逐类开关 + 通道是否已接入。 */
notificationRoutes.get(
  '/preferences',
  ah(async (req: Request, res: Response) => {
    res.json(await notificationsService.preferences(currentUserId(req)));
  }),
);

/** PUT /api/notifications/preferences —— 整份保存。 */
notificationRoutes.put(
  '/preferences',
  ah(async (req: Request, res: Response) => {
    const body = updateNotificationPreferencesSchema.parse(req.body);
    res.json(await notificationsService.updatePreferences(currentUserId(req), body.preferences));
  }),
);

/**
 * POST /api/notifications/channels/wechat/test —— 往微信发一条，当场返回结果。
 *
 * 做成同步接口（而不是「入队然后请稍后查看」）是刻意的：配置类错误
 * （模板 ID 不对、字段名不匹配、家长没关注公众号）**必须当场看到微信的 errcode 原文**
 * 才排查得动。失败原因同时写进投递记录，消息中心偏好页看得到。
 */
notificationRoutes.post(
  '/channels/wechat/test',
  ah(async (req: Request, res: Response) => {
    const body = testWechatSchema.parse(req.body ?? {});
    res.json(await notificationsService.sendWechatTest(currentUserId(req), body.notificationId));
  }),
);

/** POST /api/notifications/:notificationId/read */
notificationRoutes.post(
  '/:notificationId/read',
  ah(async (req: Request, res: Response) => {
    const { notificationId } = notificationIdSchema.parse(req.params);
    res.json(await notificationsService.markRead(currentUserId(req), notificationId));
  }),
);

/** DELETE /api/notifications/:notificationId —— 删掉一条（家长自己清理）。 */
notificationRoutes.delete(
  '/:notificationId',
  ah(async (req: Request, res: Response) => {
    const { notificationId } = notificationIdSchema.parse(req.params);
    res.json(await notificationsService.remove(currentUserId(req), notificationId));
  }),
);

