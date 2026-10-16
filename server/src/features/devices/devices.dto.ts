import { z } from 'zod';
import {
  COMMAND_STATUSES,
  DEVICE_MEMBER_ROLES,
  GAP_FIXABILITIES,
  GAP_IMPORTANCES,
  HEALTH_LEVELS,
  REMOTE_ACTIONS,
  TIME_REQUEST_DEFAULT_MINUTES,
  TIME_REQUEST_KINDS,
  TIME_REQUEST_MAX_MINUTES,
  TIME_REQUEST_MIN_MINUTES,
  TIME_REQUEST_STATUSES,
} from './devices.constants';

const deviceIdParam = z.string().trim().min(1, '缺少设备 ID');

/** 家长输入孩子设备上显示的绑定码，认领设备。 */
export const bindDeviceSchema = z.object({
  deviceCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{6,12}$/, '绑定码为 6-12 位字母或数字'),
  name: z.string().trim().min(1, '请输入设备名称').max(30).optional(),
});

export const updateDeviceSchema = z.object({
  name: z.string().trim().min(1, '设备名称不能为空').max(30).optional(),
  avatar: z.string().trim().max(500).optional(),
  /** 隐藏孩子设备桌面图标（§9）。读写都挂在这里，家长端不需要新接口。 */
  hideIcon: z.boolean().optional(),
});

export const selectDeviceSchema = z.object({
  deviceId: deviceIdParam,
});

export const deviceIdSchema = z.object({ deviceId: deviceIdParam });

/** 锁屏 / 解锁 */
export const lockSchema = z.object({
  locked: z.boolean({ required_error: '缺少 locked 参数' }),
});

/** 临时解锁时长（分钟） */
export const tempUnlockSchema = z.object({
  minutes: z.coerce
    .number()
    .int('时长必须是整数')
    .min(1, '时长至少 1 分钟')
    .max(24 * 60, '时长最多 24 小时'),
});

/** 录像/录音的停止请求：mock 版要求传 recordingId 却从不使用，这里真正做归属校验。 */
export const stopCaptureSchema = z.object({
  recordingId: z.string().trim().min(1, '缺少录制 ID'),
});

export const commandListQuerySchema = z.object({
  status: z.enum(COMMAND_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/** 手动把某条 pending 指令作废（家长反悔） */
export const commandIdSchema = z.object({ commandId: z.string().trim().min(1) });

// ============================================================
// 设备端 Agent 接口
// ============================================================

/**
 * 设备端自助注册。
 * deviceCode / deviceSecret 由设备本地生成并持久化：
 *  - 首次注册：服务端建一条「待认领」设备记录；
 *  - 之后重启再用同一对值调用，服务端校验 secret 后重新签发 device token（幂等）。
 */
export const agentRegisterSchema = z.object({
  deviceCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{6,12}$/, '设备码为 6-12 位字母或数字'),
  deviceSecret: z.string().trim().min(16, '设备密钥至少 16 位').max(200),
  name: z.string().trim().max(30).optional(),
  model: z.string().trim().max(60).default('Unknown'),
  os: z.string().trim().max(30).default('Unknown'),
  osVersion: z.string().trim().max(30).default(''),
  agentVersion: z.string().trim().max(30).default(''),
});

/** 设备心跳：顺带上报电量、网络、前台状态。 */
export const agentHeartbeatSchema = z.object({
  battery: z.coerce.number().int().min(0).max(100).optional(),
  network: z.enum(['wifi', 'cellular', 'ethernet', 'unknown']).optional(),
  agentVersion: z.string().trim().max(30).optional(),
  /**
   * 设备上<b>实际</b>是否处于锁定。
   *
   * 与 DeviceCommand 里的 locked（家长的期望状态）不是一回事：设备可能因为
   * 作息时间表或每日额度而锁定。设备端每秒求值一次，状态变化时随心跳上报，
   * 家长端因此能看到「现在到底锁没锁」，而不是只知道自己的期望值。
   */
  effectiveLocked: z.boolean().optional(),
  lockReason: z.string().trim().max(60).optional(),
});

/**
 * 设备健康快照（规划 §1.1）。
 *
 * ── 为什么 `gaps` 由设备端给结构而不是服务端给 ──────────────────────────
 * 「哪一项坏了」是设备端的事实（它读的是本机系统设置），
 * 「为什么坏了、能不能修、怎么修」同样只有设备端知道：不同 ROM 上
 * 电池白名单要不要点系统框、无障碍能不能被设备所有者写回去，结论都不一样。
 * 服务端若自己维护一张对照表，ROM 一换就会给出错的修复步骤。
 * 所以这里只校验形状与长度上限，内容一律原样透传给家长端。
 *
 * 注意 `gaps` 为空数组是**合法**的（一切正常），不是「全量替换漏传」——
 * 本接口是整份快照 upsert，不做「空数组一律 422」那条规则。
 */
export const agentHealthGapSchema = z.object({
  /** 稳定的机器可读标识（如 `accessibility`），供前端定位与去重，不展示。 */
  id: z.string().trim().min(1).max(60),
  label: z.string().trim().max(60).default(''),
  /** 人话说明，家长端直接展示 —— 设备端下发的原文，不在服务端重写。 */
  detail: z.string().trim().min(1).max(300),
  importance: z.enum(GAP_IMPORTANCES).default('major'),
  fixability: z.enum(GAP_FIXABILITIES).default('manual'),
  /** 修复指引（分机型步骤的要点）。fixability=auto 时可为空。 */
  fixHint: z.string().trim().max(300).default(''),
});

export type AgentHealthGap = z.infer<typeof agentHealthGapSchema>;

export const agentHealthSchema = z.object({
  /** 设备端自己下的结论；缺省时服务端用 deriveHealthLevel 兜底推算（老版本 Agent）。 */
  level: z.enum(HEALTH_LEVELS).optional(),
  gaps: z.array(agentHealthGapSchema).max(60).default([]),
  /**
   * 布尔开关快照。**刻意不写成固定 key 的 object**：设备端版本可能比服务端新
   * （先发了新检查项）也可能更旧（还没实现某项）。固定 key 会让老设备上报直接 422，
   * 或者让新项的缺失被 default 成一个假的 false —— 家长端会看到一条「被关掉」的假警报。
   * 所以这里只约束「值必须是 boolean」，缺哪个 key 就是「未知」。
   */
  checks: z.record(z.boolean()).default({}),
  /** 运行时权限快照：{ location: 'granted' | 'denied', ... }，同样容忍未知 key。 */
  permissions: z.record(z.enum(['granted', 'denied'])).default({}),
  /** OwnerHardening.audit() 的原样输出。 */
  restrictions: z
    .array(
      z.object({
        id: z.string().trim().min(1).max(60),
        label: z.string().trim().max(60).default(''),
        supported: z.boolean().default(true),
        applied: z.boolean().default(false),
      }),
    )
    .max(80)
    .default([]),
  serviceRunning: z.boolean().default(false),
  /** 设备墙钟 − 服务端时间（秒）。规划 §1.6，用于发现「孩子把时间改了」。 */
  clockSkewSeconds: z.coerce.number().int().min(-86_400).max(86_400).default(0),
  healCount: z.coerce.number().int().min(0).max(1_000_000).default(0),
  lastHealAt: z.coerce.date().optional(),
});

/** 家长查健康页时可指定设备；缺省用「当前设备」。 */
export const healthQuerySchema = z.object({ deviceId: deviceIdParam.optional() });

/** 设备端回报指令执行结果。 */
export const agentCommandResultSchema = z.object({
  status: z.enum(['succeeded', 'failed'], { required_error: '缺少执行结果' }),
  result: z.unknown().optional(),
  error: z.string().trim().max(500).optional(),
});

/** 设备端上报位置。 */
export const agentLocationSchema = z.object({
  latitude: z.coerce.number().min(-90).max(90),
  longitude: z.coerce.number().min(-180).max(180),
  accuracy: z.coerce.number().min(0).max(100_000).optional(),
  address: z.string().trim().max(200).optional(),
  recordedAt: z.coerce.date().optional(),
});

/** 设备端答题。 */
export const agentQuizAnswerSchema = z.object({
  questionId: z.string().trim().min(1),
  answer: z.coerce.number().int().min(0).max(20),
});

/** 设备端拉取指令：wait 表示长轮询等待秒数（0 = 立即返回）。 */
export const agentPollQuerySchema = z.object({
  wait: z.coerce.number().int().min(0).max(50).default(0),
});

// ============================================================
// 应用审核（§3）
// ============================================================

/**
 * 设备端上报「想装这个应用」。
 * packageName 是幂等键（同一台设备 + 同一个包名只有一条 pending），因此必填。
 */
export const agentAuditRequestSchema = z.object({
  appName: z.string().trim().min(1).max(60),
  packageName: z.string().trim().min(1).max(120),
});

export const auditRequestIdSchema = z.object({ id: z.string().trim().min(1) });

// ============================================================
// 孩子的申请（§3.1）
// ============================================================

/**
 * 设备端提交一条申请（加时 / 延后锁屏）。
 *
 * minutes 用 coerce + 默认值：设备端换版本时可能漏传，而「漏传分钟数」不该
 * 变成一条 422 —— 孩子此刻正对着锁屏页，家长那边收到一个 30 分钟的默认申请
 * 比收到一个报错有用得多。
 */
export const agentTimeRequestSchema = z.object({
  kind: z.enum(TIME_REQUEST_KINDS).default('extend_time'),
  minutes: z.coerce
    .number()
    .int()
    .min(TIME_REQUEST_MIN_MINUTES)
    .max(TIME_REQUEST_MAX_MINUTES)
    .default(TIME_REQUEST_DEFAULT_MINUTES),
  reason: z.string().trim().max(200).default(''),
});

/** POST /api/agent/sos —— 孩子点的求助；理由可选（最长 200 字）。 */
export const agentSosSchema = z.object({
  message: z.string().trim().max(200).optional(),
});

export const timeRequestIdSchema = z.object({ id: z.string().trim().min(1) });

/** 家长端列表：默认只看待审批（家长打开页面就是来处理这些的），可显式查历史。 */
export const timeRequestQuerySchema = z.object({
  status: z.enum([...TIME_REQUEST_STATUSES, 'all']).default('pending'),
});

/**
 * 家长审批。
 *
 * `minutes` 可选且**允许改小**：孩子申请 120 分钟、家长给 30 分钟是常态，
 * 强迫家长只能原样批准（或先拒绝再手动临时解锁）会把一个高频动作拆成两步。
 * 不允许改大：申请 5 分钟却批 240 分钟只会是误操作。
 */
export const reviewTimeRequestSchema = z.object({
  status: z.enum(['approved', 'rejected']),
  minutes: z.coerce
    .number()
    .int()
    .min(TIME_REQUEST_MIN_MINUTES)
    .max(TIME_REQUEST_MAX_MINUTES)
    .optional(),
  note: z.string().trim().max(200).default(''),
});

// ============================================================
// 逐应用用量（§4）
// ============================================================

/**
 * 设备端上报今日逐应用秒数 —— **全量替换**当日数据。
 *
 * 非空是刻意的：空数组语义上等于「今天所有应用都没用过」，
 * 那会把已有数据清空。宁可 422 也不要静默擦除家长看到的数据。
 */
export const agentAppUsageSchema = z.object({
  usage: z
    .array(
      z.object({
        packageName: z.string().trim().max(120).default(''),
        appName: z.string().trim().max(60).default(''),
        seconds: z.coerce.number().int().min(0).max(24 * 3600),
      }),
    )
    .min(1, 'usage 不能为空')
    .max(500),
});

// ============================================================
// 电话与短信（§8）
// ============================================================

const occurredAtField = z.coerce.date().optional();

/** 设备端批量上报通话记录（全量替换最近 N 条）。 */
export const agentCallLogSchema = z.object({
  calls: z
    .array(
      z.object({
        phoneNumber: z.string().trim().min(1).max(40),
        name: z.string().trim().max(60).default(''),
        type: z.enum(['incoming', 'outgoing', 'missed']),
        durationSeconds: z.coerce.number().int().min(0).max(24 * 3600).default(0),
        occurredAt: occurredAtField,
      }),
    )
    .min(1, 'calls 不能为空')
    .max(500),
});

const smsItemSchema = z.object({
  address: z.string().trim().min(1).max(40),
  body: z.string().max(2000),
  type: z.enum(['inbox', 'sent']),
  occurredAt: occurredAtField,
});

/**
 * 设备端批量上报短信（全量替换最近 N 条）。
 * 同时接受 `messages`（推荐）与 `sms` 两种包装字段名，避免三端各写各的。
 */
export const agentSmsSchema = z
  .object({
    messages: z.array(smsItemSchema).min(1).max(500).optional(),
    sms: z.array(smsItemSchema).min(1).max(500).optional(),
  })
  .refine((v) => Boolean(v.messages?.length || v.sms?.length), {
    message: 'messages 不能为空',
    path: ['messages'],
  })
  .transform((v) => ({ messages: v.messages ?? v.sms ?? [] }));

// ============================================================
// 家长端查询 / 指令（§7 §8 §9）
// ============================================================

const pageQuery = {
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
};

export const callLogQuerySchema = z.object({
  ...pageQuery,
  type: z.enum(['incoming', 'outgoing', 'missed']).optional(),
  /** 号码或姓名模糊搜索 */
  q: z.string().trim().max(60).optional(),
});

export const smsQuerySchema = z.object({
  ...pageQuery,
  type: z.enum(['inbox', 'sent']).optional(),
  /** 对方号码模糊搜索 */
  address: z.string().trim().max(40).optional(),
});

/** 远程协助动作（§7）。open_app 必须给出包名，否则设备端无从下手。 */
export const remoteActionSchema = z
  .object({
    action: z.enum(REMOTE_ACTIONS, { required_error: '缺少 action 参数' }),
    packageName: z.string().trim().min(1).max(120).optional(),
  })
  .refine((v) => v.action !== 'open_app' || Boolean(v.packageName), {
    message: 'open_app 动作必须提供 packageName',
    path: ['packageName'],
  });

/** 邀请一位家长共同守护这台设备（规划 §5.1）。按手机号找人 —— 家长之间只互知手机号。 */
export const inviteDeviceMemberSchema = z.object({
  phone: z
    .string()
    .trim()
    .regex(/^1[3-9]\d{9}$/, '请输入正确的手机号'),
  role: z.enum(DEVICE_MEMBER_ROLES).default('viewer'),
  nickname: z.string().trim().max(20).optional(),
});

export const deviceMemberIdSchema = z.object({
  // 参数名必须和路由里的 `:memberId` 一致 —— 写成 `id` 会让每个改角色/移除请求
  // 都在校验阶段 422（这个错法很隐蔽：接口「挂了」，但日志里看不出是谁没权限）
  memberId: z.string().trim().min(1, '缺少成员 ID'),
});

export const updateDeviceMemberSchema = z
  .object({
    role: z.enum(DEVICE_MEMBER_ROLES).optional(),
    nickname: z.string().trim().max(20).optional(),
  })
  .refine((v) => v.role !== undefined || v.nickname !== undefined, {
    message: '没有要修改的内容',
  });
