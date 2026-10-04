import type { AnalyzeFrame, AnalyzeResult, InsightOutput } from './ai.provider';

/**
 * 启发式降级分析器 —— <b>它不是 AI</b>。
 *
 * <h3>为什么要有它</h3>
 * 没有配置 AI key 的环境里，如果整条链路只到「上传成功、分析跳过」就断了，
 * 那么「设备端打包 → 服务端收包 → 出结论 → 家长端可见 → 超限锁屏」这条路
 * 就永远无法被端到端验证，也没法在没有 key 的机器上做开发。
 *
 * <h3>它凭什么下结论</h3>
 * 只靠两样东西，都是确定的：
 * <ol>
 *   <li><b>设备端上报的前台应用包名</b>（Agent 尽力采集，拿不到就为空）；</li>
 *   <li><b>帧的时间戳</b>，用来估算每段活动的时长。</li>
 * </ol>
 * 它<b>不</b>看图片内容：不解码、不做 OCR、不识别画面。
 * 因此它无法判断「有没有出现结算画面」「这一集有没有播完」——
 * 那两项会明确留空，而不是猜一个值出来。
 *
 * 结果里 {@code provider = 'heuristic'}，家长端会显示
 * 「启发式推断，非 AI 分析」，绝不与真实 AI 结论混在一起。
 */
export function analyzeHeuristically(frames: AnalyzeFrame[]): AnalyzeResult {
  const started = Date.now();
  if (frames.length === 0) {
    return {
      provider: 'heuristic',
      model: 'package-heuristic-v1',
      status: 'skipped',
      output: null,
      raw: '',
      error: '没有可用于推断的帧',
      promptTokens: 0,
      completionTokens: 0,
      elapsedMs: 0,
    };
  }

  const sorted = [...frames].sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime());

  // 按「连续同一个包」聚合成活动片段
  interface Segment {
    packageName: string;
    from: number;
    to: number;
    frames: number;
    startAt: Date;
    endAt: Date;
  }
  const segments: Segment[] = [];
  for (const frame of sorted) {
    const pkg = frame.packageName || '';
    const last = segments[segments.length - 1];
    if (last && last.packageName === pkg) {
      last.to = frame.seq;
      last.frames += 1;
      last.endAt = frame.capturedAt;
    } else {
      segments.push({
        packageName: pkg,
        from: frame.seq,
        to: frame.seq,
        frames: 1,
        startAt: frame.capturedAt,
        endAt: frame.capturedAt,
      });
    }
  }

  const activities = segments.map((segment) => {
    const app = appLabel(segment.packageName);
    // 一段的时长用「首末帧间隔 + 一个采样周期」估，避免单帧片段算成 0
    const spanMs =
      segment.frames > 1
        ? segment.endAt.getTime() - segment.startAt.getTime()
        : estimateSingleFrameSpanMs(sorted);
    const minutes = Math.max(1, Math.round(spanMs / 60_000));
    return {
      app,
      packageName: segment.packageName,
      category: categorize(segment.packageName),
      description: `${app}，约 ${minutes} 分钟（${segment.frames} 张连续截图）`,
      frameFrom: segment.from,
      frameTo: segment.to,
    };
  });

  const totalMinutes = Math.max(
    1,
    Math.round((sorted[sorted.length - 1].capturedAt.getTime() - sorted[0].capturedAt.getTime()) / 60_000),
  );

  const dominant = activities.slice().sort((a, b) => b.frameTo - b.frameFrom - (a.frameTo - a.frameFrom))[0];
  const summary = dominant
    ? `这段时间约 ${totalMinutes} 分钟，主要在「${dominant.app}」（${categoryLabel(dominant.category)}）`
    : `这段时间共 ${sorted.length} 张截图，未能识别前台应用`;

  const games = activities
    .filter((a) => a.category === 'game')
    .map((a) => ({
      name: a.app,
      scene: 'other' as const,
      // 启发式<b>无法</b>判断是否出现结算画面 —— 宁可留空也不猜
      roundCompleted: false,
      confidence: 0,
      evidence: '启发式分析无法判断游戏画面内容，局数需真实 AI 分析',
    }));

  const output: InsightOutput = {
    summary,
    activities,
    games,
    videos: [],
    contentFlags: {
      minorContent: false,
      scamSuspect: { detected: false, evidence: '' },
      emotionalIssue: { detected: false, evidence: '' },
      gameAddiction: { detected: false, evidence: '' },
      highSpending: { detected: false, evidence: '' },
    },
    riskLevel: 'none',
    keywords: [],
    topics: [],
  };

  return {
    provider: 'heuristic',
    model: 'package-heuristic-v1',
    status: 'done',
    output,
    raw: JSON.stringify({ note: '启发式推断，非 AI 分析', segments }),
    error: '',
    promptTokens: 0,
    completionTokens: 0,
    elapsedMs: Date.now() - started,
  };
}

/** 只有一帧时用采样间隔当跨度；拿不到就按 30 秒算。 */
function estimateSingleFrameSpanMs(frames: AnalyzeFrame[]): number {
  if (frames.length >= 2) {
    const gap = frames[1].capturedAt.getTime() - frames[0].capturedAt.getTime();
    if (gap > 0) return gap;
  }
  return 30_000;
}

/**
 * 包名 → 常用中文名。
 *
 * 只列常见的；认不出来的就显示包名本身（比显示「未知应用」有用得多）。
 */
const APP_LABELS: Record<string, string> = {
  'com.tencent.tmgp.sgame': '王者荣耀',
  'com.tencent.tmgp.pubgmhd': '和平精英',
  'com.tencent.mm': '微信',
  'com.tencent.mobileqq': 'QQ',
  'com.tencent.qqlive': '腾讯视频',
  'com.tencent.qqmusic': 'QQ音乐',
  'com.tencent.qqpim': 'QQ同步助手',
  'com.tencent.tmgp.dfm': '三角洲行动',
  'com.tencent.tmgp.cod': '使命召唤手游',
  'com.tencent.tmgp.yuanmeng': '元梦之星',
  'com.tencent.tmgp.qqspeed': 'QQ飞车手游',
  'com.tencent.ig': 'PUBG Mobile',
  'com.miHoYo.Yuanshen': '原神',
  'com.miHoYo.enterprise.NGHSoD': '崩坏3',
  'com.miHoYo.hkrpg': '崩坏：星穹铁道',
  'com.netease.mrzh': '明日之后',
  'com.netease.party': '蛋仔派对',
  'com.netease.dwrg': '第五人格',
  'com.netease.hyxd': '荒野行动',
  'com.netease.onmyoji': '阴阳师',
  'com.taobao.taobao': '淘宝',
  'com.jingdong.app.mall': '京东',
  'com.xunmeng.pinduoduo': '拼多多',
  'com.eg.android.AlipayGphone': '支付宝',
  'com.tencent.tmgp.wefly': '微信小游戏',
  'tv.danmaku.bili': '哔哩哔哩',
  'com.youku.phone': '优酷',
  'com.qiyi.video': '爱奇艺',
  'com.ss.android.ugc.aweme': '抖音',
  'com.ss.android.article.news': '今日头条',
  'com.smile.gifmaker': '快手',
  'com.xingin.xhs': '小红书',
  'com.zhihu.android': '知乎',
  'com.instagram.android': 'Instagram',
  'com.google.android.youtube': 'YouTube',
  'com.google.android.apps.youtube.kids': 'YouTube Kids',
  'com.netflix.mediaclient': 'Netflix',
  'com.duolingo': '多邻国',
  'com.google.android.apps.docs.editors.docs': 'Google 文档',
  'com.android.chrome': 'Chrome',
  'com.UCMobile': 'UC浏览器',
  'com.baidu.searchbox': '百度',
  'com.microsoft.office.word': 'Word',
  'com.xueersi.parentsapp': '学而思',
  'com.zuoyebang.airclass': '作业帮',
  'com.yuanfudao.android': '猿辅导',
  'com.tencent.edu.pad': '腾讯课堂',
  'com.tencent.mtt': 'QQ浏览器',
  'com.android.settings': '系统设置',
  'com.google.android.apps.nexuslauncher': '桌面',
  'com.android.systemui': '系统界面',
};

/** 包名 → 类别。用于时长统计与「有没有在打游戏」的判断。 */
const CATEGORY_RULES: { match: RegExp; category: string }[] = [
  { match: /tmgp|(\.|^)ig$|game|miHoYo|netease\.(party|dwrg|hyxd|onmyoji|mrzh)|supercell|kingdom|epicgames/i, category: 'game' },
  { match: /youtube|bili|youku|qiyi|qqlive|netflix|video|mgtv|sohu|le\.|kids/i, category: 'video' },
  { match: /tencent\.mm|mobileqq|whatsapp|telegram|snapchat|instagram|weibo|facebook|messenger|discord|dingtalk|feishu|lark/i, category: 'social' },
  { match: /zuoyebang|yuanfudao|xueersi|edu|duolingo|study|classin|khan/i, category: 'study' },
  { match: /chrome|browser|mtt|UCMobile|baidu\.searchbox|firefox/i, category: 'browser' },
  { match: /taobao|jingdong|pinduoduo|Alipay|shop|amazon|ebay|meituan|dianping/i, category: 'shopping' },
];

export function categorize(packageName: string): string {
  if (!packageName) return 'other';
  for (const rule of CATEGORY_RULES) {
    if (rule.match.test(packageName)) return rule.category;
  }
  return 'other';
}

export function appLabel(packageName: string): string {
  if (!packageName) return '未知应用（设备端未上报前台包名）';
  return APP_LABELS[packageName] ?? packageName;
}

export function categoryLabel(category: string): string {
  switch (category) {
    case 'game':
      return '游戏';
    case 'video':
      return '视频';
    case 'social':
      return '社交';
    case 'study':
      return '学习';
    case 'browser':
      return '浏览器';
    case 'shopping':
      return '购物';
    default:
      return '其它';
  }
}
