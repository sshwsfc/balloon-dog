/**
 * 合规文本与「最小必要采集」清单（规划 §5.3）。
 *
 * 这里是**唯一的一份**：家长端页面、导出文件、e2e 断言都读它。
 * 各写一份的代价不是重复劳动，而是「页面上说的是 A、导出里说的是 B」——
 * 合规文档最不能有的就是不诚实的不一致。
 *
 * 版本号规则：**改一个字就换版本**。同意记录存 (docType, docVersion)，
 * 旧版本的同意不能自动沿用新文本，所以同意时客户端必须回传它看到的版本，服务端在这里核对。
 */

/** 当前生效的文本版本。改文案必须改它，否则「同意过」会指向一份没人看过的文本。 */
export const PRIVACY_DOC_VERSION = '2026-10-01';

/** 注销冷静期。申请后监控立刻停，但留 7 天让人反悔（数据到期才真删）。 */
export const DELETION_GRACE_DAYS = 7;

/** 撤回同意 / 注销账号都要求手动打出这句话：这类动作不该被一次误触完成。 */
export const DELETION_CONFIRM_TEXT = '删除我的账号';
export const REVOKE_CONFIRM_TEXT = '撤回同意';

/** 导出时每个列表最多带多少条（带 `truncated` 标记，不假装是全量）。 */
export const EXPORT_ROW_LIMIT = 500;

export interface PrivacyDocSection {
  title: string;
  body: string;
}

export interface PrivacyDoc {
  docType: string;
  version: string;
  title: string;
  required: boolean;
  summary: string;
  sections: PrivacyDocSection[];
}

export const PRIVACY_DOCS: PrivacyDoc[] = [
  {
    docType: 'guardian_agreement',
    version: PRIVACY_DOC_VERSION,
    title: '家长监护授权与隐私说明',
    required: true,
    summary: '你确认自己是这台设备的监护人，并且已经把这些事告诉孩子。',
    sections: [
      {
        title: '这份说明管什么',
        body: '本应用用于监护人对自己的未成年子女的设备做守护设置。你勾选同意，表示你确认自己是这些设备的监护人，并已经按下面写的内容告诉孩子。',
      },
      {
        title: '我们收集什么',
        body: '位置与安全区、应用清单与使用时长、通话与短信记录、截屏帧图、你主动触发的拍照/录屏/录音、设备健康与权限状态、答题与通知记录。每一项都有独立开关，在设备设置里随时可以关。',
      },
      {
        title: '孩子本人知道吗',
        body: '知道。孩子端有一个不会消失的说明页（「这台设备在被怎样守护」），顶部按本机真实开关生成；孩子也可以随时用求助按钮找你，这些都不需要经过你同意。',
      },
      {
        title: '谁能看到',
        body: '只有你，以及你主动邀请的家庭成员。运营管理员只能看到设置项与数量，看不到照片、位置轨迹、录音和短信验证码。',
      },
      {
        title: '保存多久',
        body: '除截屏帧图外，数据一直保留到你删除。截屏帧图按每台设备设置的天数自动清理（默认 7 天），清理时会同时删除磁盘上的图片。删除账号后进入 7 天冷静期，到期连同磁盘文件一起清除。',
      },
      {
        title: '你的权利',
        body: '导出：一键取走上面所有数据的 JSON 文件。删除：申请后 7 天内可以撤销，到期真的删除。撤回同意：立即停止监控，并删除这个账号下的设备记录（含设备上的照片与截屏）——账号、孩子档案与订单仍然保留，要重新绑定设备才能恢复监控。',
      },
      {
        title: '版本与留痕',
        body: '这几段文字改一个字就会换版本号。你同意时，我们会记录同意的版本、时间、IP 与浏览器标识；文本更新后需要重新同意。',
      },
    ],
  },
  {
    docType: 'minor_data_notice',
    version: PRIVACY_DOC_VERSION,
    title: '未成年人个人信息处理告知',
    required: true,
    summary: '处理的是孩子的信息；不满十四周岁由监护人同意；敏感项要单独打开，随时可以关。',
    sections: [
      {
        title: '处理的是谁的信息',
        body: '处理的是孩子的个人信息：位置、应用、通话与短信、影像。本应用只面向监护人开放，孩子不注册账号、没有密码，孩子端只能看到说明、求助和今天的任务。',
      },
      {
        title: '不满十四周岁',
        body: '不满十四周岁的孩子，个人信息按《个人信息保护法》第三十一条处理，由监护人同意。我们把这个同意落在家长账号上：只有监护人能绑定设备，所以只有监护人能同意，是最小风险的落点。',
      },
      {
        title: '敏感项要单独打开',
        body: '位置、通话与短信、截屏、麦克风与摄像头属于敏感个人信息，默认关闭，需要你在设备设置里逐项打开，随时可以关。关掉只影响对应功能，不会影响其它守护。',
      },
      {
        title: '孩子的求助通道',
        body: '孩子端有不经过家长同意的求助按钮和说明页。这是刻意做的：不给孩子留求助通道的监控，只是把风险从家长身上转到孩子身上。',
      },
      {
        title: '问题与投诉',
        body: '本应用仍在试运行，还没有独立的客服入口。对数据处理有疑问，请通过你获得安装包或服务号的渠道联系我们。',
      },
    ],
  },
];

export interface CollectionEntry {
  key: string;
  title: string;
  examples: string;
  purpose: string;
  retention: string;
  storedOn: string;
}

/**
 * 最小必要采集清单。
 *
 * 这张表必须和代码里的表一一对得上：写了「默认 7 天」就要有定时任务真的删文件，
 * 写了「服务端没有这张表」就不能有这张表。对不上就是虚假陈述，比不写更糟。
 */
export const COLLECTION_CATALOG: CollectionEntry[] = [
  {
    key: 'location',
    title: '位置与轨迹',
    examples: '定位点、安全区进出记录',
    purpose: '位置守护与进出安全区提醒',
    retention: '保留到账号删除',
    storedOn: '服务端数据库',
  },
  {
    key: 'apps',
    title: '应用清单与使用时长',
    examples: '已安装应用、使用时长、应用限额',
    purpose: '学习模式白名单、使用统计与时长限额',
    retention: '保留到账号删除',
    storedOn: '服务端数据库 + 孩子设备',
  },
  {
    key: 'calls_sms',
    title: '通话与短信记录',
    examples: '通话记录、短信往来（短信验证码只存哈希）',
    purpose: '家长了解孩子的通话与短信往来，并做验证码风险提示',
    retention: '保留到账号删除',
    storedOn: '服务端数据库',
  },
  {
    key: 'screen',
    title: '截屏帧图与 AI 结论',
    examples: '你开启「看屏幕」后设备抓取的帧图、对应用包的结论',
    purpose: '了解孩子当时在使用什么应用',
    retention: '默认 7 天（每台设备可设 1–90 天），到期连磁盘文件一起删',
    storedOn: '服务端磁盘 + 数据库',
  },
  {
    key: 'capture',
    title: '拍照 / 录屏 / 录音',
    examples: '你主动触发时设备上传的媒体文件',
    purpose: '让你主动看一次现场',
    retention: '保留到账号删除；删除账号时连磁盘文件一起删',
    storedOn: '服务端磁盘 + 数据库',
  },
  {
    key: 'health',
    title: '设备健康与权限状态',
    examples: '设备所有者、无障碍、电池优化、VPN 缺口',
    purpose: '告诉你管控是否还有效，哪一步需要你亲手做',
    retention: '保留到账号删除',
    storedOn: '服务端数据库',
  },
  {
    key: 'quiz',
    title: '答题与加时记录',
    examples: '答题记录、加时申请与你的审批',
    purpose: '给孩子一个自己争取时长的通道',
    retention: '保留到账号删除',
    storedOn: '服务端数据库',
  },
  {
    key: 'notify',
    title: '通知与消息',
    examples: '站内消息、微信模板消息的投递记录',
    purpose: '把重要事件告诉你',
    retention: '保留到账号删除',
    storedOn: '服务端数据库',
  },
  {
    key: 'account',
    title: '账号、会员与提现',
    examples: '手机号、昵称、订单；提现实名只存姓名、身份证后 4 位与整串哈希',
    purpose: '登录、计费与结算',
    retention: '保留到账号删除',
    storedOn: '服务端数据库',
  },
  {
    key: 'local_only',
    title: '只留在设备上的',
    examples: '「今天还剩多少分钟」是孩子设备自己算的',
    purpose: '少上传一份用不上的数据',
    retention: '不进服务端',
    storedOn: '孩子设备本地',
  },
];

/** 文档 / 列表里出现的角色与类别标签，供 e2e 断言引用。 */
export const PRIVACY_DOC_TYPES = PRIVACY_DOCS.map((d) => d.docType);
