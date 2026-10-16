import bcrypt from 'bcryptjs';
import type { ConsentRecord } from '@prisma/client';
import { prisma } from '../../prisma';
import { logger } from '../../logger';
import { BadRequestError, ConflictError, NotFoundError, UnauthorizedError } from '../../errors';
import { removeMediaFile } from '../media/media.storage';
import { removeBatchFiles } from '../insights/screen.storage';
import {
  COLLECTION_CATALOG,
  DELETION_CONFIRM_TEXT,
  DELETION_GRACE_DAYS,
  EXPORT_ROW_LIMIT,
  PRIVACY_DOCS,
  PRIVACY_DOC_VERSION,
  REVOKE_CONFIRM_TEXT,
} from './privacy.constants';

/**
 * 合规留痕、数据导出与注销（规划 §5.3）。
 *
 * 三件事的诚实边界，先写在前面：
 *
 * 1. **同意记录只追加**。撤回不改旧行（写 `revokedAt`），重新同意写新行 ——
 *    「我当时同意的是哪一版」必须在库里能查出来。文本改一个字就换版本号，
 *    旧版的同意不再算数，家长端会显示「需要重新同意」。
 *
 * 2. **撤回同意有真实后果**：立刻停止监控 —— **删除**这个账号下的设备记录
 *    （含设备上的照片、截屏文件，以及只按 `deviceId` 归档的事件）。设备行只置空
 *    `userId` 会同时踩两个坑：留下一个还能继续写上报的设备令牌，以及一台设备被
 *    下一个账号认领后露出来的上一个家庭的数据。账号、孩子档案与订单不受影响。
 *
 * 3. **注销先进 7 天冷静期**。申请时监控立刻停（同上，设备记录当场删除），到期由定时任务
 *    **真的删库**，并且**先删磁盘上的文件**：数据库删完就找不到文件名了，
 *    只删行不删文件等于没删。删除流水（`PrivacyRequest`）随账号一起被级联删掉，
 *    服务端日志里留下「删了哪个 id、多少台设备、多少个文件」（不含量）。
 *
 * 还没做的：管理后台的「强制解绑」只把 `userId` 置空，设备行连同它的事件、照片与设置
 * 都留着 —— 那台设备被下一个家长认领时会看到上一个家庭的数据。那是本轮之前就有的行为，
 * 修它要逐张表清理设备级数据并重置设置，单独一轮做（见 `docs/FEATURE-STATUS.md` §4）。
 *
 * 导出同理：媒体文件本身不进导出（可能几百 MB），导出的是元数据 + 文本，
 * 并在 `notes` 里如实写明这一点。
 */

export interface ConsentView {
  id: string;
  docType: string;
  docVersion: string;
  acceptedAt: string;
  revokedAt: string | null;
}

export interface ConsentStatusView {
  docType: string;
  title: string;
  version: string;
  required: boolean;
  /** 是否已经有**当前版本**的有效同意 */
  accepted: boolean;
  /** 有同意记录，但同意的是旧版本 —— 必须重新阅读并同意 */
  needsReaccept: boolean;
  record: ConsentView | null;
  history: ConsentView[];
}

export interface DeletionStatusView {
  scheduled: boolean;
  scheduledFor: string | null;
  graceDays: number;
  note: string;
  canCancel: boolean;
}

function toConsentView(row: ConsentRecord): ConsentView {
  return {
    id: row.id,
    docType: row.docType,
    docVersion: row.docVersion,
    acceptedAt: row.acceptedAt.toISOString(),
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
  };
}

function toDeletionView(
  user: { deletionScheduledAt: Date | null },
  note: string,
): DeletionStatusView {
  const scheduledFor = user.deletionScheduledAt;
  return {
    scheduled: scheduledFor != null,
    scheduledFor: scheduledFor ? scheduledFor.toISOString() : null,
    graceDays: DELETION_GRACE_DAYS,
    note,
    canCancel: scheduledFor != null,
  };
}

/**
 * 停止监控：**删掉**这个账号下的设备记录，并把磁盘上的照片/截屏删掉。
 *
 * 为什么不只把 `userId` 置空（这是最初写错的地方）：`DeviceEvent`、媒体、截屏批次
 * 这些数据**只按 `deviceId` 归档**，而一台设备被解绑后仍留在表里、还能被下一个账号
 * 用同一个设备码认领 —— 于是上一个家庭的事件与照片会出现在下一个家长眼前。
 * 「停止监控」的含义是这条监控通道连同它收集到的数据一起消失，所以只能删设备行。
 * 这与家长自己在「设备管理」里解绑的行为一致（`devicesRepo.remove()` 也是删行）。
 *
 * 磁盘文件必须显式删：数据库行没了就再也查不到文件名，那些孩子的照片会永远留在磁盘上。
 */
async function stopMonitoring(userId: number): Promise<number> {
  const devices = await prisma.childDevice.findMany({
    where: { userId },
    select: { id: true },
  });
  const deviceIds = devices.map((d) => d.id);
  if (deviceIds.length > 0) await purgeDeviceFiles(deviceIds);
  await prisma.$transaction([
    prisma.childDevice.deleteMany({ where: { id: { in: deviceIds } } }),
    // 当前设备指针必须清掉，否则会指向一台已经不存在的设备
    prisma.user.update({ where: { id: userId }, data: { activeDeviceId: null } }),
  ]);
  return deviceIds.length;
}

/** 删掉这些设备在磁盘上的照片与截屏包（数据库行的级联管不到文件）。 */
async function purgeDeviceFiles(deviceIds: string[]): Promise<{ mediaFiles: number; batches: number }> {
  if (deviceIds.length === 0) return { mediaFiles: 0, batches: 0 };
  const media = await prisma.mediaAsset.findMany({
    where: { deviceId: { in: deviceIds } },
    select: { filename: true },
  });
  for (const row of media) removeMediaFile(row.filename);

  const batches = await prisma.screenBatch.findMany({
    where: { deviceId: { in: deviceIds } },
    select: { id: true },
  });
  for (const row of batches) removeBatchFiles(row.id);

  return { mediaFiles: media.length, batches: batches.length };
}

async function requireUser(userId: number) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new NotFoundError('账号', String(userId));
  return user;
}

async function verifyPassword(userId: number, password: string): Promise<void> {
  const user = await requireUser(userId);
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) throw new UnauthorizedError('密码不正确');
}

export const privacyService = {
  /** 文本目录 + 最小必要采集清单。这是唯一的一份，导出文件也复用它。 */
  docs() {
    return {
      version: PRIVACY_DOC_VERSION,
      docs: PRIVACY_DOCS.map((d) => ({
        docType: d.docType,
        version: d.version,
        title: d.title,
        required: d.required,
        summary: d.summary,
        sections: d.sections,
      })),
      collection: COLLECTION_CATALOG,
      deletionGraceDays: DELETION_GRACE_DAYS,
      deletionConfirmText: DELETION_CONFIRM_TEXT,
      revokeConfirmText: REVOKE_CONFIRM_TEXT,
    };
  },

  /** 我对每一份文本的同意情况（含历史）。 */
  async listConsents(userId: number): Promise<ConsentStatusView[]> {
    const rows = await prisma.consentRecord.findMany({
      where: { userId },
      orderBy: { acceptedAt: 'desc' },
    });
    const byType = new Map<string, ConsentRecord[]>();
    for (const row of rows) {
      const list = byType.get(row.docType) ?? [];
      list.push(row);
      byType.set(row.docType, list);
    }
    return PRIVACY_DOCS.map((doc) => {
      const history = byType.get(doc.docType) ?? [];
      // rows 已按时间倒序：第一条未撤回的就是当前生效的那条
      const current = history.find((r) => r.revokedAt == null) ?? null;
      const staleVersion = current != null && current.docVersion !== doc.version;
      return {
        docType: doc.docType,
        title: doc.title,
        version: doc.version,
        required: doc.required,
        accepted: current != null && !staleVersion,
        needsReaccept: staleVersion,
        record: current ? toConsentView(current) : null,
        history: history.map(toConsentView),
      };
    });
  },

  /** 同意一份文本。带版本核对：客户端看的版本和当前不一致时必须重新读。 */
  async acceptConsent(
    userId: number,
    input: { docType: string; docVersion: string },
    meta: { ip: string; userAgent: string },
  ): Promise<{ record: ConsentView; created: boolean; needsReaccept: boolean }> {
    const doc = PRIVACY_DOCS.find((d) => d.docType === input.docType);
    if (!doc) throw new NotFoundError('合规文本', input.docType);
    if (input.docVersion !== doc.version) {
      throw new ConflictError(`《${doc.title}》已更新到 ${doc.version} 版，请重新阅读后再同意`);
    }
    const existing = await prisma.consentRecord.findFirst({
      where: { userId, docType: input.docType, docVersion: input.docVersion, revokedAt: null },
    });
    if (existing) return { record: toConsentView(existing), created: false, needsReaccept: false };
    const created = await prisma.consentRecord.create({
      data: {
        userId,
        docType: input.docType,
        docVersion: input.docVersion,
        ip: meta.ip,
        userAgent: meta.userAgent,
      },
    });
    return { record: toConsentView(created), created: true, needsReaccept: false };
  },

  /**
   * 撤回同意。**立刻解绑所有设备**（监控停止）——这是这个接口存在的意义，
   * 不然它就只是一个状态位。要求密码 + 手动打确认文字。
   */
  async revokeConsent(
    userId: number,
    consentId: string,
    input: { password: string; confirm: string },
  ): Promise<{ record: ConsentView; unboundDevices: number; stoppedMonitoring: boolean }> {
    const row = await prisma.consentRecord.findFirst({ where: { id: consentId, userId } });
    if (!row) throw new NotFoundError('同意记录', consentId);
    if (row.revokedAt) throw new ConflictError('这条同意记录已经撤回过了');
    if (input.confirm.trim() !== REVOKE_CONFIRM_TEXT) {
      throw new BadRequestError(`请手动输入「${REVOKE_CONFIRM_TEXT}」以确认`);
    }
    await verifyPassword(userId, input.password);

    const doc = PRIVACY_DOCS.find((d) => d.docType === row.docType);
    const stoppedMonitoring = doc?.required === true;
    const unboundDevices = stoppedMonitoring ? await stopMonitoring(userId) : 0;
    const updated = await prisma.consentRecord.update({
      where: { id: row.id },
      data: { revokedAt: new Date() },
    });
    logger.warn({
      msg: 'consent revoked',
      userId,
      docType: row.docType,
      docVersion: row.docVersion,
      unboundDevices,
    });
    return { record: toConsentView(updated), unboundDevices, stoppedMonitoring };
  },

  /** 注销状态：给家长端显示「还有几天」与撤销按钮。 */
  async deletionStatus(userId: number): Promise<DeletionStatusView> {
    const user = await requireUser(userId);
    const latest = await prisma.privacyRequest.findFirst({
      where: { userId, kind: 'deletion' },
      orderBy: { createdAt: 'desc' },
    });
    return toDeletionView(user, latest?.note ?? '');
  },

  /**
   * 申请注销：进 7 天冷静期并**立刻停止监控**。
   *
   * 为什么不立即删：注销是不可逆的，误触的代价是全家数据。7 天里家长随时能撤。
   * 为什么立刻解绑：冷静期是给「人」反悔用的，不是给数据继续上传用的。
   */
  async requestDeletion(
    userId: number,
    input: { password: string; confirm: string },
  ): Promise<DeletionStatusView> {
    const user = await requireUser(userId);
    if (user.deletionScheduledAt) {
      throw new ConflictError(
        `注销已经排期在 ${user.deletionScheduledAt.toISOString().slice(0, 10)}，可以在到期前撤销`,
      );
    }
    if (input.confirm.trim() !== DELETION_CONFIRM_TEXT) {
      throw new BadRequestError(`请手动输入「${DELETION_CONFIRM_TEXT}」以确认`);
    }
    await verifyPassword(userId, input.password);

    const unboundDevices = await stopMonitoring(userId);
    const scheduledFor = new Date(Date.now() + DELETION_GRACE_DAYS * 86_400_000);
    await prisma.privacyRequest.create({
      data: {
        userId,
        kind: 'deletion',
        status: 'scheduled',
        scheduledFor,
        note: `已停止监控并删除 ${unboundDevices} 台设备的记录（含照片与截屏）；${DELETION_GRACE_DAYS} 天内可撤销`,
      },
    });
    const updated = await prisma.user.update({
      where: { id: userId },
      data: { deletionScheduledAt: scheduledFor },
    });
    logger.warn({ msg: 'account deletion scheduled', userId, unboundDevices, scheduledFor });
    const latest = await prisma.privacyRequest.findFirst({
      where: { userId, kind: 'deletion' },
      orderBy: { createdAt: 'desc' },
    });
    return toDeletionView(updated, latest?.note ?? '');
  },

  /**
   * 冷静期内撤销注销。**只恢复状态，不恢复设备**：停止监控时设备记录（含照片、截屏）
   * 已经删掉了，重新监控要重新绑定 —— 撤销能救回账号、孩子档案与订单，救不回监控数据。
   */
  async cancelDeletion(userId: number): Promise<DeletionStatusView> {
    const user = await requireUser(userId);
    if (!user.deletionScheduledAt) throw new ConflictError('当前没有待生效的注销申请');
    await prisma.privacyRequest.create({
      data: {
        userId,
        kind: 'deletion',
        status: 'cancelled',
        note: '家长在冷静期内撤销了注销；设备记录已删除，重新监控需要重新绑定设备',
      },
    });
    const updated = await prisma.user.update({
      where: { id: userId },
      data: { deletionScheduledAt: null },
    });
    logger.info({ msg: 'account deletion cancelled', userId });
    return toDeletionView(updated, '已撤销注销；设备记录已删除，需要重新绑定设备');
  },

  /**
   * 导出我的数据。一次返回完整 JSON（不是异步打包任务——本项目的数据量用不上下载中心，
   * 真到几万条时再换，不预先假装有）。
   *
   * 只导出**这个账号自己的**数据：导出接口天然是最容易越权的一个，
   * e2e 里专门有一条断言「另一个家长的设备名不出现在我的导出里」。
   */
  async exportData(userId: number) {
    const user = await requireUser(userId);
    const devices = await prisma.childDevice.findMany({
      where: { userId },
      select: { id: true, name: true, model: true, status: true, locked: true, childId: true, createdAt: true },
    });
    const deviceIds = devices.map((d) => d.id);
    const take = EXPORT_ROW_LIMIT;
    const truncated: string[] = [];

    const [children, tasks, consents, requests, notifications, timeRequests, commands, locations, events, media, quizRecords, orders, rewards, withdrawals] =
      await Promise.all([
        prisma.child.findMany({
          where: { userId },
          select: { id: true, name: true, birthYear: true, school: true, createdAt: true },
        }),
        prisma.childTask.findMany({
          where: { child: { userId } },
          select: { id: true, childId: true, title: true, date: true, doneAt: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
          take,
        }),
        prisma.consentRecord.findMany({ where: { userId }, orderBy: { acceptedAt: 'desc' } }),
        prisma.privacyRequest.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } }),
        prisma.notification.findMany({
          where: { userId },
          select: { id: true, type: true, title: true, titleParams: true, body: true, bodyParams: true, level: true, readAt: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
          take,
        }),
        prisma.timeRequest.findMany({
          where: { deviceId: { in: deviceIds } },
          select: { id: true, deviceId: true, minutes: true, reason: true, status: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
          take,
        }),
        prisma.deviceCommand.findMany({
          where: { deviceId: { in: deviceIds } },
          select: { id: true, deviceId: true, type: true, status: true, createdAt: true, finishedAt: true },
          orderBy: { createdAt: 'desc' },
          take,
        }),
        prisma.locationRecord.findMany({
          where: { deviceId: { in: deviceIds } },
          select: { id: true, deviceId: true, latitude: true, longitude: true, address: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
          take,
        }),
        prisma.deviceEvent.findMany({
          where: { deviceId: { in: deviceIds } },
          select: { id: true, deviceId: true, type: true, detail: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
          take,
        }),
        prisma.mediaAsset.findMany({
          where: { OR: [{ userId }, { deviceId: { in: deviceIds } }] },
          select: { id: true, deviceId: true, kind: true, mimeType: true, sizeBytes: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
          take,
        }),
        prisma.quizRecord.findMany({
          where: { userId },
          select: { id: true, deviceId: true, isCorrect: true, rewardMinutes: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
          take,
        }),
        prisma.membershipOrder.findMany({
          where: { userId },
          select: { id: true, orderNo: true, planCode: true, tier: true, period: true, amountCents: true, status: true, createdAt: true, paidAt: true },
          orderBy: { createdAt: 'desc' },
          take,
        }),
        prisma.referralReward.findMany({
          where: { inviterId: userId },
          select: { id: true, inviteeId: true, kind: true, amountCents: true, status: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
          take,
        }),
        prisma.referralWithdrawal.findMany({
          where: { userId },
          select: { id: true, amountCents: true, status: true, createdAt: true, reviewedAt: true },
          orderBy: { createdAt: 'desc' },
          take,
        }),
      ]);

    // 各列表取上限：真到几万条时如实标出来，不假装导出是全量的
    const capped: Array<[string, number]> = [
      ['tasks', tasks.length],
      ['notifications', notifications.length],
      ['timeRequests', timeRequests.length],
      ['commands', commands.length],
      ['locations', locations.length],
      ['deviceEvents', events.length],
      ['media', media.length],
      ['quizRecords', quizRecords.length],
      ['orders', orders.length],
      ['referralRewards', rewards.length],
      ['withdrawals', withdrawals.length],
    ];
    for (const [name, count] of capped) {
      if (count >= take) truncated.push(name);
    }

    const payload = {
      generatedAt: new Date().toISOString(),
      docVersion: PRIVACY_DOC_VERSION,
      account: {
        id: user.id,
        phone: user.phone,
        email: user.email,
        nickname: user.nickname,
        avatar: user.avatar,
        status: user.status,
        createdAt: user.createdAt.toISOString(),
        membership: {
          tier: user.membershipTier,
          expiresAt: user.membershipExpiresAt ? user.membershipExpiresAt.toISOString() : null,
          autoRenew: user.membershipAutoRenew,
          startedAt: user.membershipStartedAt ? user.membershipStartedAt.toISOString() : null,
        },
        realName: user.realName,
        idCardTail: user.idCardTail,
        inviteCode: user.inviteCode,
        deletionScheduledAt: user.deletionScheduledAt
          ? user.deletionScheduledAt.toISOString()
          : null,
      },
      devices,
      children,
      tasks,
      consents: consents.map(toConsentView),
      privacyRequests: requests,
      notifications,
      timeRequests,
      commands,
      locations,
      deviceEvents: events,
      media,
      quizRecords,
      orders,
      referral: { rewards, withdrawals },
      collection: COLLECTION_CATALOG,
      truncated,
      notes: [
        `每个列表最多导出 ${take} 条；达到上限的列表已列在 truncated 里。`,
        '拍照、录屏、录音与截屏帧图的**文件本身**不在导出里（可能几百 MB），这里只有元数据；文件可以在应用内逐条查看。',
        '密码哈希、微信 openid、身份证哈希不出现在导出里。',
      ],
    };

    // 导出也是取证行为：留一行流水，说清谁在什么时候取走了什么
    await prisma.privacyRequest.create({
      data: {
        userId,
        kind: 'export',
        status: 'done',
        note: `导出 ${devices.length} 台设备、${children.length} 个孩子、${notifications.length} 条通知等数据`,
      },
    });
    logger.info({ msg: 'privacy export', userId, devices: devices.length, media: media.length });
    return payload;
  },

  /**
   * 真的删除一个账号（冷静期到期后由定时任务调用）。
   *
   * 顺序很重要：**先删磁盘文件，再删数据库行**。反过来的话，
   * 数据库行没了就再也查不到文件名，那些孩子的照片会永远留在磁盘上。
   */
  async hardDeleteUser(userId: number): Promise<{ devices: number; mediaFiles: number; batches: number }> {
    const devices = await prisma.childDevice.findMany({ where: { userId }, select: { id: true } });
    const deviceIds = devices.map((d) => d.id);

    const media = await prisma.mediaAsset.findMany({
      where: { OR: [{ userId }, { deviceId: { in: deviceIds } }] },
      select: { filename: true },
    });
    for (const row of media) removeMediaFile(row.filename);

    const batches = await prisma.screenBatch.findMany({
      where: { deviceId: { in: deviceIds } },
      select: { id: true },
    });
    for (const row of batches) removeBatchFiles(row.id);

    // 设备通常已经在「注销申请」那一步被 `stopMonitoring()` 删掉了，这里再删一次是兜底：
    // 只要还有任何路径把 `ChildDevice.userId` 置空（历史数据、管理后台强制解绑），
    // 按 `userId` 的级联就会静默漏掉一台「设备行还在、设备令牌还能用」的孤儿设备。
    // 注销是法律动作，宁可多一条 deleteMany。设备上的命令、事件、媒体、截屏批次
    // 都是 device 级联，会跟着设备行一起走。
    await prisma.childDevice.deleteMany({ where: { userId } });

    // User 的级联会把成员、孩子与任务、通知、同意记录、订单、奖励一起带走
    await prisma.user.delete({ where: { id: userId } });
    logger.warn({
      msg: 'account hard deleted',
      userId,
      devices: deviceIds.length,
      mediaFiles: media.length,
      batches: batches.length,
    });
    return { devices: deviceIds.length, mediaFiles: media.length, batches: batches.length };
  },

  /** 到期注销的清扫（定时任务 + 惰性调用）。返回这一轮真的删了几个账号。 */
  async sweepExpiredDeletions(): Promise<{ users: number; devices: number }> {
    const due = await prisma.user.findMany({
      where: { deletionScheduledAt: { not: null, lte: new Date() } },
      select: { id: true },
      orderBy: { deletionScheduledAt: 'asc' },
      take: 50,
    });
    let devices = 0;
    let users = 0;
    for (const row of due) {
      try {
        const result = await privacyService.hardDeleteUser(row.id);
        devices += result.devices;
        users += 1;
      } catch (err) {
        logger.error({
          msg: 'hard delete failed',
          userId: row.id,
          error: (err as Error).message,
        });
      }
    }
    return { users, devices };
  },
};
