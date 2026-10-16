import { randomBytes } from 'node:crypto';
import type { Prisma, SupportTicket } from '@prisma/client';
import { prisma } from '../../prisma';
import { logger } from '../../logger';
import { BadRequestError, ConflictError, NotFoundError, ServiceUnavailableError } from '../../errors';
import { config } from '../../config';
import { flagEnabled } from '../flags/flags.service';
import {
  TICKET_BODY_MAX,
  TICKET_CATEGORIES,
  TICKET_CATEGORY_KEYS,
  TICKET_OPEN_LIMIT,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  TICKET_STATUS_LABELS,
  type TicketPriority,
  type TicketStatus,
} from './support.constants';

/**
 * 客服工单（规划 §5.5）。
 *
 * 三条设计取舍：
 *
 * 1. **回复存在 `replies` JSON 里**，不另建表。工单的回复永远是「按时间读一遍」，
 *    没有任何一条回复会被单独查询或更新；为它建表只会多一个 join 和一次迁移。
 * 2. **家长看不到是谁回的**。家长端只回 `body` 与 `at` —— 值班的是哪位管理员
 *    与家长无关，回传 `adminId` 只会把内部账号暴露出去（与「后台不得看孩子内容」同源：
 *    两边各看各该看的）。
 * 3. **跨账号一律 404**。别人的工单号不告诉家长「它存在但你无权看」——
 *    这与全仓的设备/孩子档案一致。
 */

export interface TicketReply {
  by: 'parent' | 'admin';
  adminId?: number;
  adminName?: string;
  at: string;
  body: string;
}

function readReplies(value: unknown): TicketReply[] {
  if (!Array.isArray(value)) return [];
  return value.filter((r): r is TicketReply => {
    return !!r && typeof r === 'object' && typeof (r as TicketReply).body === 'string';
  });
}

/** 工单号：日期 + 6 位随机，肉眼可读、便于客服在对话里要号。 */
function generateTicketNo(): string {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rand = randomBytes(4).toString('hex').slice(0, 6).toUpperCase();
  return `T${day}-${rand}`;
}

function toParentView(ticket: SupportTicket) {
  return {
    ticketNo: ticket.ticketNo,
    category: ticket.category,
    subject: ticket.subject,
    body: ticket.body,
    // 家长自己的联系方式：回显给他，确认客服会打这个号码 / 发这个邮箱。
    contact: ticket.contact,
    status: ticket.status,
    statusLabel: TICKET_STATUS_LABELS[ticket.status] ?? ticket.status,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
    closedAt: ticket.closedAt,
    // 家长看到：谁说的、什么时候说的、说了什么。没有 adminId，也没有值班人名。
    replies: readReplies(ticket.replies).map((r) => ({ by: r.by, at: r.at, body: r.body })),
  };
}

function toAdminView(
  ticket: SupportTicket & { user?: { id: number; phone: string | null; nickname: string } | null; assignee?: { username: string } | null },
) {
  return {
    ticketNo: ticket.ticketNo,
    userId: ticket.userId,
    userPhone: ticket.user?.phone ?? null,
    userNickname: ticket.user?.nickname ?? null,
    deviceId: ticket.deviceId,
    contact: ticket.contact,
    category: ticket.category,
    subject: ticket.subject,
    body: ticket.body,
    status: ticket.status,
    statusLabel: TICKET_STATUS_LABELS[ticket.status] ?? ticket.status,
    priority: ticket.priority,
    assigneeId: ticket.assigneeId,
    assigneeName: ticket.assignee?.username ?? null,
    replies: readReplies(ticket.replies).map((r) => ({
      by: r.by,
      adminName: r.adminName ?? null,
      at: r.at,
      body: r.body,
    })),
    closedAt: ticket.closedAt,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
  };
}

const ADMIN_INCLUDE = {
  user: { select: { id: true, phone: true, nickname: true } },
  assignee: { select: { username: true } },
} as const;

export async function supportConfig() {
  const enabled = await flagEnabled('support.tickets');
  return {
    enabled,
    categories: TICKET_CATEGORIES,
    openLimit: TICKET_OPEN_LIMIT,
    bodyMax: TICKET_BODY_MAX,
    // 联系方式是运营在后台改的静态配置，本轮从环境变量之外不再新开一张配置表；
    // 没配就如实留空，家长端显示「提交后在工单里回复你」。
    contact: config.SUPPORT_CONTACT,
    /** 界面上要如实写的边界：没有附件、没有自动回复机器人 */
    notice: '工单只支持文字描述，暂不支持上传附件；客服会在工单里回复你。',
  };
}

export async function createTicket(
  userId: number,
  input: { category: string; subject: string; body: string; contact?: string; deviceId?: string },
) {
  if (!(await flagEnabled('support.tickets'))) {
    throw new ServiceUnavailableError('客服工单暂时关闭，请稍后再试');
  }
  if (!TICKET_CATEGORY_KEYS.includes(input.category)) {
    throw new BadRequestError('请选择一个问题分类');
  }
  // 设备要属于自己；**不泄露存在性**：不属于自己的设备 id 直接当作没传，
  // 否则这里会变成「用报错探测别人设备 id 是否存在」的接口。
  let deviceId: string | null = null;
  if (input.deviceId) {
    const device = await prisma.childDevice.findFirst({
      where: { id: input.deviceId, userId },
      select: { id: true },
    });
    deviceId = device?.id ?? null;
  }

  const openCount = await prisma.supportTicket.count({
    where: { userId, status: { not: 'closed' } },
  });
  if (openCount >= TICKET_OPEN_LIMIT) {
    throw new ConflictError(`你有 ${openCount} 张未关闭的工单，请等这些处理完再提交新的`);
  }

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { phone: true } });

  // 工单号极小概率撞车：撞了就重试，而不是把 500 抛给家长。
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const ticket = await prisma.supportTicket.create({
        data: {
          ticketNo: generateTicketNo(),
          userId,
          deviceId,
          contact: input.contact ?? user?.phone ?? '',
          category: input.category,
          subject: input.subject,
          body: input.body,
          status: 'open',
          priority: 'normal',
          replies: [],
        },
      });
      logger.info({ msg: 'support ticket created', ticketNo: ticket.ticketNo, userId });
      return toParentView(ticket);
    } catch (error: unknown) {
      const code = (error as { code?: string }).code;
      if (code === 'P2002') continue;
      throw error;
    }
  }
  throw new ConflictError('工单号生成失败，请重试一次');
}

export async function listMyTickets(userId: number) {
  const rows = await prisma.supportTicket.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  return { tickets: rows.map(toParentView) };
}

export async function myTicketDetail(userId: number, ticketNo: string) {
  const ticket = await prisma.supportTicket.findFirst({ where: { ticketNo, userId } });
  if (!ticket) throw new NotFoundError('工单', ticketNo);
  return { ticket: toParentView(ticket) };
}

/** 家长补充信息。已关闭的工单不能再回 —— 否则「关闭」就没有意义了。 */
export async function addParentReply(userId: number, ticketNo: string, body: string) {
  const ticket = await prisma.supportTicket.findFirst({ where: { ticketNo, userId } });
  if (!ticket) throw new NotFoundError('工单', ticketNo);
  if (ticket.status === 'closed') {
    throw new ConflictError('这张工单已经关闭，请重新提交一张');
  }
  const replies = readReplies(ticket.replies);
  replies.push({ by: 'parent', at: new Date().toISOString(), body });
  const updated = await prisma.supportTicket.update({
    where: { id: ticket.id },
    data: {
      // JSON 列：Prisma 的 InputJsonValue 要求索引签名，接口类型不满足，这里显式转一次
      replies: replies as unknown as Prisma.InputJsonValue,
      // 家长回话后要重新回到客服的待办里：停在 waiting 会变成「谁也没看见」
      status: ticket.status === 'waiting' ? 'processing' : ticket.status,
    },
  });
  return { ticket: toParentView(updated) };
}

// ---------------- 后台 ----------------

export async function adminListTickets(input: {
  status?: string;
  category?: string;
  priority?: string;
  keyword?: string;
  page: number;
  pageSize: number;
}) {
  const where: Record<string, unknown> = {};
  if (input.status) {
    if (!TICKET_STATUSES.includes(input.status as TicketStatus)) {
      throw new BadRequestError('未知的工单状态');
    }
    where.status = input.status;
  }
  if (input.category) where.category = input.category;
  if (input.priority) {
    if (!TICKET_PRIORITIES.includes(input.priority as TicketPriority)) {
      throw new BadRequestError('未知的优先级');
    }
    where.priority = input.priority;
  }
  if (input.keyword) {
    where.OR = [
      { ticketNo: { contains: input.keyword, mode: 'insensitive' } },
      { subject: { contains: input.keyword, mode: 'insensitive' } },
      { body: { contains: input.keyword, mode: 'insensitive' } },
    ];
  }
  const [total, rows] = await Promise.all([
    prisma.supportTicket.count({ where }),
    prisma.supportTicket.findMany({
      where,
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      skip: (input.page - 1) * input.pageSize,
      take: input.pageSize,
      include: ADMIN_INCLUDE,
    }),
  ]);
  return {
    total,
    page: input.page,
    pageSize: input.pageSize,
    tickets: rows.map(toAdminView),
  };
}

export async function adminTicketDetail(ticketNo: string) {
  const ticket = await prisma.supportTicket.findUnique({
    where: { ticketNo },
    include: ADMIN_INCLUDE,
  });
  if (!ticket) throw new NotFoundError('工单', ticketNo);
  return { ticket: toAdminView(ticket) };
}

export async function adminUpdateTicket(
  ticketNo: string,
  patch: { status?: TicketStatus; priority?: TicketPriority; assigneeId?: number | null },
) {
  const ticket = await prisma.supportTicket.findUnique({ where: { ticketNo } });
  if (!ticket) throw new NotFoundError('工单', ticketNo);
  const data: Record<string, unknown> = {};
  if (patch.status !== undefined) {
    data.status = patch.status;
    data.closedAt = patch.status === 'closed' ? new Date() : null;
  }
  if (patch.priority !== undefined) data.priority = patch.priority;
  if (patch.assigneeId !== undefined) {
    if (patch.assigneeId !== null) {
      const admin = await prisma.admin.findUnique({ where: { id: patch.assigneeId } });
      if (!admin) throw new NotFoundError('管理员', String(patch.assigneeId));
    }
    data.assigneeId = patch.assigneeId;
  }
  if (Object.keys(data).length === 0) throw new BadRequestError('没有要修改的内容');
  const updated = await prisma.supportTicket.update({
    where: { id: ticket.id },
    data,
    include: ADMIN_INCLUDE,
  });
  return { ticket: toAdminView(updated) };
}

/** 后台回复：追加一条，并把「待处理」自动推到「等待家长回复」。 */
export async function adminReplyTicket(
  ticketNo: string,
  admin: { id: number; username: string },
  body: string,
) {
  const ticket = await prisma.supportTicket.findUnique({ where: { ticketNo } });
  if (!ticket) throw new NotFoundError('工单', ticketNo);
  if (ticket.status === 'closed') {
    throw new ConflictError('工单已关闭，如需继续请先改回「处理中」');
  }
  const replies = readReplies(ticket.replies);
  replies.push({
    by: 'admin',
    adminId: admin.id,
    adminName: admin.username,
    at: new Date().toISOString(),
    body,
  });
  const updated = await prisma.supportTicket.update({
    where: { id: ticket.id },
    data: {
      replies: replies as unknown as Prisma.InputJsonValue,
      status: ticket.status === 'open' ? 'waiting' : ticket.status,
      // 回复即认领：没分派过的工单，回复的人就是负责人
      assigneeId: ticket.assigneeId ?? admin.id,
    },
    include: ADMIN_INCLUDE,
  });
  return { ticket: toAdminView(updated) };
}

export const supportService = {
  config: supportConfig,
  createTicket,
  listMyTickets,
  myTicketDetail,
  addParentReply,
  adminListTickets,
  adminTicketDetail,
  adminUpdateTicket,
  adminReplyTicket,
};
