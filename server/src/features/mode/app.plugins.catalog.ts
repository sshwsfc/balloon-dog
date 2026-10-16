/**
 * 应用插件目录 —— 微信 / QQ 等功能管控的「有哪些可管控项」。
 *
 * <h3>为什么放在代码里而不是数据库</h3>
 * 这是**版本化的产品知识**：微信改一次版，条目文案就可能变，匹配文本要跟着调。
 * 放进表里会让它变成「家长可以改的数据」，而家长既没有能力也不该维护它。
 * 表里只存「家长把某一项开成了什么」（`AppPluginState`）。
 *
 * <h3>与 Android 端的关系</h3>
 * 设备端**不存目录副本**：它只接收「被家长改动过的项 + 匹配文本」，随配置一起落盘，
 * 所以断网照常生效。这样就不存在「服务端加了插件、设备端还不知道」这种静默失效 ——
 * 代价是目录里改文案必须能让设备端拿到新版规则（下发时随行）。
 *
 * <h3>三种匹配文本，对应三种界面事实（这一版新增）</h3>
 * 一个功能名会同时出现在三个地方，而它们的管控含义完全不同：
 * <ul>
 *   <li>{@link AppPluginDef#entryTexts} **入口行**：只在**可点击节点**上比对。
 *       发现页上的「朋友圈」那一行 → 命中入口 → 只吃掉这次点击，不整屏拦；
 *   </li>
 *   <li>{@link AppPluginDef#pageTexts} **功能页标题**：只在**窗口标题 / 顶部标题条**上比对。
 *       朋友圈页顶部的「朋友圈」→ 说明孩子已经进来了 → 整屏拦；
 *   </li>
 *   <li>{@link AppPluginDef#anywhereTexts} **页面内标志物**：在整窗任意位置比对，用于
 *       「出现即说明正在做这件事」且本身辨识度足够的串（「请输入支付密码」「确认支付」）。
 *       这类串不要放弱词（旧的「支付」「额度」就是弱词：聊天里提一句就被拦）。
 *   </li>
 * </ul>
 * 旧实现只有一组 `keywords` 且与整窗文本比对，于是「关掉朋友圈」会把整个发现页
 * （连同家长允许的扫一扫）一起拦掉，聊天里出现「朋友圈」三个字也会拦。
 * 判定逻辑见 `android/.../capability/GuardRules.java#matchPluginRules`，
 * 边界与实测见 `docs/PLAN-mode-eyecare-plugin.md`。
 *
 * <h3>已知缺口：三个跨应用伪包名目前不会命中（未修，勿当成已生效）</h3>
 * `__payment__` / `__appstore__` / `__browser__` 表达的是「横跨所有应用」的意图，
 * 但设备端是**按包名相等**匹配规则的，而真实前台包名永远不会等于一个伪包名 ——
 * 也就是说这三类开关**点了不会有任何效果**，而家长端照样把它们列出来（这是误导）。
 * 修法是让设备端把伪包名展开（支付＝任意应用、应用商店＝系统安装器、
 * 浏览器＝能处理 http/https 的应用），但那会把 22 条一直沉睡的规则一次性激活，
 * 必须在真机上逐条验收，因此没有混进「修误伤」这一轮。
 *
 * <h3>这条路的固有局限（会写进 android/README.md）</h3>
 * - 应用改版改了文案就会漏拦（所以每项给的是一**组**候选词，不是一条精确文本）；
 * - 看不见 WebView / 游戏画布里的内容；
 * - 有几百毫秒延迟，快速滑动可能闪过一帧；
 * - 可点击的正文（如聊天里能被长按的文本气泡）可能被误判成入口 —— 只吃一次点击，
 *   不会整屏拦，但要彻底消除得靠 viewId 级规则（见计划文档的后续项）。
 */

export type AppPluginCategory =
  | 'payment' // 支付与消费
  | 'social' // 社交
  | 'entertainment' // 娱乐
  | 'game' // 游戏
  | 'install' // 安装与分发
  | 'browsing' // 浏览
  | 'privacy'; // 隐私相关

export interface AppPluginDef {
  /** 稳定键名，服务端与设备端靠它对齐；一旦发布不可改名 */
  key: string;
  /** 给家长看的功能名，同时也是拦截原因里的说法（`该功能已被家长关闭（朋友圈）`） */
  label: string;
  category: AppPluginCategory;
  /** 入口行文本：只与**可点击节点**比对。命中 = 孩子正在点这个入口 */
  entryTexts: string[];
  /** 功能页标题文本：只与**窗口标题 / 顶部标题条**比对。命中 = 孩子已经进了这个功能页 */
  pageTexts: string[];
  /** 页面内标志物：整窗任意位置比对。只放辨识度足够、不会在日常正文里出现的串 */
  anywhereTexts: string[];
  /** 默认是否允许（true=允许）。默认按「放行」处理，避免升级后突然拦住孩子正常使用 */
  defaultEnabled: boolean;
}

export interface AppPluginTarget {
  /** Android 包名；`__payment__` 是跨应用的特殊目标（见文件头的「已知缺口」） */
  packageName: string;
  appName: string;
  /** 家长端卡片上的角标，直接用文字，避免为每个应用准备图标资源 */
  badge: string;
  plugins: AppPluginDef[];
}

/** 跨应用支付管控的伪包名（它不对应某个真实应用，而是横跨所有应用的内购）。 */
export const PAYMENT_TARGET = '__payment__';

interface AppPluginExtra {
  /** 不写则回落到 `[label]`（绝大多数功能的入口文案就是它自己那一页的标题） */
  pageTexts?: string[];
  anywhereTexts?: string[];
  defaultEnabled?: boolean;
}

const p = (
  key: string,
  label: string,
  category: AppPluginCategory,
  entryTexts: string[],
  extra: AppPluginExtra = {},
): AppPluginDef => ({
  key,
  label,
  category,
  entryTexts,
  pageTexts: extra.pageTexts ?? [label],
  anywhereTexts: extra.anywhereTexts ?? [],
  defaultEnabled: extra.defaultEnabled ?? true,
});

/**
 * 目录正文。
 *
 * 收录原则：只收**家长真的会想关掉**的功能，而不是把应用里每个入口都列一遍。
 * 列一堆无关痛痒的开关只会让家长找不到重点。
 */
export const APP_PLUGIN_CATALOG: AppPluginTarget[] = [
  {
    packageName: PAYMENT_TARGET,
    appName: '支付管理',
    badge: '支',
    plugins: [
      // 支付类没有「入口行」：钱是在弹窗/支付页里花掉的，所以判定靠页面内标志物。
      p('iap_game', '游戏内购', 'payment', ['立即购买'], {
        anywhereTexts: ['确认支付', '购买成功', '充值', '元宝', '点券'],
      }),
      p('iap_general', '应用内支付', 'payment', [], {
        anywhereTexts: ['确认支付', '立即支付', '确认付款', '订单支付'],
      }),
      p('pay_password', '支付密码页', 'payment', [], {
        anywhereTexts: ['请输入支付密码', '输入支付密码', '验证支付密码'],
      }),
      p('pay_qr', '付款码 / 收款码', 'payment', [], {
        anywhereTexts: ['付款码', '收款码', '向商家付款', '收付款'],
      }),
      p('pay_transfer', '转账', 'payment', [], {
        anywhereTexts: ['确认转账', '转账金额', '向对方转账'],
      }),
      p('pay_redpacket', '红包', 'payment', ['发红包', '拆红包'], {
        anywhereTexts: ['红包金额', '拼手气红包'],
      }),
      p('pay_wallet', '钱包与余额', 'payment', ['我的钱包'], {
        anywhereTexts: ['钱包余额', '零钱', '账户余额'],
      }),
      p('pay_bindcard', '绑定银行卡', 'payment', [], {
        anywhereTexts: ['添加银行卡', '绑定银行卡', '银行卡号'],
      }),
      // 「额度」原本在任意位置匹配 —— 它在正常应用里到处都是，已移除
      p('pay_credit', '借贷与分期', 'payment', [], {
        anywhereTexts: ['立即借款', '分期付款', '免息'],
      }),
      p('pay_lottery', '抽奖与盲盒', 'payment', [], {
        anywhereTexts: ['抽奖', '盲盒', '开箱', '幸运转盘'],
      }),
    ],
  },
  {
    packageName: 'com.tencent.mm',
    appName: 'WeChat',
    badge: '微',
    plugins: [
      p('mm_moments', '朋友圈', 'social', ['朋友圈', 'Moments', '发表文字'], {
        pageTexts: ['朋友圈', 'Moments'],
      }),
      p('mm_video_channel', '视频号', 'entertainment', ['视频号', '推荐', '关注', '朋友']),
      p('mm_live', '直播', 'entertainment', ['直播间', '正在直播', '进入直播间'], {
        pageTexts: ['直播'],
        anywhereTexts: ['送礼'],
      }),
      p('mm_miniprogram', '小程序', 'entertainment', ['小程序', '最近使用的小程序']),
      p('mm_game', '微信小游戏', 'game', ['小游戏', '游戏中心', '开始游戏'], {
        pageTexts: ['小游戏', '游戏中心'],
      }),
      p('mm_scan', '扫一扫', 'privacy', ['扫一扫', '扫描二维码', '扫描条码']),
      p('mm_shake', '摇一摇', 'social', ['摇一摇', '摇动手机']),
      p('mm_nearby', '附近的人', 'social', ['附近的人', '查看附近'], {
        pageTexts: ['附近的人', '附近'],
      }),
      p('mm_look', '看一看', 'entertainment', ['看一看', '在看', '精选']),
      p('mm_search', '搜一搜', 'browsing', ['搜一搜', '搜索歌曲', '搜索文章']),
      p('mm_channels', '公众号与订阅号', 'browsing', ['订阅号消息', '公众号', '关注的公众号'], {
        pageTexts: ['订阅号消息', '公众号'],
      }),
      // 「支付」原本在任意位置匹配（聊天里提一句也会被拦），已降级成入口词
      p('mm_pay_entry', '服务 / 支付入口', 'payment', ['服务', '支付'], {
        pageTexts: ['服务'],
        anywhereTexts: ['收付款', '向商家付款'],
      }),
      p('mm_groupchat', '群聊', 'social', ['群聊', '发起群聊', '群成员'], {
        pageTexts: ['群聊', '发起群聊'],
      }),
      p('mm_addfriend', '添加好友', 'social', ['添加朋友', '手机联系人', '雷达加朋友', '扫一扫加好友'], {
        pageTexts: ['添加朋友'],
      }),
      p('mm_moments_ad', '朋友圈广告与推荐', 'entertainment', [], {
        pageTexts: [],
        anywhereTexts: ['赞助内容', '广告'],
      }),
      p('mm_favorites_live', '微信豆与打赏', 'payment', ['微信豆', '赠送礼物', '打赏'], {
        anywhereTexts: ['微信豆'],
      }),
      p('mm_steps', '微信运动', 'social', ['微信运动', '步数排行榜', '捐赠步数']),
      p('mm_file_transfer', '文件传输与下载', 'browsing', ['文件传输助手', '下载文件', '另存为'], {
        pageTexts: ['文件传输助手'],
      }),
    ],
  },
  {
    packageName: 'com.tencent.mobileqq',
    appName: 'QQ',
    badge: 'Q',
    plugins: [
      p('qq_qzone', 'QQ 空间', 'social', ['QQ空间', '说说', '好友动态', '发表说说'], {
        pageTexts: ['QQ空间', 'QQ 空间'],
        anywhereTexts: ['发表说说'],
      }),
      p('qq_game', 'QQ 游戏', 'game', ['游戏中心', '开始游戏', 'QQ游戏'], {
        pageTexts: ['游戏中心', 'QQ游戏'],
      }),
      p('qq_live', '直播', 'entertainment', ['直播间', '正在直播', '进入直播间'], {
        pageTexts: ['直播'],
      }),
      p('qq_nearby', '附近', 'social', ['附近的人', '附近动态', '查看附近'], {
        pageTexts: ['附近'],
      }),
      p('qq_kandian', '看点', 'entertainment', ['看点', '推荐视频', '小世界']),
      p('qq_channel', '频道', 'entertainment', ['频道', '加入频道']),
      p('qq_group_file', '群文件', 'browsing', ['群文件', '上传文件', '下载文件']),
      p('qq_pay', 'QQ 钱包与支付', 'payment', ['QQ钱包', '收付款'], {
        pageTexts: ['QQ钱包'],
        anywhereTexts: ['确认支付', '余额'],
      }),
      p('qq_redpacket', '红包', 'payment', ['发红包', '拆红包'], {
        pageTexts: [],
        anywhereTexts: ['红包金额'],
      }),
      p('qq_addfriend', '加好友与扩列', 'social', ['加好友', '扩列', '查找好友', '可能认识的人'], {
        pageTexts: ['加好友', '添加好友'],
      }),
      p('qq_anonymous', '匿名与悄悄话', 'social', ['匿名提问', '悄悄话', '匿名聊天'], {
        pageTexts: [],
      }),
      p('qq_miniprogram', 'QQ 小程序', 'entertainment', ['小程序', '最近使用'], {
        pageTexts: ['小程序'],
      }),
    ],
  },
  {
    packageName: 'com.ss.android.ugc.aweme',
    appName: '抖音',
    badge: '抖',
    plugins: [
      p('dy_live', '直播与打赏', 'entertainment', ['直播间', '正在直播'], {
        pageTexts: ['直播'],
        anywhereTexts: ['送礼', '充值'],
      }),
      p('dy_shop', '商城与购物', 'payment', ['抖音商城', '去购买', '立即购买', '确认订单'], {
        pageTexts: ['抖音商城', '商城'],
        anywhereTexts: ['确认订单'],
      }),
      p('dy_wallet', '钱包与充值', 'payment', ['我的钱包'], {
        anywhereTexts: ['抖币'],
      }),
      p('dy_friend', '社交与私信', 'social', ['私信', '好友', '通讯录好友'], {
        pageTexts: ['消息', '私信'],
      }),
      p('dy_nearby', '同城与附近', 'social', ['同城', '附近', '本地'], {
        pageTexts: ['同城'],
      }),
      p('dy_search', '搜索', 'browsing', ['搜索', '猜你想搜'], {
        pageTexts: ['搜索'],
      }),
    ],
  },
  {
    packageName: '__appstore__',
    appName: '应用商店',
    badge: '店',
    plugins: [
      p('store_install', '安装新应用', 'install', ['安装', '下载并安装'], {
        pageTexts: [],
        anywhereTexts: ['正在安装'],
      }),
      p('store_update', '更新应用', 'install', ['全部更新', '更新'], {
        pageTexts: [],
        anywhereTexts: ['升级'],
      }),
      p('store_top', '排行榜与推荐', 'browsing', ['排行榜', '热门推荐', '编辑推荐'], {
        pageTexts: ['排行榜'],
      }),
      p('store_game', '游戏专区', 'game', ['游戏中心', '热门游戏', '游戏专区'], {
        pageTexts: ['游戏专区'],
      }),
      p('store_pay', '应用内购买', 'payment', ['立即购买'], {
        pageTexts: [],
        anywhereTexts: ['确认支付', '内购'],
      }),
      p('store_comment', '评论与社区', 'social', ['发表评论', '写评价', '社区'], {
        pageTexts: [],
      }),
    ],
  },
  {
    packageName: '__browser__',
    appName: '浏览器',
    badge: '览',
    plugins: [
      p('web_video', '在线视频', 'entertainment', ['播放', '高清', '全集'], {
        pageTexts: [],
        anywhereTexts: ['在线观看'],
      }),
      p('web_game', '网页游戏', 'game', ['开始游戏', '网页游戏', '小游戏'], {
        pageTexts: ['网页游戏'],
      }),
      p('web_shop', '购物下单', 'payment', ['立即购买', '加入购物车'], {
        pageTexts: [],
        anywhereTexts: ['提交订单', '确认支付'],
      }),
      p('web_social', '论坛与社交', 'social', ['发帖', '回帖', '评论', '注册登录'], {
        pageTexts: [],
      }),
      p('web_download', '文件下载', 'install', ['下载', '保存到本地'], {
        pageTexts: [],
        anywhereTexts: ['正在下载'],
      }),
      p('web_incognito', '无痕 / 隐私模式', 'privacy', ['无痕浏览', '隐私模式'], {
        pageTexts: ['无痕浏览'],
        anywhereTexts: ['清除记录'],
      }),
    ],
  },
];

/** 真实存在的包名 → 目录项。伪包名（__payment__ 等）也允许查，便于家长端统一处理。 */
const BY_PACKAGE = new Map(APP_PLUGIN_CATALOG.map((t) => [t.packageName, t]));

export function findPluginTarget(packageName: string): AppPluginTarget | undefined {
  return BY_PACKAGE.get(packageName);
}

export function findPlugin(packageName: string, pluginKey: string): AppPluginDef | undefined {
  return BY_PACKAGE.get(packageName)?.plugins.find((x) => x.key === pluginKey);
}

/** 目录里出现的全部插件键，形如 `com.tencent.mm:mm_moments`。用于校验家长端提交的键。 */
export function pluginKeyOf(packageName: string, pluginKey: string): string {
  return `${packageName}:${pluginKey}`;
}

export const ALL_PLUGIN_KEYS: ReadonlySet<string> = new Set(
  APP_PLUGIN_CATALOG.flatMap((t) => t.plugins.map((x) => pluginKeyOf(t.packageName, x.key))),
);

/**
 * 规则摘要，下发给设备端。
 *
 * 设备端只用得到「包名 + 插件键 + 是否允许 + 三组匹配文本 + 人话名字」，
 * 不需要分类标签，所以这里不把 `category` 发过去，省流量也少一份要同步的东西。
 *
 * <p>`keywords` 是 `entryTexts` 的**兼容镜像**：老版本 App 只认这一个字段，
 * 没有它老设备会直接把整条规则丢掉（插件管控静默失效，比拦错更难发现）。
 */
export interface PluginRulePayload {
  packageName: string;
  plugins: {
    key: string;
    enabled: boolean;
    label: string;
    entryTexts: string[];
    pageTexts: string[];
    anywhereTexts: string[];
    keywords: string[];
  }[];
}
