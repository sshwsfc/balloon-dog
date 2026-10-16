/**
 * 功能开关的「单一事实来源」。
 *
 * 数据库里 DeviceFeature 是 (deviceId, key) 的行，key 的合法取值只在这里定义，
 * 任何接口传入未列出的 key 都会被拒绝 —— mock 版是直接拿用户传的字符串去索引对象，
 * 拼错就静默无效，这里改成显式白名单。
 */

export interface FeatureDef {
  key: string;
  label: string;
  /** basic=基础功能，advanced=高级功能（前端分组展示） */
  group: 'basic' | 'advanced';
  /** 新绑定设备的默认开关状态 */
  defaultEnabled: boolean;
  description: string;
}

export const FEATURE_DEFS: FeatureDef[] = [
  // ---- 基础功能 ----
  { key: 'lockScreen', label: '一键锁屏', group: 'basic', defaultEnabled: true, description: '立即锁定设备屏幕' },
  { key: 'tempUnlock', label: '临时使用', group: 'basic', defaultEnabled: true, description: '授权临时使用权限' },
  { key: 'timePlan', label: '时间规划', group: 'basic', defaultEnabled: true, description: '设置使用时间限制' },
  { key: 'appLimit', label: '应用限制', group: 'basic', defaultEnabled: false, description: '限制应用使用时长' },
  { key: 'appAudit', label: '应用审核', group: 'basic', defaultEnabled: false, description: '审核新安装应用' },
  { key: 'webBlock', label: '网址拦截', group: 'basic', defaultEnabled: false, description: '拦截不良网站' },
  { key: 'modeSwitch', label: '模式切换', group: 'basic', defaultEnabled: false, description: '学习模式 / 普通模式，学习模式下只允许白名单应用' },
  { key: 'eyeCare', label: '护眼设置', group: 'basic', defaultEnabled: false, description: '连续用眼提醒、强制休息、夜间护眼' },
  { key: 'appPlugin', label: '功能管控', group: 'basic', defaultEnabled: false, description: '按应用关闭微信 / QQ 等具体功能' },
  // ---- 高级功能 ----
  { key: 'quizUnlock', label: '答题解锁', group: 'advanced', defaultEnabled: false, description: '通过答题获得使用时长' },
  // label 必须和家长端界面的名字一致：requireFeatureEnabled 的报错是
  // 「请先开启「${label}」功能」，label 写成「同屏监控」而家长端到处写着「屏幕洞察」时，
  // 家长会拿着一个界面上根本不存在的名字去找开关。产品上也确实没有实时投屏能力，
  // 「同屏监控」是个名不副实的名字（见 docs/FEATURE-STATUS.md §3.9）。
  { key: 'screenMonitor', label: '屏幕洞察', group: 'advanced', defaultEnabled: false, description: '按需抓取屏幕画面交给 AI 分析' },
  { key: 'remoteHelp', label: '远程协助', group: 'advanced', defaultEnabled: false, description: '远程操作帮助' },
  { key: 'callSms', label: '电话短信', group: 'advanced', defaultEnabled: false, description: '查看通话和短信' },
  { key: 'remotePhoto', label: '远程拍照', group: 'advanced', defaultEnabled: false, description: '远程拍摄照片' },
  { key: 'remoteRecord', label: '远程录音', group: 'advanced', defaultEnabled: false, description: '远程录制音频' },
  { key: 'videoRecord', label: '连续录像', group: 'advanced', defaultEnabled: false, description: '持续视频录制' },
  { key: 'audioRecord', label: '环境监听', group: 'advanced', defaultEnabled: false, description: '持续采集环境声音' },
];

export const FEATURE_KEYS = FEATURE_DEFS.map((f) => f.key);

const FEATURE_KEY_SET = new Set(FEATURE_KEYS);

export function isFeatureKey(key: string): boolean {
  return FEATURE_KEY_SET.has(key);
}

export function defaultEnabledOf(key: string): boolean {
  return FEATURE_DEFS.find((f) => f.key === key)?.defaultEnabled ?? false;
}

/** 指令类型白名单。 */
export const COMMAND_TYPES = [
  'lock',
  'unlock',
  'temp_unlock',
  'cancel_temp_unlock',
  'remote_photo',
  'screenshot',
  'start_recording',
  'stop_recording',
  'start_audio',
  'stop_audio',
  'fetch_location',
  'sync_config',
  // 让设备重新上报已安装应用清单（家长点「刷新应用列表」时下发）。
  // 刻意不叫 sync_apps 之类会让人以为是「同步配置」的名字：它只做一件事。
  'sync_apps',
  // 环境监听（分片连续录音）。要求特性 audioRecord —— 不是 remoteRecord：
  // 「远程录音」是一次性取证，「环境监听」是持续采集，两者权限与提示文案都不同。
  'start_ambient',
  'stop_ambient',
  // 远程协助：受限但真实的「远程操作」（返回/主页/最近任务/通知栏/打开应用）。
  'remote_action',
  // 让设备重新上报通话记录与短信（家长点「刷新」时下发）。
  'sync_calls_sms',
  // 家长点「重新检测」时下发：设备端立刻跑一次自愈巡检（LongevityGuard.selfHeal），
  // 并把最新的健康快照上报回来（规划 §1.3）。刻意不叫 health_report：
  // 它不是「让设备上报」，而是「让设备自己动手修一遍再上报」——两者的家长预期不同。
  'self_check',
] as const;

export type CommandType = (typeof COMMAND_TYPES)[number];

const COMMAND_TYPE_SET = new Set<string>(COMMAND_TYPES);
export function isCommandType(t: string): t is CommandType {
  return COMMAND_TYPE_SET.has(t);
}

export const COMMAND_STATUSES = [
  'pending', // 已下发，等待设备领取
  'dispatched', // 设备已领取，执行中
  'succeeded',
  'failed',
  'expired', // 超时未被领取
  'cancelled', // 被家长撤销
] as const;

export type CommandStatus = (typeof COMMAND_STATUSES)[number];

/** 指令的中文名，用于给用户提示「远程拍照指令已下发」。 */
export const COMMAND_LABELS: Record<string, string> = {
  lock: '锁屏',
  unlock: '解锁',
  temp_unlock: '临时解锁',
  cancel_temp_unlock: '取消临时解锁',
  remote_photo: '远程拍照',
  screenshot: '屏幕截图',
  start_recording: '开始录像',
  stop_recording: '停止录像',
  start_audio: '开始录音',
  stop_audio: '停止录音',
  fetch_location: '获取位置',
  sync_config: '同步配置',
  sync_apps: '同步应用列表',
  start_ambient: '开始环境监听',
  stop_ambient: '停止环境监听',
  remote_action: '远程协助',
  sync_calls_sms: '同步通话短信',
  self_check: '重新检测',
};

/** 远程协助允许的动作白名单（§7）。open_app 必须带 packageName。 */
export const REMOTE_ACTIONS = ['back', 'home', 'recents', 'notifications', 'open_app'] as const;

export type RemoteAction = (typeof REMOTE_ACTIONS)[number];

export function commandLabel(type: string): string {
  return COMMAND_LABELS[type] ?? type;
}

/** 允许「离线设备也先记下指令、等上线再执行」的指令类型。 */
export const QUEUEABLE_WHEN_OFFLINE: ReadonlySet<string> = new Set([
  'lock',
  'unlock',
  'temp_unlock',
  'cancel_temp_unlock',
  'sync_config',
  'fetch_location',
]);

// ============================================================
// 设备健康（规划 §1）
// ============================================================

/**
 * 健康等级。
 *
 * 由**设备端**下结论，服务端不重新判一遍：两边各判一次迟早会不一致，
 * 而家长会同时看到「设备说危险」（动态流）和「平台说正常」（健康页）这种自相矛盾的结论。
 * 服务端只在设备端没给等级时（老版本 Agent）用 {@link deriveHealthLevel} 兜底推算。
 */
export const HEALTH_LEVELS = ['ok', 'warn', 'danger'] as const;
export type HealthLevel = (typeof HEALTH_LEVELS)[number];

export const HEALTH_LEVEL_LABELS: Record<HealthLevel, string> = {
  ok: '管控正常',
  warn: '部分能力降级',
  danger: '管控已实质失效',
};

/** 缺口对家长的严重程度：critical=管控已实质失效，major=部分能力降级，minor=有影响但不致命。 */
export const GAP_IMPORTANCES = ['critical', 'major', 'minor'] as const;
export type GapImportance = (typeof GAP_IMPORTANCES)[number];

/**
 * 这条缺口能不能自己修好。
 *
 * `auto`  = 设备端下次自愈就会补上（点「重新检测」即修）
 * `manual`= 必须在孩子手机上点一次系统框（家长端给步骤）
 * `none`  = 系统限制，谁都修不了，只能如实告诉家长（例如非设备所有者下的无障碍）
 */
export const GAP_FIXABILITIES = ['auto', 'manual', 'none'] as const;
export type GapFixability = (typeof GAP_FIXABILITIES)[number];

export interface HealthCheckDef {
  key: string;
  label: string;
  /** 家长能理解的一句话：这项开着有什么用。 */
  why: string;
  /** 这项关掉算不算「危险」（决定兜底等级）。 */
  critical: boolean;
}

/**
 * 健康页顶部那张「开关一览表」要显示哪些项、按什么顺序、每项为什么重要。
 *
 * 这里是**展示元数据**（标签 + 解释），不是事实来源：某项到底是开是关，
 * 一律以设备端上报的 `checks` 为准；设备端没报这个 key 就显示「未知」，
 * 而不是替它猜一个「正常」——猜出来的绿灯比红灯更危险。
 */
export const HEALTH_CHECK_DEFS: HealthCheckDef[] = [
  { key: 'deviceOwner', label: '设备所有者', critical: true, why: '没有它，孩子可以直接卸载本应用，防卸载与防强停全部失效' },
  { key: 'accessibility', label: '无障碍看门狗', critical: true, why: '锁定、限时、应用拦截、免授权截图都靠它把界面拉回来' },
  { key: 'adminActive', label: '设备管理器', critical: false, why: '锁屏能力的底座；关掉后只能靠悬浮窗兜底' },
  { key: 'overlay', label: '悬浮窗权限', critical: false, why: '锁定页盖在最上层；关掉后按返回键有概率逃出' },
  { key: 'protectedPackage', label: '受保护包', critical: false, why: '让孩子在「应用信息」里点不动强行停止' },
  { key: 'batteryWhitelist', label: '电池优化白名单', critical: false, why: '不在白名单里，息屏后会被 Doze 冻结，指令与心跳延迟' },
  { key: 'vpnConsent', label: '网址拦截授权', critical: false, why: 'VPN 授权被撤销后 DNS 拦截就停了' },
  { key: 'vpnAlwaysOn', label: '永久 VPN 绑定', critical: false, why: '少了它，孩子从快捷开关一划就能断掉网址拦截' },
  { key: 'usageAccess', label: '使用情况访问', critical: false, why: '逐应用限时与今日时长统计依赖它' },
];

/** 运行时权限的展示顺序与中文名（与设备端 PermissionGranter.permissionLabel 保持一致）。 */
export const HEALTH_PERMISSION_DEFS: { key: string; label: string }[] = [
  { key: 'location', label: '位置信息' },
  { key: 'camera', label: '相机' },
  { key: 'mic', label: '麦克风' },
  { key: 'callLog', label: '通话记录' },
  { key: 'sms', label: '短信' },
  { key: 'notification', label: '通知' },
];

/**
 * 设备端没给 level 时的兜底推算。
 *
 * 只在「老版本 Agent 只报了 checks、没报 level」时用得上；新版本一律以设备端结论为准。
 */
export function deriveHealthLevel(checks: Record<string, boolean>): HealthLevel {
  const criticalOff = HEALTH_CHECK_DEFS.filter((d) => d.critical).some((d) => checks[d.key] === false);
  if (criticalOff) return 'danger';
  const anyOff = HEALTH_CHECK_DEFS.some((d) => checks[d.key] === false);
  return anyOff ? 'warn' : 'ok';
}

/**
 * 在线分级（规划 §1.5）。
 *
 * 只有二值 online/offline 时，家长分不清「刚切后台」和「三天没开机」，
 * 而这两件事该采取的行动完全不同：前者等一会儿，后者要去找孩子。
 */
export const LIVENESS_THRESHOLDS = {
  /** 2 分钟内算心跳正常。心跳间隔 15 秒，留 8 倍余量以容忍一次网络抖动。 */
  delayedAfterMs: 2 * 60_000,
  /** 30 分钟没心跳算失联 —— 超过这个时长，家长的指令基本不可能立刻生效。 */
  offlineAfterMs: 30 * 60_000,
  /** 24 小时没心跳算严重失联：可能是关机、被卸装、或设备被扣下了。 */
  lostAfterMs: 24 * 60 * 60_000,
} as const;

export const LIVENESS_LEVELS = ['online', 'delayed', 'offline', 'lost', 'never'] as const;
export type LivenessLevel = (typeof LIVENESS_LEVELS)[number];

export const LIVENESS_LABELS: Record<LivenessLevel, string> = {
  online: '在线',
  delayed: '心跳延迟',
  offline: '失联',
  lost: '严重失联',
  never: '从未连接',
};

/**
 * 失联事件的去重窗口。
 *
 * 失联是「按读取时的时间差算出来」的状态，不是设备端发来的事件，所以没有天然的触发点。
 * 服务端在家长读健康页时顺带补记一条 `agent_offline` 动态，靠这个窗口保证
 * 家长反复刷新不会刷出一屏重复的「设备失联」。
 */
export const OFFLINE_EVENT_DEDUPE_MS = 6 * 60 * 60_000;

/**
 * 孩子的「申请」白名单（规划 §3.1）。
 *
 * 与功能开关同样的理由：kind 拼错只会静默落库，而家长端按 kind 分组展示，
 * 一条 kind='extendtime' 的申请会变成家长界面上一个永远显示不出名字的条目。
 *
 * 两种 kind 的**落地动作是同一个**（都是下发一段 temp_unlock 放行窗口），
 * 区别只在于孩子点的是哪个按钮、家长看到的文案是什么。
 * 不在服务端为它们写两套逻辑 —— 那会造出两条只差文案的分支。
 */
export const TIME_REQUEST_KINDS = ['extend_time', 'delay_lock'] as const;
export type TimeRequestKind = (typeof TIME_REQUEST_KINDS)[number];

/** 孩子端按钮与家长端列表都用这份文案；家长端还会把它包进 t() 做英文映射。 */
export const TIME_REQUEST_KIND_LABELS: Record<TimeRequestKind, string> = {
  extend_time: '申请加时',
  delay_lock: '申请延后锁屏',
};

export const TIME_REQUEST_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type TimeRequestStatus = (typeof TIME_REQUEST_STATUSES)[number];

/**
 * 单次申请的分钟数边界。
 *
 * 上限 240 分钟（4 小时）不是技术限制而是产品判断：一次批准超过 4 小时，
 * 「家长在管」这件事本身就名存实亡了；真要给这么久，家长该改的是时间规划，
 * 而不是点一次「同意」。下限 5 分钟是为了挡住误触和「申请 1 分钟」这种噪音。
 */
export const TIME_REQUEST_MIN_MINUTES = 5;
export const TIME_REQUEST_MAX_MINUTES = 240;
export const TIME_REQUEST_DEFAULT_MINUTES = 30;

/**
 * 待审批申请的去重时间窗。
 *
 * 孩子端锁屏页会反复问「批了吗」，网络重试也可能重复提交同一条申请。
 * 同一台设备 + 同一个 kind 在窗口内已有 pending 时不新建，直接回既有那条 ——
 * 否则家长端会被「申请加时」刷屏，而人一旦被刷屏就会开始无脑点同意。
 * 窗口取 60 分钟：超过一小时还没批，孩子重新问一次是合理的。
 */
export const TIME_REQUEST_DEDUPE_MS = 60 * 60_000;

/**
 * 家庭成员的角色（规划 §5.1）。
 *
 * 只有两档，刻意不做「能看位置不能看媒体」这种细粒度矩阵：家长之间真实的分歧是
 * 「谁有权改设置」，而不是「谁能看哪一页」。细粒度权限看起来更专业，实际是让每个
 * 新接口都要重新想一遍该归哪一档，最后必然出现漏网的接口 —— 而漏掉的那个一定是写接口。
 */
export const DEVICE_MEMBER_ROLES = ['admin', 'viewer'] as const;
export type DeviceMemberRole = (typeof DEVICE_MEMBER_ROLES)[number];
export const DEVICE_MEMBER_ROLE_LABELS: Record<DeviceMemberRole, string> = {
  admin: '管理员',
  viewer: '只读',
};

/**
 * 一台设备最多几个家庭成员（不含所有者）。
 *
 * 上限不是为了省数据库空间，而是挡住「拉一个群来一起看孩子」的用法：
 * 共同守护是家里两三个大人的事，人一多就没有人真的负责了。
 */
export const DEVICE_MEMBER_LIMIT = 5;
