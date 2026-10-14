import { request, type QueryValue } from './client'

/** 后端所有列表接口统一的返回结构。 */
export interface Paged<T> {
  page: number
  pageSize: number
  total: number
  totalPages: number
  items: T[]
}

// ============================================================
// 类型（与 server/src/features/admin 的返回一一对应）
// ============================================================

export interface AdminAccount {
  id: number
  username: string
  name: string
  role: string
  status: string
  lastLoginAt: string | null
  createdAt: string | null
}

export interface CommandView {
  id: string
  deviceId: string
  type: string
  label: string
  payload: Record<string, unknown>
  status: string
  result: unknown
  error: string
  createdAt: string
  dispatchedAt: string | null
  finishedAt: string | null
  expiresAt: string
  /** 仅后台列表返回 */
  deviceName?: string
  owner?: { id: number; phone: string | null; nickname: string } | null
}

export interface StatsResponse {
  range: { days: number; from: string; to: string }
  kpi: {
    totalUsers: number
    activeUsers: number
    disabledUsers: number
    newUsersInRange: number
    totalDevices: number
    boundDevices: number
    unboundDevices: number
    onlineDevices: number
    lockedDevices: number
    totalCommands: number
    pendingCommands: number
    succeededCommands: number
    failedCommands: number
    commandSuccessRate: number | null
    totalMedia: number
    mediaBytes: number
    totalLocations: number
    totalSafeZones: number
    totalQuizRecords: number
    quizAccuracy: number | null
    totalSmsCodes: number
  }
  series: {
    users: { date: string; count: number }[]
    devices: { date: string; count: number }[]
    commands: { date: string; count: number }[]
  }
  breakdown: {
    commandsByType: { type: string; count: number }[]
    commandsByStatus: { status: string; count: number }[]
    quizByType: { type: string; count: number; rewardMinutes: number }[]
  }
}

export interface UserRow {
  id: number
  phone: string | null
  email: string | null
  nickname: string
  avatar: string
  status: string
  wechatBound: boolean
  createdAt: string
  deviceCount: number
  commandCount: number
  quizRecordCount: number
  mediaCount: number
}

export interface UserDetail {
  user: {
    id: number
    phone: string | null
    email: string | null
    nickname: string
    avatar: string
    status: string
    wechatBound: boolean
    activeDeviceId: string | null
    createdAt: string
    updatedAt: string
  }
  stats: {
    deviceCount: number
    onlineDeviceCount: number
    commandTotal: number
    commandFailed: number
    quizTotal: number
    quizCorrect: number
    quizAccuracy: number | null
    mediaTotal: number
    locationTotal: number
  }
  devices: {
    id: string
    name: string
    model: string
    os: string
    status: string
    locked: boolean
    battery: number
    lastActiveAt: string | null
    deviceCode: string
    boundAt: string | null
    counts: { commands: number; media: number; locations: number; quizRecords: number }
  }[]
  recentCommands: CommandView[]
}

export interface DeviceRow {
  id: string
  name: string
  model: string
  os: string
  online: boolean
  battery: number
  network: string
  locked: boolean
  tempUnlockUntil: string | null
  deviceCode: string
  agentVersion: string
  lastActiveAt: string | null
  createdAt: string
  boundAt: string | null
  bound: boolean
  owner: { id: number; phone: string | null; nickname: string; status: string } | null
  counts: { commands: number; media: number; locations: number; quizRecords: number }
}

export interface DeviceDetail {
  device: DeviceRow & {
    status: string
  }
  owner: { id: number; phone: string | null; nickname: string; status: string } | null
  features: Record<string, boolean>
  timePlan: { enabled: boolean; dailyLimitMinutes: number; usedTodayMinutes: number } | null
  appLimits: { appName: string; packageName: string; dailyLimitMinutes: number; enabled: boolean }[]
  blockedUrls: string[]
  pendingAuditCount: number
  quizConfig: {
    enabled: boolean
    quizType: string
    grade: string
    correctRewardMinutes: number
    randomMode: boolean
  } | null
  recentCommands: CommandView[]
}

export interface QuestionRow {
  id: string
  type: string
  grade: string
  question: string
  options: string[]
  correctAnswer: number
  explanation: string
  createdAt: string
}

export interface QuizRecordRow {
  id: string
  deviceId: string
  questionId: string
  deviceName: string
  owner: { id: number; phone: string | null; nickname: string } | null
  type: string
  question: string
  userAnswer: number
  isCorrect: boolean
  rewardMinutes: number
  createdAt: string
}

export interface SmsCodeRow {
  id: string
  phone: string
  purpose: string
  attempts: number
  state: string
  expiresAt: string
  consumedAt: string | null
  createdAt: string
}

export interface OperationLogRow {
  id: number
  adminId: number | null
  adminName: string
  action: string
  method: string
  path: string
  status: number
  detail: string | null
  ip: string | null
  createdAt: string
}

// ============================================================
// 会员（套餐 / 定价规则 / 订单 / 统计）
// ============================================================

export interface MembershipPlanRow {
  id: string
  code: string
  tier: string
  tierLabel: string
  period: string
  periodLabel: string
  name: string
  description: string
  /** 基准价（分）。页面按元展示，提交时再乘 100。 */
  basePriceCents: number
  months: number
  recommended: boolean
  sortOrder: number
  enabled: boolean
  orderCount: number
  createdAt: string
  updatedAt: string
}

export interface MembershipRuleRow {
  id: string
  name: string
  conditionType: string
  conditionMinDevices: number | null
  conditionDays: number | null
  conditionFromTier: string | null
  targetTier: string
  targetPeriod: string
  discountType: string
  discountValue: number
  stackable: boolean
  priority: number
  enabled: boolean
  note: string
  conditionLabel: string
  conditionSummary: string
  discountSummary: string
  /** 服务端算的：条件参数是否齐全。不齐的规则在引擎里永不命中。 */
  complete?: boolean
  createdAt: string
  updatedAt: string
}

/**
 * 受邀用户定价规则（会员价格 × 买家是否被邀请注册）。
 *
 * 与常规定价规则刻意分开：触发条件只有「是否受邀注册 / 邀请关系是否有效 / 是否限首单」，
 * 计价时先算完常规定价，再把本表每条命中的规则各算一个价，与常规定价一起**取最高价**：
 * 被邀请注册的家长要承担邀请人的分享返现成本，所以价格只会更高、不会更低。
 */
export interface MembershipReferralRuleRow {
  id: string
  name: string
  targetTier: 'all' | 'member' | 'super'
  targetPeriod: 'all' | 'monthly' | 'yearly' | 'auto_monthly'
  priceType: 'percent' | 'amount' | 'fixed'
  /** percent: 上浮百分比；amount: 加收多少分；fixed: 一口价（分）。 */
  priceValue: number
  /** 只对首次付费生效。关掉后连续费/自动续费也上浮。 */
  firstPurchaseOnly: boolean
  /** 邀请关系必须有效（未被判为自买自返）。 */
  requireActiveReferral: boolean
  priority: number
  enabled: boolean
  note: string
  createdAt: string
  updatedAt: string
  /** 服务端直接给的可展示字段。 */
  priceTypeLabel: string
  targetTierLabel: string
  targetPeriodLabel: string
  scopeSummary: string
  impact: string
}

/** 命中的规则快照，随订单一起存下来。 */
export interface MembershipAdjustment {
  ruleId: string | null
  name: string
  discountType: string
  discountValue: number
  amountCents: number
  note: string
}

/** 试算返回里的「受邀用户定价」说明块。`reason` 是服务端给的中文解释，必须原样展示。 */
export interface MembershipSimulateReferral {
  /** 这个账号有没有资格走受邀定价（受邀注册）。 */
  applicable: boolean
  /** 受邀加价最终有没有真的生效（false 也可能是后台没配到能超过常规价的规则）。 */
  applied: boolean
  reason: string
  ruleId: string | null
  ruleName: string
  priceType: 'percent' | 'amount' | 'fixed' | null
  priceValue: number
  /** 加价基数：常规定价的实付价。 */
  baseCents: number
  /** 命中的规则算出来的最高价（没命中则为 null）。 */
  candidateCents: number | null
  /** 比常规定价多收了多少（分）。 */
  surchargeCents: number
  /** 结账价 = max(常规定价, candidateCents)。 */
  finalCents: number
  /** 一共命中几条规则（价格取的是最高的一条）。 */
  matchedCount: number
  note: string
}

export interface MembershipOrderRow {
  id: string
  orderNo: string
  user: { id: number; phone: string | null; nickname: string }
  planCode: string
  tier: string
  tierLabel: string
  period: string
  periodLabel: string
  originalCents: number
  amountCents: number
  discountCents: number
  adjustments: MembershipAdjustment[]
  payChannel: string
  payChannelLabel: string
  status: string
  transactionId: string | null
  paidAt: string | null
  startsAt: string | null
  expiresAt: string | null
  autoRenew: boolean
  createdAt: string
}

export interface MembershipDayPoint {
  date: string
  amountCents: number
  count: number
}

export interface MembershipStats {
  days: number
  since: string
  totals: {
    paidAmountCents: number
    paidCount: number
    payingUsers: number
    averageOrderCents: number
    totalUsers: number
  }
  byStatus: Record<string, { count: number; amountCents: number }>
  users: {
    total: number
    activeMember: number
    activeSuper: number
    activeTotal: number
    ordinary: number
    activeTierCounts: Record<string, number>
    storedTierCounts: Record<string, number>
    expiringIn7Days: number
    autoRenew: number
    paidConversion: number
  }
  config: { enabledPlans: number; enabledRules: number }
  series: MembershipDayPoint[]
  planPerformance: { planCode: string; count: number; amountCents: number }[]
}

// ============================================================
// 分享提成 / 邀请返现（server/src/features/referral/referral.admin.*）
// ============================================================

/** 列表小计：按状态给出条数与金额合计。 */
export type ReferralStatusCounts = Record<string, { count: number; amountCents: number }>

/**
 * 提成后台的列表返回结构与其它后台列表**不一致**：后端只发
 * `{ items, total, page, pageSize }`，没有 `totalPages`（会员后台则有）。
 * 这里如实按后端的形状声明，页签用 `totalPagesOf()` 自己算，
 * 而不是硬套 `Paged<T>` 让类型撒谎。
 */
export interface ReferralPaged<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
}

export interface ReferralTierRow {
  id: string
  minInvitees: number
  maxInvitees: number | null
  ratePercent: number
  sortOrder: number
  enabled: boolean
  label: string
}

export interface ReferralCouponRuleRow {
  id: string
  name: string
  inviteeCount: number
  repeatEvery: number | null
  amountCents: number
  validDays: number
  sortOrder: number
  enabled: boolean
}

export interface ReferralRuleset {
  tiers: ReferralTierRow[]
  couponRules: ReferralCouponRuleRow[]
  shortPeriodMinRatePercent: number
  longPeriodCapCents: number
  renewalRatePercent: number
  renewalCapCents: number
}

/** PUT /admin/referral/rules 的请求体：整表替换，服务端不接收 sortOrder / enabled。 */
export interface ReferralRulesUpdateBody {
  tiers: { minInvitees: number; maxInvitees?: number | null; ratePercent: number }[]
  couponRules: {
    name: string
    inviteeCount: number
    repeatEvery?: number | null
    amountCents: number
    validDays: number
  }[]
  shortPeriodMinRatePercent: number
  longPeriodCapCents: number
  renewalRatePercent: number
  renewalCapCents: number
}

export interface ReferralConfigView {
  title: string
  subtitle: string
  enabled: boolean
  /** GET 返回的是拆好行的数组（库里的 notice 是换行拼接的字符串）。 */
  notice: string[]
  startedAt: string
  endsAt: string | null
  withdrawMinInvitees: number
  withdrawMinCents: number
  withdrawRequireVerified: boolean
  settleDayStart: number
  settleDayEnd: number
  updatedAt: string
}

/** PUT /admin/referral/config 的请求体：说明字段叫 `notice`（数组），不叫 noticeLines。 */
export interface ReferralConfigUpdateBody {
  title: string
  subtitle: string
  enabled: boolean
  notice: string[]
  startedAt: string | null
  endsAt: string | null
  withdrawMinInvitees: number
  withdrawMinCents: number
  withdrawRequireVerified: boolean
  settleDayStart: number
  settleDayEnd: number
}

export interface ReferralDayPoint {
  date: string
  invited: number
  valid: number
  rewardCents: number
}

export interface ReferralStats {
  days: number
  since: string
  totals: {
    referrals: number
    invitedInRange: number
    validInRange: number
    rewardTotals: {
      totalCents: number
      pendingCents: number
      settledCents: number
      cancelledCents: number
      firstPurchaseCents: number
      renewalCents: number
      count: number
    }
    withdrawalTotals: {
      pendingCents: number
      pendingCount: number
      approvedCents: number
      paidCents: number
      rejectedCents: number
      paidCount: number
    }
    couponTotals: {
      issued: number
      unused: number
      used: number
      expired: number
      outstandingCents: number
    }
    totalUsers: number
    paidUsers: number
    /** 注册付费率：有付费行为的账号 / 全部账号。 */
    payConversion: number
    /** 邀请转化率：邀请关系里最终产生有效充值的比例。 */
    inviteConversion: number
  }
  byStatus: { bound: number; valid: number; invalid: number }
  byRewardStatus: { pending: number; settled: number; cancelled: number }
  byWithdrawalStatus: { pending: number; approved: number; paid: number; rejected: number }
  topInviters: { userId: number; label: string; count: number; validCount: number; amountCents: number }[]
  series: ReferralDayPoint[]
  config: {
    enabled: boolean
    title: string
    startedAt: string
    endsAt: string | null
    tierCount: number
    couponRuleCount: number
    withdrawMinInvitees: number
    withdrawMinCents: number
  }
}

export interface ReferralInviteeRow {
  id: string
  code: string
  status: string
  statusLabel: string
  invalidReason: string
  inviterId: number
  inviterLabel: string
  inviteeId: number
  inviteeLabel: string
  rewardCount: number
  rewardCents: number
  boundAt: string
  validAt: string | null
}

export interface ReferralRewardRow {
  id: string
  rewardNo: string
  inviterLabel: string
  inviteeLabel: string
  orderNo: string
  kind: string
  kindLabel: string
  baseAmountCents: number
  ratePercent: number
  amountCents: number
  capApplied: boolean
  status: string
  statusLabel: string
  settleMonth: string
  settledAt: string | null
  cancelReason: string
  createdAt: string
}

export interface ReferralCouponRow {
  id: string
  userLabel: string
  amountCents: number
  source: string
  status: string
  statusLabel: string
  expiresAt: string | null
  usedAt: string | null
  usedOrderNo: string | null
  createdAt: string
}

export interface ReferralWithdrawalRow {
  id: string
  withdrawNo: string
  userLabel: string
  amountCents: number
  status: string
  statusLabel: string
  realName: string
  idCardTail: string
  channel: string
  channelLabel: string
  /** 收款账号，后端已脱敏存储（如 138****8000）。 */
  account: string
  userNote: string
  reviewNote: string
  reviewedAt: string | null
  paidAt: string | null
  createdAt: string
}

export interface ReferralRiskFinding {
  type: string
  level: 'high' | 'medium'
  title: string
  detail: string
  userIds: number[]
  at: string
}

export interface ReferralRiskResult {
  days: number
  since: string
  scanned: number
  high: number
  medium: number
  findings: ReferralRiskFinding[]
}

type Query = Record<string, QueryValue>

// ============================================================
// 接口
// ============================================================

export const api = {
  auth: {
    login: (username: string, password: string) =>
      request<{ success: boolean; token: string; admin: AdminAccount }>('/admin/login', {
        method: 'POST',
        body: { username, password },
        skipAuth: true,
      }),
    profile: () => request<AdminAccount>('/admin/profile'),
    changePassword: (oldPassword: string, newPassword: string) =>
      request<{ success: boolean }>('/admin/password', {
        method: 'POST',
        body: { oldPassword, newPassword },
      }),
  },

  stats: (days: number) => request<StatsResponse>('/admin/stats', { query: { days } }),

  users: {
    list: (q: Query) => request<Paged<UserRow>>('/admin/users', { query: q }),
    get: (id: number) => request<UserDetail>(`/admin/users/${id}`),
    setStatus: (id: number, status: 'active' | 'disabled', reason?: string) =>
      request<{ success: boolean; status: string }>(`/admin/users/${id}/status`, {
        method: 'PATCH',
        body: { status, reason },
      }),
    remove: (id: number) =>
      request<{ success: boolean; removedMediaFiles: number }>(`/admin/users/${id}`, { method: 'DELETE' }),
  },

  devices: {
    list: (q: Query) => request<Paged<DeviceRow>>('/admin/devices', { query: q }),
    get: (id: string) => request<DeviceDetail>(`/admin/devices/${id}`),
    unbind: (id: string) =>
      request<{ success: boolean; previousOwnerId: number }>(`/admin/devices/${id}/unbind`, {
        method: 'POST',
      }),
    remove: (id: string) =>
      request<{ success: boolean; removedMediaFiles: number }>(`/admin/devices/${id}`, {
        method: 'DELETE',
      }),
  },

  commands: {
    list: (q: Query) => request<Paged<CommandView>>('/admin/commands', { query: q }),
    cancel: (id: string) =>
      request<{ command: CommandView; cancelled: boolean }>(`/admin/commands/${id}/cancel`, {
        method: 'POST',
      }),
  },

  questions: {
    list: (q: Query) =>
      request<Paged<QuestionRow> & { distribution: { grade: string; type: string; count: number }[] }>(
        '/admin/questions',
        { query: q },
      ),
    create: (body: {
      type: string
      grade: string
      question: string
      options: string[]
      correctAnswer: number
      explanation?: string
    }) => request<{ success: boolean; question: QuestionRow }>('/admin/questions', { method: 'POST', body }),
    update: (id: string, body: Partial<Omit<QuestionRow, 'id' | 'createdAt'>>) =>
      request<{ success: boolean; question: QuestionRow }>(`/admin/questions/${id}`, {
        method: 'PATCH',
        body,
      }),
    remove: (id: string) =>
      request<{ success: boolean }>(`/admin/questions/${id}`, { method: 'DELETE' }),
  },

  quizRecords: {
    list: (q: Query) => request<Paged<QuizRecordRow>>('/admin/quiz-records', { query: q }),
  },

  smsCodes: {
    list: (q: Query) =>
      request<Paged<SmsCodeRow> & { distribution: { purpose: string; count: number }[] }>('/admin/sms-codes', {
        query: q,
      }),
    purge: () => request<{ success: boolean; deleted: number }>('/admin/sms-codes/purge', { method: 'POST' }),
  },

  logs: {
    list: (q: Query) => request<Paged<OperationLogRow>>('/admin/logs', { query: q }),
  },

  admins: {
    list: () => request<{ admins: AdminAccount[] }>('/admin/admins'),
    create: (body: { username: string; password: string; name?: string; role: string }) =>
      request<{ success: boolean; admin: AdminAccount }>('/admin/admins', { method: 'POST', body }),
    resetPassword: (id: number, password: string) =>
      request<{ success: boolean }>(`/admin/admins/${id}/password`, { method: 'PATCH', body: { password } }),
    setStatus: (id: number, status: 'active' | 'disabled') =>
      request<{ success: boolean }>(`/admin/admins/${id}/status`, { method: 'PATCH', body: { status } }),
    remove: (id: number) => request<{ success: boolean }>(`/admin/admins/${id}`, { method: 'DELETE' }),
  },

  membership: {
    plans: {
      list: (q: Query) =>
        request<
          Paged<MembershipPlanRow> & {
            coverage: { period: string; periodLabel: string; member: boolean; super: boolean }[]
          }
        >('/admin/membership/plans', { query: q }),
      create: (body: Record<string, unknown>) =>
        request<{ success: boolean; plan: MembershipPlanRow }>('/admin/membership/plans', {
          method: 'POST',
          body,
        }),
      update: (id: string, body: Record<string, unknown>) =>
        request<{ success: boolean; plan: MembershipPlanRow }>(`/admin/membership/plans/${id}`, {
          method: 'PATCH',
          body,
        }),
      remove: (id: string) =>
        request<{ success: boolean; id: string }>(`/admin/membership/plans/${id}`, {
          method: 'DELETE',
        }),
    },
    rules: {
      list: (q: Query) =>
        request<Paged<MembershipRuleRow> & { incompleteCount: number }>('/admin/membership/rules', {
          query: q,
        }),
      create: (body: Record<string, unknown>) =>
        request<{ success: boolean; rule: MembershipRuleRow }>('/admin/membership/rules', {
          method: 'POST',
          body,
        }),
      update: (id: string, body: Record<string, unknown>) =>
        request<{ success: boolean; rule: MembershipRuleRow }>(`/admin/membership/rules/${id}`, {
          method: 'PATCH',
          body,
        }),
      remove: (id: string) =>
        request<{ success: boolean; id: string }>(`/admin/membership/rules/${id}`, {
          method: 'DELETE',
        }),
    },
    /** 受邀用户定价规则：常规定价算完后再抬一档（被邀请家长价格更高）。 */
    referralRules: {
      list: (q: Query) =>
        request<Paged<MembershipReferralRuleRow>>('/admin/membership/referral-rules', {
          query: q,
        }),
      create: (body: Record<string, unknown>) =>
        request<{ success: boolean; rule: MembershipReferralRuleRow }>(
          '/admin/membership/referral-rules',
          {
            method: 'POST',
            body,
          },
        ),
      update: (id: string, body: Record<string, unknown>) =>
        request<{ success: boolean; rule: MembershipReferralRuleRow }>(
          `/admin/membership/referral-rules/${id}`,
          {
            method: 'PATCH',
            body,
          },
        ),
      remove: (id: string) =>
        request<{ success: boolean; id: string }>(`/admin/membership/referral-rules/${id}`, {
          method: 'DELETE',
        }),
    },
    /** 改规则前先算一遍：传 userId 用真实账号画像，不传就用自定义画像。 */
    simulate: (body: {
      planCode: string
      userId?: number
      hasPaid?: boolean
      activeTier?: string
      deviceCount?: number
      registeredDaysAgo?: number
      /** 自定义画像时用：买家是不是被邀请注册的。 */
      invited?: boolean
      /** 自定义画像时用：邀请关系是否仍然有效（默认 true）。 */
      referralActive?: boolean
    }) =>
      request<{
        success: boolean
        source: string
        plan: MembershipPlanRow
        context: {
          hasPaid: boolean
          activeTier: string
          deviceCount: number
          registeredDaysAgo: number
        }
        result: {
          originalCents: number
          finalCents: number
          discountCents: number
          monthlyEquivalentCents: number
          adjustments: MembershipAdjustment[]
        }
        /** 受邀用户定价的判定与结果。 */
        referral: MembershipSimulateReferral
        /** 命中但被「不可叠加」挤掉、最终没进价的规则 */
        missed: MembershipAdjustment[]
      }>('/admin/membership/simulate', { method: 'POST', body }),
    orders: {
      list: (q: Query) =>
        request<
          Paged<MembershipOrderRow> & {
            summary: {
              statusCounts: Record<string, { count: number; amountCents: number }>
              paidCount: number
              paidAmountCents: number
            }
          }
        >('/admin/membership/orders', { query: q }),
    },
    stats: (q: Query) => request<{ success: boolean } & MembershipStats>('/admin/membership/stats', { query: q }),
  },

  /** 分享提成 / 邀请返现。列表接口没有 totalPages，页签用 totalPagesOf() 自己算。 */
  referral: {
    stats: (days: number) => request<ReferralStats>('/admin/referral/stats', { query: { days } }),

    invitees: {
      list: (q: Query) => request<ReferralPaged<ReferralInviteeRow>>('/admin/referral/invitees', { query: q }),
    },

    rewards: {
      list: (q: Query) =>
        request<ReferralPaged<ReferralRewardRow> & { summary: { statusCounts: ReferralStatusCounts } }>(
          '/admin/referral/rewards',
          { query: q },
        ),
    },

    coupons: {
      list: (q: Query) =>
        request<ReferralPaged<ReferralCouponRow> & { summary: { statusCounts: ReferralStatusCounts } }>(
          '/admin/referral/coupons',
          { query: q },
        ),
    },

    withdrawals: {
      list: (q: Query) =>
        request<ReferralPaged<ReferralWithdrawalRow> & { summary: { statusCounts: ReferralStatusCounts } }>(
          '/admin/referral/withdrawals',
          { query: q },
        ),
      /** 单向状态机：pending → approved → paid，或 pending → rejected。 */
      review: (id: string, body: { action: 'approve' | 'reject' | 'pay'; note?: string }) =>
        request<{
          id: string
          withdrawNo: string
          userLabel: string
          amountCents: number
          status: string
          statusLabel: string
          reviewNote: string
          reviewedAt: string | null
          paidAt: string | null
        }>(`/admin/referral/withdrawals/${id}/review`, { method: 'POST', body }),
    },

    rules: {
      get: () => request<ReferralRuleset>('/admin/referral/rules'),
      /** 整表替换：必须带上每一档与每一条券规则，服务端会先删后建。 */
      update: (body: ReferralRulesUpdateBody) =>
        request<ReferralRuleset>('/admin/referral/rules', { method: 'PUT', body }),
    },

    config: {
      get: () => request<ReferralConfigView>('/admin/referral/config'),
      update: (body: ReferralConfigUpdateBody) =>
        request<ReferralConfigView>('/admin/referral/config', { method: 'PUT', body }),
    },

    /** 只读风控清单：只列出来给人看，没有处罚动作。 */
    risk: (days: number) => request<ReferralRiskResult>('/admin/referral/risk', { query: { days } }),
  },
}

export * from './client'
