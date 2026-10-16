import type { InvoiceRequest, MembershipOrder } from '@prisma/client';
import { prisma } from '../../prisma';
import { config } from '../../config';
import { logger } from '../../logger';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
} from '../../errors';
import {
  PAY_CHANNEL_LABELS,
  PERIOD_LABELS,
  type BillingPeriod,
} from '../membership/membership.constants';
import { applyPaidOrder } from '../membership/membership.service';
import {
  INVOICE_LIMIT_PER_USER,
  INVOICE_STATUS,
  ORDER_STATUS,
  PROVIDERS,
  fakeProviderAllowed,
  isChannelConfigured,
  missingEnvOf,
} from './payments.constants';
import { channelFlagKey, isKnownFlag } from '../flags/flags.constants';
import { flagEnabled } from '../flags/flags.service';
import { getProvider, providerMissing, requireProvider } from './payments.provider';

/**
 * 「这个渠道现在对**这个账号**开放吗」—— 配置齐了只说明能收钱，运营开关还可能在放量
 * 或紧急关闭（§5.5）。两件事分开判，后台体检页显示的是配置，家长端看到的是两者相与。
 *
 * 测试渠道没有开关（`FLAG_DEFS` 里没有 `pay.channel.fake`）：它由
 * `fakeProviderAllowed()` 单独把关，不能靠一个「未定义的开关默认关闭」把它关掉。
 */
async function channelEnabledFor(channel: string, userId?: number | null): Promise<boolean> {
  const key = channelFlagKey(channel);
  if (!isKnownFlag(key)) return true;
  return flagEnabled(key, userId ?? null);
}

/**
 * 支付：下单、回调结算、退款、发票（规划 §5.4）。
 *
 * 这一层是**渠道无关**的：渠道的签名/报文在 `payments.provider.ts`，钱到账之后
 * 会员怎么生效在 `membership.service.applyPaidOrder()`（模拟支付与真实回调共用它）。
 * 这里负责的是「一笔订单的一生」：待支付 → 已支付 → 退款中 → 已退款，以及
 * 每一次渠道交互都留下一条 `PaymentEvent`。
 *
 * 三条刻意的规则：
 *  1. **回调必须验签、必须对得上单号和金额**，任何一条不满足都只落事件、不改订单；
 *  2. **回调结算幂等**：渠道重投同一笔回调返回 200 但不重复加会员时长、不重复返现；
 *  3. **退款要能对账**：退款单号一次生成、复用，重试不会变成两笔退款。
 */

const REFUND_RETRY_AFTER_MS = 10 * 60 * 1000;

export interface PaymentOrderView {
  orderNo: string;
  planCode: string;
  tier: string;
  period: string;
  payChannel: string;
  payChannelLabel: string;
  /** 计费周期的展示文案（家长端 / 后台都要显示「包月 / 连续包月 / 包年」） */
  periodLabel: string;
  status: string;
  statusLabel: string;
  amountCents: number;
  originalCents: number;
  couponCents: number;
  refundCents: number;
  refundReason: string;
  refundedAt: string | null;
  /** 渠道侧退款单号（生成一次、重试复用） */
  refundNo: string | null;
  /** 渠道回调自述的商户订单号，用于和本地 orderNo 对照 */
  notifiedOrderNo: string | null;
  transactionId: string | null;
  prepayId: string | null;
  paidAt: string | null;
  startsAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  canPay: boolean;
  canRefund: boolean;
  refundDeadline: string | null;
  invoice: { id: string; status: string; statusLabel: string; invoiceNo: string } | null;
  /** 只有渠道明确回报的字段才展示，未配置时为空数组 */
  missingConfig: string[];
}

function daysSince(from: Date, now = new Date()): number {
  return (now.getTime() - from.getTime()) / (24 * 3600 * 1000);
}

function refundDeadlineOf(order: MembershipOrder): Date | null {
  if (!order.paidAt) return null;
  return new Date(order.paidAt.getTime() + config.PAYMENT_REFUND_WINDOW_DAYS * 24 * 3600 * 1000);
}

function toInvoiceView(row: InvoiceRequest) {
  return {
    id: row.id,
    orderNo: row.orderNo,
    amountCents: row.amountCents,
    title: row.title,
    taxNo: row.taxNo,
    email: row.email,
    status: row.status,
    statusLabel: INVOICE_STATUS[row.status as keyof typeof INVOICE_STATUS] ?? row.status,
    invoiceNo: row.invoiceNo,
    note: row.note,
    issuedAt: row.issuedAt ? row.issuedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

async function toPaymentOrderView(
  order: MembershipOrder,
  invoice?: InvoiceRequest | null,
): Promise<PaymentOrderView> {
  const deadline = refundDeadlineOf(order);
  const windowOpen = deadline != null && daysSince(deadline) <= 0;
  const issued = invoice?.status === 'issued';
  return {
    orderNo: order.orderNo,
    planCode: order.planCode,
    tier: order.tier,
    period: order.period,
    payChannel: order.payChannel,
    payChannelLabel: PAY_CHANNEL_LABELS[order.payChannel] ?? order.payChannel,
    periodLabel: PERIOD_LABELS[order.period as BillingPeriod] ?? order.period,
    status: order.status,
    statusLabel: ORDER_STATUS[order.status as keyof typeof ORDER_STATUS] ?? order.status,
    amountCents: order.amountCents,
    originalCents: order.originalCents,
    couponCents: order.couponCents,
    refundCents: order.refundCents,
    refundReason: order.refundReason,
    refundedAt: order.refundedAt ? order.refundedAt.toISOString() : null,
    refundNo: order.refundNo,
    notifiedOrderNo: order.notifiedOrderNo,
    transactionId: order.transactionId,
    prepayId: order.prepayId,
    paidAt: order.paidAt ? order.paidAt.toISOString() : null,
    startsAt: order.startsAt ? order.startsAt.toISOString() : null,
    expiresAt: order.expiresAt ? order.expiresAt.toISOString() : null,
    createdAt: order.createdAt.toISOString(),
    canPay: order.status === 'pending',
    canRefund: order.status === 'paid' && windowOpen && !issued,
    refundDeadline: deadline ? deadline.toISOString() : null,
    invoice: invoice
      ? {
          id: invoice.id,
          status: invoice.status,
          statusLabel: INVOICE_STATUS[invoice.status as keyof typeof INVOICE_STATUS] ?? invoice.status,
          invoiceNo: invoice.invoiceNo,
        }
      : null,
    missingConfig: missingEnvOf(order.payChannel as 'wechat' | 'alipay'),
  };
}

/**
 * 落一条支付事件。**绝不因为写日志失败而影响支付流程** ——
 * 事件表是给运维对账用的，不是账本本身；它写不进去时宁可丢一条日志也不能让回调 500，
 * 否则渠道会一直重投，反而更乱。
 */
async function recordEvent(input: {
  orderNo: string;
  provider: string;
  kind: 'create' | 'notify' | 'refund_notify' | 'refund' | 'query';
  signatureOk: boolean;
  result: string;
  detail: string;
}): Promise<void> {
  try {
    await prisma.paymentEvent.create({
      data: {
        orderNo: input.orderNo,
        provider: input.provider,
        kind: input.kind,
        signatureOk: input.signatureOk,
        result: input.result,
        detail: input.detail.slice(0, 500),
      },
    });
  } catch (error) {
    logger.warn({ msg: 'payment event write failed', err: String(error), orderNo: input.orderNo });
  }
}

export interface NotifyOutcome {
  httpStatus: number;
  contentType: string;
  body: string;
  result: string;
}

export const paymentsService = {
  /**
   * 家长端支付页需要的「现在能用什么」。
   *
   * `channels` 是给运营看的体检结果（配没配、缺什么、开关开没开），`available` 才是
   * 家长真的能点的东西 —— 两者的差集正是「配好了但被运营关掉」的那些渠道，必须让家长
   * 看到一句人话，而不是一个点了报 503 的按钮。
   */
  async catalog(userId: number) {
    const channels = await Promise.all(
      PROVIDERS.map(async (p) => ({
        key: p.key as string,
        label: p.label,
        configured: isChannelConfigured(p.key),
        missing: missingEnvOf(p.key),
        note: p.note,
        flagKey: channelFlagKey(p.key),
        enabled: await channelEnabledFor(p.key, userId),
      })),
    );
    const ready = channels.filter((c) => c.configured && c.enabled);
    const closed = channels.filter((c) => c.enabled === false);
    const unconfigured = channels.filter((c) => !c.configured);

    const available: { key: string; label: string; note: string; mode: string }[] = ready.map(
      (c) => ({ key: c.key, label: c.label, note: c.note, mode: 'real' }),
    );
    if (fakeProviderAllowed()) {
      available.push({
        key: 'fake',
        label: '测试渠道（不会真的收钱）',
        note: '仅测试环境可用',
        mode: 'fake',
      });
    }

    const parts: string[] = [];
    if (ready.length) parts.push(`已配置且开放的渠道：${ready.map((c) => c.label).join('、')}`);
    if (closed.length) {
      parts.push(
        `${closed.map((c) => c.label).join('、')} 已被运营开关关闭${closed.some((c) => !c.configured) ? '（其中还有没配全的）' : ''}`,
      );
    }
    if (parts.length === 0) {
      parts.push(
        config.MEMBERSHIP_MOCK_PAY
          ? '还没有配置微信支付或支付宝，当前只能走「模拟支付」把流程跑通（不会真的扣款）。'
          : '还没有配置微信支付或支付宝，暂时无法收款。请联系管理员补齐支付配置。',
      );
    } else if (unconfigured.length && ready.length === 0) {
      parts.push(
        config.MEMBERSHIP_MOCK_PAY
          ? '当前只能走「模拟支付」（不会真的扣款）。'
          : '暂时无法收款。请联系管理员补齐支付配置。',
      );
    }

    return {
      channels,
      available,
      fakeAvailable: fakeProviderAllowed(),
      mockPay: config.MEMBERSHIP_MOCK_PAY,
      refundWindowDays: config.PAYMENT_REFUND_WINDOW_DAYS,
      invoiceLimit: INVOICE_LIMIT_PER_USER,
      notifyPath: '/api/payments/notify',
      notice: parts.join('；'),
    };
  },

  /**
   * 为一张待支付订单向渠道下单（预支付）。
   *
   * 渠道没配时**不会假装成功**：还开着模拟支付就明确返回 `mode: 'mock'`，
   * 让家长端显示「模拟支付」按钮；否则 503 并列出缺哪几个环境变量。
   */
  async createPayment(userId: number, orderNo: string) {
    const order = await prisma.membershipOrder.findFirst({ where: { orderNo, userId } });
    if (!order) throw new NotFoundError('订单', orderNo);
    if (order.status === 'paid') throw new ConflictError('该订单已经支付过了');
    if (order.status !== 'pending') throw new ConflictError('该订单已结束，请重新下单');

    const label = PAY_CHANNEL_LABELS[order.payChannel] ?? order.payChannel;
    // 运营关掉的渠道不给下单。用 503 而不是 400：这不是参数写错了，是能力被关着，
    // 家长端的正确反应是换渠道或等通知，而不是「请您检查输入」。
    if (!(await channelEnabledFor(order.payChannel, userId))) {
      throw new ServiceUnavailableError(`支付渠道「${label}」已被运营开关关闭，请换一个渠道或稍后再试`);
    }
    const missing = providerMissing(order.payChannel);
    if (missing.length > 0) {
      if (!config.MEMBERSHIP_MOCK_PAY) {
        throw new ServiceUnavailableError(
          `支付渠道「${label}」尚未配置，缺少：${missing.join('、')}`,
        );
      }
      await recordEvent({
        orderNo,
        provider: order.payChannel,
        kind: 'create',
        signatureOk: false,
        result: 'error',
        detail: `渠道未配置（缺 ${missing.join('、')}），降级为模拟支付`,
      });
      return {
        order: await toPaymentOrderView(order),
        payment: {
          channel: order.payChannel,
          channelLabel: label,
          mode: 'mock' as const,
          codeUrl: '',
          prepayId: '',
          payload: {} as Record<string, unknown>,
          mockPay: true,
          missing,
        },
      };
    }

    const provider = requireProvider(order.payChannel);
    const [plan, user] = await Promise.all([
      prisma.membershipPlan.findUnique({ where: { code: order.planCode }, select: { name: true } }),
      prisma.user.findUnique({ where: { id: userId }, select: { wechatOpenid: true } }),
    ]);
    const subject = `气球狗 ${plan?.name ?? order.planCode}`;

    let result;
    try {
      result = await provider.createPayment({
        orderNo,
        amountCents: order.amountCents,
        subject,
        openid: order.payChannel === 'wechat' ? user?.wechatOpenid ?? null : null,
      });
    } catch (error) {
      await recordEvent({
        orderNo,
        provider: order.payChannel,
        kind: 'create',
        signatureOk: false,
        result: 'error',
        detail: String(error),
      });
      throw error;
    }

    const updated = await prisma.membershipOrder.update({
      where: { id: order.id },
      data: { prepayId: result.prepayId, prepayPayload: JSON.stringify(result.payload) },
    });
    await recordEvent({
      orderNo,
      provider: order.payChannel,
      kind: 'create',
      signatureOk: true,
      result: 'ok',
      detail: `模式 ${result.mode}，预支付号 ${result.prepayId}`,
    });
    return {
      order: await toPaymentOrderView(updated),
      payment: {
        channel: result.channel,
        channelLabel: label,
        mode: result.mode,
        codeUrl: result.codeUrl,
        prepayId: result.prepayId,
        payload: result.payload,
        mockPay: false,
        missing: [] as string[],
      },
    };
  },

  /**
   * 渠道异步回调。
   *
   * 返回值带 httpStatus：**验签失败必须给非 2xx**，渠道才会重投并让运维看见；
   * 而「已经支付过」这类重复投递要给 200，否则渠道会永远重投。
   */
  async handleNotify(
    channel: string,
    input: { headers: Record<string, string | string[] | undefined>; rawBody: string },
  ): Promise<NotifyOutcome> {
    const provider = getProvider(channel);
    if (!provider) throw new NotFoundError('支付渠道', channel);

    const missing = providerMissing(channel);
    if (missing.length > 0) {
      await recordEvent({
        orderNo: '',
        provider: channel,
        kind: 'notify',
        signatureOk: false,
        result: 'error',
        detail: `渠道未配置，缺少 ${missing.join('、')}`,
      });
      throw new ServiceUnavailableError(
        `支付渠道「${provider.label}」尚未配置，缺少：${missing.join('、')}`,
      );
    }

    const verified = await provider.verifyNotify(input);
    if (!verified.ok) {
      await recordEvent({
        orderNo: verified.orderNo,
        provider: channel,
        kind: 'notify',
        signatureOk: false,
        result: 'bad_signature',
        // 订单号取自**未经验签**的回调，所以只写进 detail 给人看，
        // 不进 orderNo 列 —— 那一列会被订单详情按单号查询，塞进攻击者给的字符串
        // 等于让伪造回调污染某笔真实订单的流水。
        detail: `${verified.reason || '验签失败'}（回调自述单号：${verified.orderNo || '无'}）`,
      });
      logger.warn({ msg: 'payment notify rejected', channel, reason: verified.reason });
      return { httpStatus: 401, contentType: verified.ack.contentType, body: verified.ack.body, result: 'bad_signature' };
    }

    const order = await prisma.membershipOrder.findUnique({ where: { orderNo: verified.orderNo } });
    if (!order) {
      await recordEvent({
        orderNo: verified.orderNo,
        provider: channel,
        kind: 'notify',
        signatureOk: true,
        result: 'unknown_order',
        detail: '本地没有这个订单号',
      });
      logger.warn({ msg: 'payment notify for unknown order', channel, orderNo: verified.orderNo });
      return { httpStatus: 404, contentType: verified.ack.contentType, body: verified.ack.body, result: 'unknown_order' };
    }

    if (order.payChannel !== channel) {
      await recordEvent({
        orderNo: order.orderNo,
        provider: channel,
        kind: 'notify',
        signatureOk: true,
        result: 'channel_mismatch',
        detail: `订单渠道是 ${order.payChannel}，回调来自 ${channel}`,
      });
      return { httpStatus: 400, contentType: verified.ack.contentType, body: verified.ack.body, result: 'channel_mismatch' };
    }

    if (verified.paidCents !== order.amountCents) {
      await recordEvent({
        orderNo: order.orderNo,
        provider: channel,
        kind: 'notify',
        signatureOk: true,
        result: 'amount_mismatch',
        detail: `回调金额 ${verified.paidCents} 与订单金额 ${order.amountCents} 不一致`,
      });
      logger.error({
        msg: 'payment notify amount mismatch',
        orderNo: order.orderNo,
        expected: order.amountCents,
        actual: verified.paidCents,
      });
      return { httpStatus: 400, contentType: verified.ack.contentType, body: verified.ack.body, result: 'amount_mismatch' };
    }

    if (order.status === 'paid') {
      await recordEvent({
        orderNo: order.orderNo,
        provider: channel,
        kind: 'notify',
        signatureOk: true,
        result: 'duplicate',
        detail: '订单已经是已支付，重复回调不再结算',
      });
      return { httpStatus: 200, contentType: verified.ack.contentType, body: verified.ack.body, result: 'duplicate' };
    }

    if (order.status !== 'pending') {
      // 家长取消/订单过期之后钱才到账：这不是能自动处理的情况，必须让人看见
      await recordEvent({
        orderNo: order.orderNo,
        provider: channel,
        kind: 'notify',
        signatureOk: true,
        result: 'order_closed',
        detail: `订单状态是 ${order.status}，钱已到账但不会自动开通会员，需要人工处理`,
      });
      logger.error({ msg: 'payment received for closed order', orderNo: order.orderNo, status: order.status });
      return { httpStatus: 200, contentType: verified.ack.contentType, body: verified.ack.body, result: 'order_closed' };
    }

    try {
      const settled = await applyPaidOrder({
        orderId: order.id,
        transactionId: verified.transactionId || `CHANNEL_${order.orderNo}`,
      });
      await prisma.membershipOrder.update({
        where: { id: order.id },
        data: { notifiedOrderNo: verified.orderNo, prepayPayload: '' },
      });
      await recordEvent({
        orderNo: order.orderNo,
        provider: channel,
        kind: 'notify',
        signatureOk: true,
        result: settled.changed ? 'ok' : 'duplicate',
        detail: `渠道状态 ${verified.tradeState}，金额 ${verified.paidCents}`,
      });
      logger.info({ msg: 'payment settled', orderNo: order.orderNo, channel });
      return {
        httpStatus: 200,
        contentType: verified.ack.contentType,
        body: verified.ack.body,
        result: settled.changed ? 'ok' : 'duplicate',
      };
    } catch (error) {
      await recordEvent({
        orderNo: order.orderNo,
        provider: channel,
        kind: 'notify',
        signatureOk: true,
        result: 'error',
        detail: String(error),
      });
      logger.error({ msg: 'payment settle failed', orderNo: order.orderNo, err: error });
      return { httpStatus: 500, contentType: verified.ack.contentType, body: verified.ack.body, result: 'error' };
    }
  },

  /** 家长端的支付记录：订单 + 每笔的渠道事件（家长能自己看到「回调失败」而不是只能问客服）。 */
  async myOrders(userId: number, page: number, pageSize: number) {
    const [orders, total] = await Promise.all([
      prisma.membershipOrder.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.membershipOrder.count({ where: { userId } }),
    ]);
    const invoices = await prisma.invoiceRequest.findMany({
      where: { userId, orderNo: { in: orders.map((o) => o.orderNo) } },
    });
    const byOrder = new Map(invoices.map((i) => [i.orderNo, i]));
    const views = await Promise.all(orders.map((o) => toPaymentOrderView(o, byOrder.get(o.orderNo) ?? null)));
    return { orders: views, total, page, pageSize };
  },

  async orderDetail(userId: number, orderNo: string) {
    const order = await prisma.membershipOrder.findFirst({ where: { orderNo, userId } });
    if (!order) throw new NotFoundError('订单', orderNo);
    const [invoice, events] = await Promise.all([
      prisma.invoiceRequest.findFirst({ where: { orderNo, userId }, orderBy: { createdAt: 'desc' } }),
      prisma.paymentEvent.findMany({ where: { orderNo }, orderBy: { createdAt: 'desc' }, take: 50 }),
    ]);
    return {
      order: await toPaymentOrderView(order, invoice),
      events: events.map((e) => ({
        id: e.id,
        kind: e.kind,
        provider: e.provider,
        signatureOk: e.signatureOk,
        result: e.result,
        detail: e.detail,
        createdAt: e.createdAt.toISOString(),
      })),
    };
  },

  /**
   * 家长自助退款。
   *
   * 窗口之外的申请直接 403 并让他找客服 —— 与其收下一条永远在「待审核」里的申请，
   * 不如当时就说清楚。已经开过发票的订单也必须人工：电子发票要先冲红。
   */
  async requestRefund(userId: number, orderNo: string, reason: string) {
    // 运营可以在出问题时立刻关掉自助退款（例如渠道退款接口在抽风），
    // 后台人工退款不受这个开关影响 —— 关闭的是「家长自己点」，不是「能不能退」。
    if (!(await flagEnabled('pay.refund.selfservice'))) {
      throw new ForbiddenError('自助退款暂时关闭，请联系客服处理');
    }
    const order = await prisma.membershipOrder.findFirst({ where: { orderNo, userId } });
    if (!order) throw new NotFoundError('订单', orderNo);
    if (order.status === 'refunded') throw new ConflictError('这笔订单已经退过款了');
    if (order.status === 'refunding') throw new ConflictError('这笔退款正在处理中');
    if (order.status !== 'paid') throw new ConflictError('只有已支付的订单可以退款');

    const deadline = refundDeadlineOf(order);
    if (deadline && daysSince(deadline) > 0) {
      throw new ForbiddenError(
        `已经超过 ${config.PAYMENT_REFUND_WINDOW_DAYS} 天的自助退款期限，请联系客服处理`,
      );
    }
    // 有开票申请（待处理或已开具）一律走人工：待处理的那张可能已经开出纸质票，
    // 让家长自助退款会让「钱退了、票还在」变成公司自己的损失。
    const invoice = await prisma.invoiceRequest.findFirst({
      where: { orderNo, status: { in: ['pending', 'issued'] } },
    });
    if (invoice) {
      throw new ConflictError('这张订单已经申请过发票，退款需要先冲红，请联系客服处理');
    }
    return this.refundOrder({ orderNo, amountCents: order.amountCents, reason, byAdmin: false });
  },

  async myRefunds(userId: number) {
    const rows = await prisma.membershipOrder.findMany({
      where: { userId, status: { in: ['refunding', 'refunded'] } },
      orderBy: { refundedAt: 'desc' },
    });
    return { refunds: await Promise.all(rows.map((o) => toPaymentOrderView(o))) };
  },

  /**
   * 真正的退款（家长自助与后台人工共用）。
   *
   * 退款单号只在第一次生成并写进订单：渠道那边的幂等键是它，重试时复用同一个，
   * 才不会把「重试」变成「退两次」。
   */
  async refundOrder(input: {
    orderNo: string;
    amountCents: number;
    reason: string;
    byAdmin: boolean;
  }) {
    const order = await prisma.membershipOrder.findUnique({ where: { orderNo: input.orderNo } });
    if (!order) throw new NotFoundError('订单', input.orderNo);
    if (order.status === 'refunded') throw new ConflictError('这笔订单已经退过款了');
    if (order.status !== 'paid' && order.status !== 'refunding') {
      throw new ConflictError('只有已支付的订单可以退款');
    }
    if (input.amountCents > order.amountCents) {
      throw new BadRequestError('退款金额不能超过订单金额');
    }

    const refundNo = order.refundNo ?? `RF${order.orderNo}`;
    const marked = await prisma.membershipOrder.update({
      where: { id: order.id },
      data: {
        status: 'refunding',
        refundNo,
        refundCents: input.amountCents,
        refundReason: input.reason,
      },
    });

    // 模拟渠道 / 未配置渠道的历史订单：不联网、直接当成功，但事件照记
    const missing = providerMissing(marked.payChannel);
    if (marked.payChannel === 'fake' || missing.length > 0) {
      await recordEvent({
        orderNo: marked.orderNo,
        provider: marked.payChannel,
        kind: 'refund',
        signatureOk: true,
        result: 'ok',
        detail: missing.length
          ? `渠道未配置（缺 ${missing.join('、')}），按本地记账完成退款`
          : '测试渠道，按本地记账完成退款',
      });
      return this.settleRefund(marked, input.byAdmin);
    }

    const provider = requireProvider(marked.payChannel);
    try {
      const result = await provider.refund({
        orderNo: marked.orderNo,
        refundNo,
        amountCents: input.amountCents,
        totalCents: marked.amountCents,
        reason: input.reason,
      });
      await recordEvent({
        orderNo: marked.orderNo,
        provider: marked.payChannel,
        kind: 'refund',
        signatureOk: true,
        result: result.ok ? 'ok' : 'error',
        detail: `退款单号 ${result.refundId}：${result.reason}`,
      });
      if (!result.ok) throw new ConflictError(`渠道没有接受这笔退款：${result.reason}`);
      return this.settleRefund(marked, input.byAdmin);
    } catch (error) {
      await recordEvent({
        orderNo: marked.orderNo,
        provider: marked.payChannel,
        kind: 'refund',
        signatureOk: false,
        result: 'error',
        detail: String(error),
      });
      // 订单留在 refunding：定时清扫会拿同一个退款单号重试
      throw error;
    }
  },

  /** 渠道确认退款之后落库：订单置为已退款，并收回这笔订单开通的会员。 */
  async settleRefund(order: MembershipOrder, byAdmin: boolean) {
    const now = new Date();
    const settled = await prisma.membershipOrder.update({
      where: { id: order.id },
      data: { status: 'refunded', refundedAt: now, refundCents: order.refundCents },
    });

    // 会员的收回是有条件的：只有「当前生效的正是这笔订单开通的那段时间」才收回。
    // 否则会误伤——家长退款的是上个月那单，而这个月又买了一单。
    const user = await prisma.user.findUnique({
      where: { id: order.userId },
      select: { membershipTier: true, membershipExpiresAt: true, totalPaidCents: true },
    });
    let revoked = false;
    if (user) {
      const samePeriod =
        settled.expiresAt != null &&
        user.membershipExpiresAt != null &&
        Math.abs(user.membershipExpiresAt.getTime() - settled.expiresAt.getTime()) < 1000;
      const revoke = samePeriod && user.membershipTier === settled.tier;
      revoked = revoke;
      await prisma.user.update({
        where: { id: order.userId },
        data: {
          ...(revoke
            ? {
                // 免费档在会员体系里叫 ordinary（见 membership.constants 的 TIER_RANK），
                // 不要写成 'free'：那会在权限判定里变成一个未知档位。
                membershipTier: 'ordinary',
                membershipExpiresAt: null,
                membershipStartedAt: null,
                membershipAutoRenew: false,
                membershipRenewTier: null,
              }
            : {}),
          totalPaidCents: Math.max(0, user.totalPaidCents - settled.refundCents),
        },
      });
      logger.warn({
        msg: 'membership refund settled',
        orderNo: settled.orderNo,
        byAdmin,
        revoked: revoke,
        refundCents: settled.refundCents,
      });
    } else {
      logger.warn({ msg: 'refund settled but user missing', orderNo: settled.orderNo });
    }

    return { order: await toPaymentOrderView(settled), membershipRevoked: revoked };
  },

  /**
   * 退款对账清扫（server.ts 每小时一次）。
   *
   * 只处理卡在 `refunding` 里的订单：它们要么是渠道超时、要么是进程在那一步挂了。
   * 用**同一个退款单号**重试，渠道侧幂等 —— 这就是为什么退款单号必须先落库再用。
   */
  async sweep(): Promise<{ retried: number; settled: number; failed: number }> {
    const stale = await prisma.membershipOrder.findMany({
      where: { status: 'refunding', refundNo: { not: null } },
      take: 50,
    });
    let retried = 0;
    let settled = 0;
    let failed = 0;
    for (const order of stale) {
      if (!order.refundedAt && order.updatedAt.getTime() > Date.now() - REFUND_RETRY_AFTER_MS) {
        continue; // 刚发起的退款给它一点时间，别抢在渠道回调前面重试
      }
      retried += 1;
      const missing = providerMissing(order.payChannel);
      if (order.payChannel === 'fake' || missing.length > 0) {
        await this.settleRefund(order, true);
        settled += 1;
        continue;
      }
      try {
        const provider = requireProvider(order.payChannel);
        const result = await provider.refund({
          orderNo: order.orderNo,
          refundNo: order.refundNo ?? `RF${order.orderNo}`,
          amountCents: order.refundCents,
          totalCents: order.amountCents,
          reason: order.refundReason || '重试退款',
        });
        if (result.ok) {
          await this.settleRefund(order, true);
          settled += 1;
        } else {
          failed += 1;
        }
      } catch (error) {
        failed += 1;
        logger.warn({ msg: 'refund retry failed', orderNo: order.orderNo, err: String(error) });
      }
    }
    return { retried, settled, failed };
  },

  // ---- 发票 ----

  /**
   * 申请开票。
   *
   * 一张订单只能有一张有效申请（被驳回的可以重新申请）。公司抬头必须给税号 ——
   * 没有税号的「公司发票」开出来也不能报销，不如当场说清楚。
   */
  async requestInvoice(
    userId: number,
    input: { orderNo: string; title: string; taxNo: string; email: string; amountCents?: number },
  ) {
    const order = await prisma.membershipOrder.findFirst({
      where: { orderNo: input.orderNo, userId },
    });
    if (!order) throw new NotFoundError('订单', input.orderNo);
    if (order.status !== 'paid') throw new ConflictError('只有已支付的订单可以申请开票');

    const amountCents = input.amountCents ?? order.amountCents;
    if (amountCents > order.amountCents) throw new BadRequestError('开票金额不能超过订单金额');

    const companyLike = /(公司|有限|集团|企业|工作室|中心|银行|学校|医院)/.test(input.title);
    if (companyLike && input.taxNo.trim().length < 15) {
      throw new BadRequestError('公司抬头需要填写 15 位以上的税号');
    }

    const existing = await prisma.invoiceRequest.findFirst({
      where: { orderNo: input.orderNo, status: { in: ['pending', 'issued'] } },
    });
    if (existing) throw new ConflictError('这张订单已经申请过发票了');

    const count = await prisma.invoiceRequest.count({ where: { userId } });
    if (count >= INVOICE_LIMIT_PER_USER) {
      throw new ConflictError(`最多只能保留 ${INVOICE_LIMIT_PER_USER} 条开票申请，请等待处理`);
    }

    const created = await prisma.invoiceRequest.create({
      data: {
        userId,
        orderNo: input.orderNo,
        amountCents,
        title: input.title,
        taxNo: input.taxNo,
        email: input.email,
      },
    });
    return { invoice: toInvoiceView(created) };
  },

  async myInvoices(userId: number) {
    const rows = await prisma.invoiceRequest.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return { invoices: rows.map(toInvoiceView) };
  },

  // ---- 管理后台 ----

  async adminStats() {
    const [paidAgg, refundedAgg, byChannel, byDay, pendingInvoices, badSignatures, mockPayOrders] =
      await Promise.all([
        prisma.membershipOrder.aggregate({ where: { status: 'paid' }, _sum: { amountCents: true }, _count: true }),
        prisma.membershipOrder.aggregate({
          where: { status: 'refunded' },
          _sum: { refundCents: true },
          _count: true,
        }),
        prisma.membershipOrder.groupBy({
          by: ['payChannel'],
          where: { status: 'paid' },
          _sum: { amountCents: true },
          _count: true,
        }),
        prisma.$queryRaw<{ day: Date; cents: bigint; count: bigint }[]>`
          SELECT date_trunc('day', "paidAt") AS day,
                 COALESCE(SUM("amountCents"), 0)::bigint AS cents,
                 COUNT(*)::bigint AS count
          FROM "MembershipOrder"
          WHERE status = 'paid' AND "paidAt" >= NOW() - INTERVAL '30 days'
          GROUP BY 1
          ORDER BY 1 ASC
        `,
        prisma.invoiceRequest.count({ where: { status: 'pending' } }),
        prisma.paymentEvent.count({ where: { result: 'bad_signature' } }),
        prisma.membershipOrder.count({ where: { payChannel: 'fake' } }),
      ]);

    return {
      paidCents: paidAgg._sum.amountCents ?? 0,
      paidOrders: paidAgg._count,
      refundedCents: refundedAgg._sum.refundCents ?? 0,
      refundedOrders: refundedAgg._count,
      byChannel: byChannel.map((row) => ({
        channel: row.payChannel,
        label: PAY_CHANNEL_LABELS[row.payChannel] ?? row.payChannel,
        cents: row._sum.amountCents ?? 0,
        count: row._count,
      })),
      byDay: byDay.map((row) => ({
        day: row.day instanceof Date ? row.day.toISOString().slice(0, 10) : String(row.day).slice(0, 10),
        cents: Number(row.cents),
        count: Number(row.count),
      })),
      pendingInvoices,
      badSignatures,
      mockPayOrders,
      channels: PROVIDERS.map((p) => ({
        key: p.key,
        label: p.label,
        configured: isChannelConfigured(p.key),
        missing: missingEnvOf(p.key),
      })),
      mockPay: config.MEMBERSHIP_MOCK_PAY,
      fakeProvider: fakeProviderAllowed(),
    };
  },

  async adminListOrders(query: {
    status?: string;
    channel?: string;
    orderNo?: string;
    userId?: number;
    page: number;
    pageSize: number;
  }) {
    const where: Record<string, unknown> = {};
    if (query.status) where.status = query.status;
    if (query.channel) where.payChannel = query.channel;
    if (query.orderNo) where.orderNo = { contains: query.orderNo };
    if (query.userId) where.userId = query.userId;
    const [orders, total] = await Promise.all([
      prisma.membershipOrder.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: { user: { select: { id: true, nickname: true, phone: true } } },
      }),
      prisma.membershipOrder.count({ where }),
    ]);
    return {
      orders: await Promise.all(
        orders.map(async (o) => ({
          ...(await toPaymentOrderView(o)),
          userId: o.userId,
          userNickname: o.user.nickname,
          userPhone: o.user.phone,
          notifiedOrderNo: o.notifiedOrderNo,
          refundNo: o.refundNo,
        })),
      ),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  },

  async adminEvents(orderNo: string) {
    const events = await prisma.paymentEvent.findMany({
      where: { orderNo },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return {
      events: events.map((e) => ({
        id: e.id,
        provider: e.provider,
        kind: e.kind,
        signatureOk: e.signatureOk,
        result: e.result,
        detail: e.detail,
        createdAt: e.createdAt.toISOString(),
      })),
    };
  },

  /** 后台发起退款：不受自助窗口限制，但必须写原因（谁批的、为什么，事后要能查）。 */
  async adminRefund(orderNo: string, amountCents: number, reason: string) {
    const order = await prisma.membershipOrder.findUnique({ where: { orderNo } });
    if (!order) throw new NotFoundError('订单', orderNo);
    return this.refundOrder({ orderNo, amountCents, reason, byAdmin: true });
  },

  async adminListRefunds(page: number, pageSize: number) {
    const where = { status: { in: ['refunding', 'refunded'] } };
    const [rows, total] = await Promise.all([
      prisma.membershipOrder.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { user: { select: { id: true, nickname: true, phone: true } } },
      }),
      prisma.membershipOrder.count({ where }),
    ]);
    return {
      refunds: await Promise.all(
        rows.map(async (o) => ({
          ...(await toPaymentOrderView(o)),
          userId: o.userId,
          userNickname: o.user.nickname,
          userPhone: o.user.phone,
          refundNo: o.refundNo,
        })),
      ),
      total,
      page,
      pageSize,
    };
  },

  async adminListInvoices(status: string | undefined, page: number, pageSize: number) {
    const where = status ? { status } : {};
    const [rows, total] = await Promise.all([
      prisma.invoiceRequest.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { user: { select: { id: true, nickname: true, phone: true } } },
      }),
      prisma.invoiceRequest.count({ where }),
    ]);
    return {
      invoices: rows.map((row) => ({
        ...toInvoiceView(row),
        userId: row.userId,
        userNickname: row.user.nickname,
        userPhone: row.user.phone,
      })),
      total,
      page,
      pageSize,
    };
  },

  async adminUpdateInvoice(
    invoiceId: string,
    input: { status: string; invoiceNo?: string; note?: string },
  ) {
    const row = await prisma.invoiceRequest.findUnique({ where: { id: invoiceId } });
    if (!row) throw new NotFoundError('开票申请', invoiceId);
    if (row.status === 'issued' && input.status === 'issued' && !input.invoiceNo) {
      throw new BadRequestError('标记为已开具时必须填写发票号码');
    }
    const updated = await prisma.invoiceRequest.update({
      where: { id: invoiceId },
      data: {
        status: input.status,
        invoiceNo: input.invoiceNo ?? row.invoiceNo,
        note: input.note ?? row.note,
        issuedAt: input.status === 'issued' ? row.issuedAt ?? new Date() : row.issuedAt,
      },
    });
    logger.info({ msg: 'invoice updated', invoiceId, status: input.status });
    return { invoice: toInvoiceView(updated) };
  },
};
