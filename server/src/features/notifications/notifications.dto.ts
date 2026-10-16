import { z } from 'zod';
import { NOTIFICATION_LEVELS, NOTIFICATION_TYPES } from './notifications.constants';

/** GET /api/notifications —— 消息中心列表。 */
export const listNotificationsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
  /** 只看未读（家长端「未读」筛选） */
  unreadOnly: z.coerce.boolean().default(false),
  /** 按类型筛选；不传 = 全部 */
  type: z.enum(NOTIFICATION_TYPES as [string, ...string[]]).optional(),
  level: z.enum(NOTIFICATION_LEVELS).optional(),
});

export const notificationIdSchema = z.object({ notificationId: z.string().trim().min(1) });

/**
 * POST /api/notifications/channels/wechat/test
 *
 * 不传 `notificationId` = 发最近的一条。家长在偏好页点「发一条测试消息」时，
 * 大多数情况下他只是想确认「这个通道通不通」，指定具体某条反而多余。
 */
export const testWechatSchema = z.object({
  notificationId: z.string().trim().min(1).optional(),
});

/**
 * PUT /api/notifications/preferences
 *
 * 整份替换而不是逐条 PATCH：家长端的偏好页永远一次性展示全部类型，
 * 逐条接口只会让前端多写一圈「哪些改过」的记账逻辑。
 */
export const updateNotificationPreferencesSchema = z.object({
  preferences: z
    .array(
      z.object({
        type: z.enum(NOTIFICATION_TYPES as [string, ...string[]]),
        inApp: z.boolean(),
        /**
         * 站内之外的通道。
         *
         * `wechat` 已接入（规划 §2.1 第二档：微信服务号模板消息），默认 `false` ——
         * 新通道必须家长显式打开，不能一上线就让所有人的手机开始响。
         * `push`（厂商推送）**不适用**：家长端是移动网页，没有原生客户端能收推送，
         * 这里仍然接受取值是为了「家长确实选过」这件事不丢，但服务端永远不会发，
         * 家长端按 `channels.push.configured === false` 显示原因而不是给一个假开关。
         */
        wechat: z.boolean().optional(),
        push: z.boolean().optional(),
      }),
    )
    .max(NOTIFICATION_TYPES.length),
});
