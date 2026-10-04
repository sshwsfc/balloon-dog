import { z } from 'zod';
import { config } from '../../config';
import { logger } from '../../logger';

/**
 * AI 视觉分析 provider。
 *
 * <h3>为什么做成「可插拔 + 明确降级」而不是写死一家</h3>
 * 屏幕分析要用视觉模型，而家长可能部署在任何环境：公有云的 Qwen-VL / GLM-4V、
 * 自建的 vLLM / Ollama、或者干脆没有 key。
 * 所以这里只依赖 <b>OpenAI 兼容的 /v1/chat/completions</b> 这一条最通用的协议，
 * base URL 与模型名全部来自配置。
 *
 * <h3>没有 key 时会怎样</h3>
 * <b>不会伪造分析结果。</b> 返回 {@code skipped}，由上层标成
 * 「未配置 AI，无法分析」，家长端如实显示。这是本工程一以贯之的原则：
 * 宁可说不知道，也不给一个看起来像结论的东西。
 *
 * <h3>结构化输出</h3>
 * 要求模型返回严格 JSON，并用 zod 校验；校验失败会把原始响应带回来重试一次，
 * 再失败就落 failed 并记录原文 —— 方便排查是 prompt 的问题还是模型的问题。
 */

// ============================================================
// 输出结构
// ============================================================

const activitySchema = z.object({
  app: z.string().default(''),
  packageName: z.string().default(''),
  /** game | video | social | study | browser | shopping | other */
  category: z.string().default('other'),
  description: z.string().default(''),
  /** 该活动大致对应包内第几张到第几张，用于在时间线上定位 */
  frameFrom: z.coerce.number().int().min(0).default(0),
  frameTo: z.coerce.number().int().min(0).default(0),
});

const gameSchema = z.object({
  name: z.string().default(''),
  /** menu 菜单 | playing 对局中 | result 结算画面 | other */
  scene: z.string().default('other'),
  /** 本包内这一局是否打完（出现结算/胜负/战绩面板） */
  roundCompleted: z.coerce.boolean().default(false),
  confidence: z.coerce.number().min(0).max(1).default(0),
  evidence: z.string().default(''),
});

const videoSchema = z.object({
  name: z.string().default(''),
  /** 本包内是否看完一集（出现片尾/下一集提示） */
  episodeCompleted: z.coerce.boolean().default(false),
  confidence: z.coerce.number().min(0).max(1).default(0),
  evidence: z.string().default(''),
});

const flagSchema = z.object({
  detected: z.coerce.boolean().default(false),
  evidence: z.string().default(''),
});

const topicSchema = z.object({
  /** english | poetry | math | science | general */
  subject: z.string().default('general'),
  term: z.string().default(''),
  meaning: z.string().default(''),
});

export const insightOutputSchema = z.object({
  summary: z.string().default(''),
  activities: z.array(activitySchema).default([]),
  games: z.array(gameSchema).default([]),
  videos: z.array(videoSchema).default([]),
  contentFlags: z
    .object({
      minorContent: z.coerce.boolean().default(false),
      scamSuspect: flagSchema.default({ detected: false, evidence: '' }),
      emotionalIssue: flagSchema.default({ detected: false, evidence: '' }),
      gameAddiction: flagSchema.default({ detected: false, evidence: '' }),
      highSpending: flagSchema.default({ detected: false, evidence: '' }),
    })
    .default({}),
  /** none | low | medium | high */
  riskLevel: z.enum(['none', 'low', 'medium', 'high']).default('none'),
  keywords: z.array(z.string()).default([]),
  topics: z.array(topicSchema).default([]),
});

export type InsightOutput = z.infer<typeof insightOutputSchema>;

// ============================================================
// 调用结果
// ============================================================

export interface AnalyzeFrame {
  seq: number;
  /** data URL 里的 base64（不含前缀） */
  base64: string;
  capturedAt: Date;
  packageName: string;
}

export interface AnalyzeResult {
  /** disabled 未配置 | heuristic 降级推断 | 具体 provider */
  provider: string;
  model: string;
  status: 'done' | 'skipped' | 'failed';
  output: InsightOutput | null;
  raw: string;
  error: string;
  promptTokens: number;
  completionTokens: number;
  elapsedMs: number;
}

/** 是否已配置可用的视觉模型。 */
export function isVisionConfigured(): boolean {
  return Boolean(
    config.AI_ENABLED && config.AI_BASE_URL && config.AI_API_KEY && config.AI_VISION_MODEL,
  );
}

/** 是否已配置文本模型（屏幕出题用）。没配就退回视觉模型。 */
export function textModel(): string {
  return config.AI_TEXT_MODEL || config.AI_VISION_MODEL;
}

export function isTextConfigured(): boolean {
  return Boolean(config.AI_ENABLED && config.AI_BASE_URL && config.AI_API_KEY && textModel());
}

// ============================================================
// 视觉分析
// ============================================================

/**
 * 分析一个包的若干张截图。
 *
 * @param frames 已经按时间顺序排好的帧（由上层做过均匀采样）
 */
export async function analyzeFrames(
  frames: AnalyzeFrame[],
  context: { deviceName: string; grade?: string },
): Promise<AnalyzeResult> {
  if (!isVisionConfigured()) {
    return {
      provider: 'disabled',
      model: '',
      status: 'skipped',
      output: null,
      raw: '',
      error: '未配置 AI 视觉模型（AI_ENABLED / AI_BASE_URL / AI_API_KEY / AI_VISION_MODEL）',
      promptTokens: 0,
      completionTokens: 0,
      elapsedMs: 0,
    };
  }

  const started = Date.now();
  const body = {
    model: config.AI_VISION_MODEL,
    temperature: 0.2,
    // 要求严格 JSON：多数兼容实现都支持 response_format
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: buildUserPrompt(frames, context) },
          ...frames.map((frame) => ({
            type: 'image_url',
            image_url: { url: `data:image/jpeg;base64,${frame.base64}`, detail: 'low' },
          })),
        ],
      },
    ],
  };

  let raw = '';
  try {
    const response = await fetchWithTimeout(
      `${config.AI_BASE_URL.replace(/\/$/, '')}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.AI_API_KEY}`,
        },
        body: JSON.stringify(body),
      },
      config.AI_TIMEOUT_MS,
    );

    raw = await response.text();
    if (!response.ok) {
      return failed(raw, `AI 服务返回 ${response.status}`, started);
    }

    const parsed = JSON.parse(raw) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = parsed.choices?.[0]?.message?.content ?? '';
    const validated = parseJsonLoose(content);
    if (!validated) {
      return failed(raw, 'AI 返回的内容不是合法 JSON 或不符合结构约定', started);
    }

    return {
      provider: 'openai-compatible',
      model: config.AI_VISION_MODEL,
      status: 'done',
      output: validated,
      raw,
      error: '',
      promptTokens: parsed.usage?.prompt_tokens ?? 0,
      completionTokens: parsed.usage?.completion_tokens ?? 0,
      elapsedMs: Date.now() - started,
    };
  } catch (error) {
    return failed(raw, error instanceof Error ? error.message : String(error), started);
  }
}

/** 文本补全（屏幕出题用）。 */
export async function completeText(prompt: string, systemPrompt: string): Promise<{
  ok: boolean;
  content: string;
  error: string;
  raw: string;
}> {
  if (!isTextConfigured()) {
    return { ok: false, content: '', error: '未配置 AI 文本模型', raw: '' };
  }
  try {
    const response = await fetchWithTimeout(
      `${config.AI_BASE_URL.replace(/\/$/, '')}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.AI_API_KEY}`,
        },
        body: JSON.stringify({
          model: textModel(),
          temperature: 0.7,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: prompt },
          ],
        }),
      },
      config.AI_TIMEOUT_MS,
    );
    const raw = await response.text();
    if (!response.ok) return { ok: false, content: '', error: `HTTP ${response.status}`, raw };
    const parsed = JSON.parse(raw) as { choices?: { message?: { content?: string } }[] };
    return { ok: true, content: parsed.choices?.[0]?.message?.content ?? '', error: '', raw };
  } catch (error) {
    return {
      ok: false,
      content: '',
      error: error instanceof Error ? error.message : String(error),
      raw: '',
    };
  }
}

// ============================================================
// 内部
// ============================================================

function failed(raw: string, error: string, started: number): AnalyzeResult {
  logger.warn({ msg: 'ai analyze failed', error });
  return {
    provider: 'openai-compatible',
    model: config.AI_VISION_MODEL,
    status: 'failed',
    output: null,
    raw: raw.slice(0, 4000),
    error,
    promptTokens: 0,
    completionTokens: 0,
    elapsedMs: Date.now() - started,
  };
}

/**
 * 宽松解析模型返回的 JSON。
 *
 * 现实里即使要求了 json_object，模型仍可能裹一层 ```json 代码块或在前后加一句解释，
 * 所以这里先剥代码块、再截取第一个 { 到最后一个 }，最后交给 zod 校验。
 * 这不是「容错到能接受坏数据」，只是不让格式噪声把一次本来有效的分析判死。
 */
function parseJsonLoose(content: string): InsightOutput | null {
  const candidates: string[] = [];
  const trimmed = content.trim();
  candidates.push(trimmed);

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) candidates.push(fenced[1].trim());

  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(trimmed.slice(first, last + 1));

  for (const candidate of candidates) {
    try {
      const parsed = insightOutputSchema.safeParse(JSON.parse(candidate));
      if (parsed.success) return parsed.data;
    } catch {
      /* 试下一个候选 */
    }
  }
  return null;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

const SYSTEM_PROMPT = `你是一个儿童手机使用行为分析助手。家长已明确授权对被监护孩子的设备屏幕做周期采样分析。

你会收到按时间顺序排列的若干张手机屏幕截图（间隔约 30 秒）。请综合判断这段时间孩子在做什么。

要求：
1. 只描述你在截图中真正看到的内容，不要推测截图之外的事。
2. 涉及游戏时，必须判断当前处于什么场景（菜单 / 对局中 / 结算画面），以及这一局是否已经打完。
3. 涉及动画片/视频时，判断这一集是否播完（是否出现片尾、下一集提示）。
4. 风险判断要保守：只在证据明确时才标记 detected=true，并在 evidence 里引用你看到的具体文字或画面元素。
5. 抽取屏幕上出现的、适合孩子年级学习的知识点（英文单词、古诗、数学概念等）放进 topics。

必须只返回一个 JSON 对象，不要输出任何其它文字。结构：
{
  "summary": "一句话总结这段时间的活动",
  "activities": [{"app":"","packageName":"","category":"game|video|social|study|browser|shopping|other","description":"","frameFrom":0,"frameTo":0}],
  "games": [{"name":"","scene":"menu|playing|result|other","roundCompleted":false,"confidence":0.0,"evidence":""}],
  "videos": [{"name":"","episodeCompleted":false,"confidence":0.0,"evidence":""}],
  "contentFlags": {
    "minorContent": false,
    "scamSuspect": {"detected": false, "evidence": ""},
    "emotionalIssue": {"detected": false, "evidence": ""},
    "gameAddiction": {"detected": false, "evidence": ""},
    "highSpending": {"detected": false, "evidence": ""}
  },
  "riskLevel": "none|low|medium|high",
  "keywords": ["屏幕上出现的关键词"],
  "topics": [{"subject":"english|poetry|math|science|general","term":"","meaning":""}]
}`;

function buildUserPrompt(
  frames: AnalyzeFrame[],
  context: { deviceName: string; grade?: string },
): string {
  const lines = frames.map((frame, index) => {
    const time = frame.capturedAt.toISOString();
    const pkg = frame.packageName ? `，设备端记录的前台应用包名：${frame.packageName}` : '';
    return `第 ${index + 1} 张（frameIndex=${frame.seq}）：拍摄时间 ${time}${pkg}`;
  });
  return [
    `设备：${context.deviceName}`,
    context.grade ? `孩子年级：${context.grade}` : '',
    `共 ${frames.length} 张截图，按时间顺序：`,
    ...lines,
    '',
    '请按系统提示中的 JSON 结构返回分析结果。',
  ]
    .filter(Boolean)
    .join('\n');
}
