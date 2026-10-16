import { prisma } from '../../prisma';
import { Prisma } from '@prisma/client';

/**
 * 通知域的数据访问层。
 *
 * `createIdempotent` 是这里唯一有讲究的方法：它必须**同时**做到
 * 「已存在就什么都不做」和「并发下也只留一条」。用 upsert + 空 update 实现，
 * 而不是先 findFirst 再 create —— 后者在设备每 3 分钟上报一次的压力下
 * 会稳定地漏出一条重复通知（先查后写的经典竞态）。
 */
export const notificationsRepo = {
  count: (where: Prisma.NotificationWhereInput) => prisma.notification.count({ where }),

  list: (where: Prisma.NotificationWhereInput, page: number, pageSize: number) =>
    prisma.notification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),

  unreadCount: (userId: number) =>
    prisma.notification.count({ where: { userId, readAt: null } }),

  findById: (userId: number, id: string) =>
    prisma.notification.findFirst({ where: { id, userId } }),

  /** 幂等写入：同一个人同一条事只留一条。返回 null 表示「已经有过了」。 */
  createIdempotent: async (data: {
    userId: number;
    deviceId: string | null;
    type: string;
    level: string;
    title: string;
    body: string;
    /** 标题/正文里的插值参数（`{{v0}}` 这类），见 schema 里 Notification.titleParams 的注释 */
    titleParams?: Record<string, string | number> | null;
    bodyParams?: Record<string, string | number> | null;
    linkPath: string;
    dedupeKey: string;
  }) => {
    const existing = await prisma.notification.findUnique({
      where: { userId_dedupeKey: { userId: data.userId, dedupeKey: data.dedupeKey } },
      select: { id: true },
    });
    if (existing) return null;
    return prisma.notification.create({
      data: {
        ...data,
        // Json 列要写 SQL NULL 必须用 Prisma.DbNull：直接给 null 会被当成「JSON 里的 null」，
        // Prisma 的类型也不收（它要求 DbNull / JsonNull 显式二选一）。
        titleParams: data.titleParams ?? Prisma.DbNull,
        bodyParams: data.bodyParams ?? Prisma.DbNull,
      },
    });
  },

  markRead: (userId: number, id: string) =>
    prisma.notification.updateMany({
      where: { id, userId, readAt: null },
      data: { readAt: new Date() },
    }),

  markAllRead: (userId: number) =>
    prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    }),

  remove: (userId: number, id: string) =>
    prisma.notification.deleteMany({ where: { id, userId } }),

  // ---------------- 站内之外的「再投递一次」（微信服务号模板消息） ----------------

  /**
   * 入队一条微信投递（幂等）。
   *
   * 用 upsert + 空 update 而不是 create：`notify` 在生产点被反复调用，
   * 重试/并发下同一条消息只该有一行投递记录 —— 重试是更新它，不是插新行。
   */
  enqueueWechatDelivery: (notificationId: string) =>
    prisma.notificationDelivery.upsert({
      where: { notificationId_channel: { notificationId, channel: 'wechat' } },
      create: { notificationId, channel: 'wechat' },
      update: {},
    }),

  /** 某条消息的微信投递行（测试发送接口用）。 */
  findWechatDelivery: (notificationId: string) =>
    prisma.notificationDelivery.findUnique({
      where: { notificationId_channel: { notificationId, channel: 'wechat' } },
    }),

  /**
   * 该家长待投递的行：还没发成功的（pending / failed 且未到重试上限），连带通知内容。
   *
   * 按 `createdAt` 正序 = 先发生的先发，家长在微信里看到的顺序和消息中心一致。
   */
  listDispatchableDeliveries: (userId: number, limit: number, maxAttempts: number) =>
    prisma.notificationDelivery.findMany({
      where: {
        channel: 'wechat',
        status: { in: ['pending', 'failed'] },
        attempts: { lt: maxAttempts },
        notification: { userId },
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
      include: {
        notification: {
          select: {
            id: true,
            title: true,
            titleParams: true,
            body: true,
            bodyParams: true,
            linkPath: true,
          },
        },
      },
    }),

  markDeliverySent: (id: string) =>
    prisma.notificationDelivery.update({
      where: { id },
      data: { status: 'sent', sentAt: new Date(), attempts: { increment: 1 }, lastError: '' },
    }),

  markDeliveryFailed: (id: string, lastError: string) =>
    prisma.notificationDelivery.update({
      where: { id },
      data: { status: 'failed', attempts: { increment: 1 }, lastError: lastError.slice(0, 500) },
    }),

  /** 最近一次投递（家长端偏好页用它回答「为什么没收到」）。 */
  latestDelivery: (userId: number, channel: string) =>
    prisma.notificationDelivery.findFirst({
      where: { channel, notification: { userId } },
      orderBy: { createdAt: 'desc' },
      select: { status: true, attempts: true, lastError: true, sentAt: true, createdAt: true },
    }),

  /** 该家长最近的一条通知（家长端「发一条测试消息」没有指定 id 时用它）。 */
  latestForUser: (userId: number) =>
    prisma.notification.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' } }),

  /** 该家长是否关掉了这一类事件的站内通知（没有记录 = 用默认值）。 */
  findPreference: (userId: number, type: string) =>
    prisma.notificationPreference.findUnique({
      where: { userId_type: { userId, type } },
    }),

  listPreferences: (userId: number) =>
    prisma.notificationPreference.findMany({ where: { userId } }),

  upsertPreference: (userId: number, type: string, data: { inApp: boolean; wechat: boolean; push: boolean }) =>
    prisma.notificationPreference.upsert({
      where: { userId_type: { userId, type } },
      create: { userId, type, ...data },
      update: data,
    }),
};
