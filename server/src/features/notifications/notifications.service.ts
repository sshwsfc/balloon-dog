import { logger } from '../../logger';
import { BadRequestError, NotFoundError, ServiceUnavailableError } from '../../errors';
import { prisma } from '../../prisma';
import { wechatTemplateConfigured } from '../../config';
import { notificationsRepo } from './notifications.repository';
import {
  MEMBERSHIP_EXPIRING_DAYS,
  NOTIFICATION_BODY_MAX,
  NOTIFICATION_TITLE_MAX,
  NOTIFICATION_TYPE_DEFS,
  PUSH_NOT_APPLICABLE_REASON,
  WECHAT_DELIVERY_MAX_ATTEMPTS,
  WECHAT_DISPATCH_BATCH,
  clampText,
  defaultInAppOf,
  notificationTypeDef,
} from './notifications.constants';
import { WechatSendError, renderTemplate, sendWechatTemplate } from './notifications.wechat';
import { flagEnabled } from '../flags/flags.service';

/** 生产点（设备域、模式域、会员域）调用 `notify` 时给的东西。 */
export interface NotifyInput {
  userId: number;
  type: string;
  /**
   * 标题**模板**：固定句子直接写（它本身就是 i18n key）；带变量的句子写成
   * `'{{v0}} 已失联'` 并把变量放进 `titleParams`。**不要把变量拼进中文句子里** ——
   * 那样整句都不再是一个 key，英文界面会直接露出中文（浏览器 e2e 的英文扫描抓到过这类缺陷）。
   */
  title: string;
  body?: string;
  /** 标题模板里的 `{{v0}}` / `{{v1}}` 实际值 */
  titleParams?: Record<string, string | number> | null;
  /** 正文模板里的插值参数 */
  bodyParams?: Record<string, string | number> | null;
  /** 不传就用类型定义里的默认级别 */
  level?: 'info' | 'warn' | 'danger';
  /** 不传就用类型定义里的默认路径 */
  linkPath?: string;
  deviceId?: string | null;
  /**
   * 幂等键：同一个人同一条事只出现一次。
   * 必须带上「这次是哪一个具体事件」的信息（缺口 id、审核单 id、到期日），
   * 否则第二次同样的事就被吞掉了（例如修好又坏掉，家长应该再收到一次）。
   */
  dedupeKey: string;
}

function ymd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export const notificationsService = {
  /**
   * 写一条站内通知。
   *
   * **永不抛错、永不阻断业务**：通知是副作用，发不出去不该让「上报健康」「进出安全区」
   * 这些主流程失败 —— 主流程的数据比一条通知重要得多。所以这里把异常吃成日志。
   * 返回 `null` 表示「没写」（重复 / 家长关掉了这一类 / 类型不在白名单）。
   */
  async notify(input: NotifyInput): Promise<{ id: string } | null> {
    try {
      const def = notificationTypeDef(input.type);
      if (!def) {
        logger.warn({ type: input.type }, '未知的通知类型，已忽略');
        return null;
      }
      // 在**写入侧**判定偏好，而不是前端过滤：前端过滤会让「关掉之后还堆着一堆未读」
      // 变成家长的困惑，而且未读角标会一直亮着。
      const pref = await notificationsRepo.findPreference(input.userId, input.type);
      const inApp = pref ? pref.inApp : defaultInAppOf(input.type);
      if (!inApp) return null;
      const created = await notificationsRepo.createIdempotent({
        userId: input.userId,
        deviceId: input.deviceId ?? null,
        type: input.type,
        level: input.level ?? def.defaultLevel,
        title: clampText(input.title, NOTIFICATION_TITLE_MAX),
        body: clampText(input.body ?? '', NOTIFICATION_BODY_MAX),
        titleParams: input.titleParams ?? null,
        bodyParams: input.bodyParams ?? null,
        linkPath: input.linkPath ?? def.linkPath,
        dedupeKey: input.dedupeKey,
      });
      // 站内写成功后，再决定要不要「顺手发一条到微信」。**只在真的新建了行时**入队：
      // 幂等命中说明家长早就收到过这条，重复投递会变成骚扰。
      if (created) await notificationsService.enqueueWechatDelivery(created.id, input.userId, input.type);
      return created;
    } catch (error: unknown) {
      logger.error({ err: error, type: input.type, userId: input.userId }, '写站内通知失败（已忽略）');
      return null;
    }
  },

  /**
   * 消息中心列表。
   *
   * 读接口里做一次惰性检查（会员到期提醒）—— 和「设备失联补记」同一个取舍：
   * 没有定时任务（这个项目刻意不引入队列/调度器），所以把「该提醒的提醒一下」
   * 挂在家长真的来看消息的那一刻。代价是来的那一刻会多一两个查询，
   * 换来的是不需要一个可能挂掉、可能重复发、需要额外运维的定时器。
   */
  async list(
    userId: number,
    query: { page: number; pageSize: number; unreadOnly: boolean; type?: string; level?: string },
  ) {
    await notificationsService.runLazyChecks(userId);
    const where = {
      userId,
      ...(query.unreadOnly ? { readAt: null } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.level ? { level: query.level } : {}),
    };
    const [total, items, unreadCount] = await Promise.all([
      notificationsRepo.count(where),
      notificationsRepo.list(where, query.page, query.pageSize),
      notificationsRepo.unreadCount(userId),
    ]);
    return {
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
      unreadCount,
      items: items.map(toNotificationView),
    };
  },

  /** 未读角标。也跑一次惰性检查，否则家长不点开消息中心就永远看不到到期提醒。 */
  async unreadCount(userId: number) {
    await notificationsService.runLazyChecks(userId);
    return { unreadCount: await notificationsRepo.unreadCount(userId) };
  },

  async markRead(userId: number, id: string) {
    const row = await notificationsRepo.findById(userId, id);
    if (!row) throw new NotFoundError('通知', id);
    await notificationsRepo.markRead(userId, id);
    return { unreadCount: await notificationsRepo.unreadCount(userId) };
  },

  async markAllRead(userId: number) {
    await notificationsRepo.markAllRead(userId);
    return { unreadCount: 0 };
  },

  async remove(userId: number, id: string) {
    const row = await notificationsRepo.findById(userId, id);
    if (!row) throw new NotFoundError('通知', id);
    await notificationsRepo.remove(userId, id);
    return { unreadCount: await notificationsRepo.unreadCount(userId) };
  },

  /**
   * 通知偏好：列全部类型（含没改过的），把「通道到底能不能发」如实说清楚。
   *
   * 微信通道有**三个**独立条件，缺哪一条就如实说哪一条，而不是笼统一个 `configured`：
   *  1. 服务端配置齐了（公众号 AppID + AppSecret + 模板 ID）；
   *  2. 这个家长绑过微信（`User.wechatOpenid`，用微信扫码登录一次即可）；
   *  3. 这类事件的微信开关被家长打开（默认关，新通道不默认轰炸）。
   * 少了 (1) 或 (2)，界面显示的是「未配置 / 未绑定」而不是一个点了没反应的开关。
   *
   * 厂商推送**不适用**（家长端是移动网页，没有原生客户端可收推送），
   * 这里给出 `reason` 让界面说明白，而不是留一个永远不生效的开关。
   */
  async preferences(userId: number) {
    const rows = await notificationsRepo.listPreferences(userId);
    const byType = new Map(rows.map((r) => [r.type, r]));
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { wechatOpenid: true },
    });
    const bound = Boolean(user?.wechatOpenid);
    const lastDelivery = await notificationsRepo.latestDelivery(userId, 'wechat');
    return {
      channels: {
        wechat: {
          configured: wechatTemplateConfigured,
          bound,
          label: '微信服务号消息',
          hint: !wechatTemplateConfigured
            ? '服务端还没有配置公众号模板消息，现在发不出去。'
            : bound
              ? ''
              : '这个账号还没有绑定微信，用微信扫码登录一次即可绑定。',
          /** 最近一次投递的结果：家长问「为什么没收到」时，界面能直接答 */
          lastDelivery: lastDelivery
            ? {
                status: lastDelivery.status,
                attempts: lastDelivery.attempts,
                lastError: lastDelivery.lastError,
                sentAt: lastDelivery.sentAt,
                createdAt: lastDelivery.createdAt,
              }
            : null,
        },
        push: { configured: false, label: '厂商推送', reason: PUSH_NOT_APPLICABLE_REASON },
      },
      items: NOTIFICATION_TYPE_DEFS.map((def) => {
        const row = byType.get(def.type);
        return {
          type: def.type,
          label: def.label,
          inApp: row ? row.inApp : def.defaultInApp,
          wechat: row ? row.wechat : false,
          push: row ? row.push : false,
        };
      }),
    };
  },

  async updatePreferences(
    userId: number,
    items: { type: string; inApp: boolean; wechat?: boolean; push?: boolean }[],
  ) {
    for (const item of items) {
      await notificationsRepo.upsertPreference(userId, item.type, {
        inApp: item.inApp,
        wechat: item.wechat ?? false,
        push: item.push ?? false,
      });
    }
    return notificationsService.preferences(userId);
  },

  // ---------------- 站内之外的投递（微信服务号模板消息，规划 §2.1 第二档） ----------------

  /**
   * 决定要不要给一条刚写下的通知「再发一条到微信」。
   *
   * 三个条件缺一不可（见 `preferences`）：服务端配好了、家长绑过微信、家长为**这一类**
   * 打开了微信开关。任何一个不满足就**连投递行都不建** —— 建了再不发，就是在库里堆
   * 一堆永远不会成功、也不该被重试的僵尸记录。
   *
   * 永远不抛错：通知是副作用，发不出去不该让「上报健康」这类主流程失败。
   */
  async enqueueWechatDelivery(notificationId: string, userId: number, type: string): Promise<void> {
    try {
      if (!wechatTemplateConfigured) return;
      // 运营总闸（规划 §5.5）：微信在抽风时可以立刻停止出站，而不是等家长去关自己的开关。
      // 关掉时**连投递行都不建** —— 否则库里会堆一堆永远发不出去、也不该被重试的僵尸记录。
      if (!(await flagEnabled('notify.wechat.dispatch'))) return;
      const pref = await notificationsRepo.findPreference(userId, type);
      if (!pref?.wechat) return;
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { wechatOpenid: true },
      });
      if (!user?.wechatOpenid) return;
      await notificationsRepo.enqueueWechatDelivery(notificationId);
    } catch (error: unknown) {
      logger.error({ err: error, notificationId, userId }, '入队微信投递失败（已忽略）');
    }
  },

  /**
   * 惰性派发该家长待发的微信投递。
   *
   * 挂在「家长打开消息中心」这条路径上（`runLazyChecks`），和会员到期提醒同一个取舍：
   * 不引入队列/调度器。代价是家长不来就不发，但对「提醒家长去看消息中心」这个通道来说，
   * 家长正在看的那一刻本来也够用了。
   *
   * 失败不删行：到 `WECHAT_DELIVERY_MAX_ATTEMPTS` 为止会随家长每次打开重试，
   * 超过之后留在 `failed` 并且 `lastError` 可查（投递记录要能回答「为什么没收到」）。
   */
  async dispatchWechatDeliveries(userId: number): Promise<void> {
    if (!wechatTemplateConfigured) return;
    // 总闸关掉时**不出站**：已经排队的行留在 pending，等总闸恢复后照常发出。
    // 这与「投递失败」是两件事，所以不写 lastError，家长偏好页也不会看到一条假故障。
    if (!(await flagEnabled('notify.wechat.dispatch'))) return;
    const rows = await notificationsRepo.listDispatchableDeliveries(
      userId,
      WECHAT_DISPATCH_BATCH,
      WECHAT_DELIVERY_MAX_ATTEMPTS,
    );
    if (rows.length === 0) return;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { wechatOpenid: true },
    });
    if (!user?.wechatOpenid) {
      // 没绑定就发不出去。**不把它标成失败**：这不是投递失败，而是「还没到时候」——
      // 家长绑定微信之后这些消息应该照常发出（偏好页会显示「未绑定」）。
      logger.debug({ userId, pending: rows.length }, '家长未绑定微信，微信投递继续等待');
      return;
    }

    for (const row of rows) {
      const payload = {
        openid: user.wechatOpenid,
        title: renderTemplate(row.notification.title, row.notification.titleParams as Record<string, unknown> | null),
        body: renderTemplate(row.notification.body, row.notification.bodyParams as Record<string, unknown> | null),
        linkPath: row.notification.linkPath,
      };
      try {
        await sendWechatTemplate(payload);
        await notificationsRepo.markDeliverySent(row.id);
      } catch (error: unknown) {
        const message = error instanceof WechatSendError ? error.message : '微信接口暂时不可用';
        await notificationsRepo.markDeliveryFailed(row.id, message);
      }
    }
  },

  /**
   * 手动把一条通知发到微信（家长端「发一条测试消息」）。
   *
   * 与派发共用同一条发送路径，区别是**同步返回结果**并把失败原因抛给家长看：
   * 配置类问题（模板 ID 不对、字段名不匹配、没关注公众号）只有当场看到 errcode
   * 原文才排查得动，去翻服务端日志不现实。
   */
  async sendWechatTest(userId: number, notificationId?: string) {
    if (!wechatTemplateConfigured) {
      throw new ServiceUnavailableError('微信服务号消息还没有配置，现在发不出去', 'WECHAT_NOT_CONFIGURED');
    }
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { wechatOpenid: true },
    });
    if (!user?.wechatOpenid) {
      throw new BadRequestError('这个账号还没有绑定微信，请先用微信扫码登录一次');
    }
    const target = notificationId
      ? await notificationsRepo.findById(userId, notificationId)
      : await notificationsRepo.latestForUser(userId);
    if (!target) throw new NotFoundError('可发送的消息');

    const delivery = await notificationsRepo.enqueueWechatDelivery(target.id);
    try {
      await sendWechatTemplate({
        openid: user.wechatOpenid,
        title: renderTemplate(target.title, target.titleParams as Record<string, unknown> | null),
        body: renderTemplate(target.body, target.bodyParams as Record<string, unknown> | null),
        linkPath: target.linkPath,
      });
      await notificationsRepo.markDeliverySent(delivery.id);
      return { sent: true, notificationId: target.id };
    } catch (error: unknown) {
      const message = error instanceof WechatSendError ? error.message : '微信接口暂时不可用，请稍后重试';
      await notificationsRepo.markDeliveryFailed(delivery.id, message);
      throw new ServiceUnavailableError(`发送失败：${message}`, 'WECHAT_SEND_FAILED');
    }
  },

  /**
   * 惰性检查（当前只有会员到期）。刻意做成幂等的：同一个到期日只会有一条提醒，
   * 因为 dedupeKey 里带了那一天。
   */
  async runLazyChecks(userId: number) {
    try {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { membershipTier: true, membershipExpiresAt: true },
      });
      if (!user || user.membershipTier === 'ordinary' || !user.membershipExpiresAt) return;

      const msLeft = user.membershipExpiresAt.getTime() - Date.now();
      if (msLeft <= 0) return; // 已过期由 resolveMembership 降级处理，这里不重复提醒
      if (msLeft > MEMBERSHIP_EXPIRING_DAYS * 24 * 60 * 60 * 1000) return;

      const days = Math.ceil(msLeft / (24 * 60 * 60 * 1000));
      await notificationsService.notify({
        userId,
        type: 'membership_expiring',
        title: days <= 1 ? '会员将在 1 天内到期' : '会员将在 {{v0}} 天后到期',
        titleParams: days <= 1 ? null : { v0: days },
        body: '到期后孩子的答题解锁、远程监控与绑定设备会停止。可以提前续费，续费按常规定价、时间是接着算的。',
        // 同一天不会重复提醒；换一次续费日期就是新的一条
        dedupeKey: `membership_expiring:${ymd(user.membershipExpiresAt)}`,
      });
    } catch (error: unknown) {
      logger.error({ err: error, userId }, '惰性通知检查失败（已忽略）');
    } finally {
      // 待发的微信投递必须在 `finally` 里发：会员到期提醒那段对**普通账号**会提前
      // `return`（绝大多数家长都是普通账号），写在 try/catch 后面就等于永远走不到。
      // 同一处惰性时机，不引入第二个调度点。
      try {
        await notificationsService.dispatchWechatDeliveries(userId);
      } catch (error: unknown) {
        logger.error({ err: error, userId }, '惰性派发微信投递失败（已忽略）');
      }
    }
  },
};

function toNotificationView(row: {
  id: string;
  type: string;
  level: string;
  title: string;
  body: string;
  titleParams: unknown;
  bodyParams: unknown;
  linkPath: string;
  deviceId: string | null;
  readAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: row.id,
    type: row.type,
    typeLabel: notificationTypeDef(row.type)?.label ?? row.type,
    level: row.level,
    title: row.title,
    body: row.body,
    // 前端渲染时 t(title, titleParams) / t(body, bodyParams)：
    // 中文界面因为 zh 没有词典，i18next 原样回显 key 并完成插值，与之前完全一致。
    titleParams: (row.titleParams ?? null) as Record<string, string | number> | null,
    bodyParams: (row.bodyParams ?? null) as Record<string, string | number> | null,
    linkPath: row.linkPath,
    deviceId: row.deviceId,
    read: row.readAt !== null,
    readAt: row.readAt,
    createdAt: row.createdAt,
  };
}
