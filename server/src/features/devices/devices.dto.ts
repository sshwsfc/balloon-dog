import { z } from 'zod';
import { COMMAND_STATUSES, REMOTE_ACTIONS } from './devices.constants';

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
