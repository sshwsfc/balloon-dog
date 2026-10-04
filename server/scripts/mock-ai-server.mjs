#!/usr/bin/env node
/**
 * 本地 mock 的 OpenAI 兼容视觉分析服务。
 *
 * 用途：在没有真实 AI key 的环境里，验证服务端的 **AI 代码路径**——
 * 请求体是否按多模态格式构造、返回的 JSON 是否被正确解析与校验、
 * 局数/集数是否落成可计数的事实、异常提醒是否生成、预算超限是否真的下发锁屏。
 *
 * 启发式降级器<b>无法</b>覆盖这些：它按设计就不判断画面内容。
 * 没有这个 mock，AI 路径就只能靠「读代码相信它」。
 *
 * 用法：
 *   node scripts/mock-ai-server.mjs [port]
 * 然后让后端指向它：
 *   AI_ENABLED=true AI_BASE_URL=http://127.0.0.1:4100/v1 AI_API_KEY=mock AI_VISION_MODEL=mock-vl
 *
 * 它同时也是一个真实模型的 <b>协议对照</b>：返回体严格按 OpenAI 的
 * /v1/chat/completions 形状，包括 choices[0].message.content 与 usage。
 */
import { createServer } from 'node:http'

const port = Number(process.argv[2] || 4100)

/** 每次请求返回的剧本，可由环境变量覆盖，方便测不同场景。 */
function scriptedInsight() {
  const scenario = process.env.MOCK_AI_SCENARIO || 'game_result'
  if (scenario === 'risk') {
    return {
      summary: '这段时间在一个陌生聊天界面，对方要求孩子提供验证码并转账',
      activities: [
        { app: '微信', packageName: 'com.tencent.mm', category: 'social', description: '与陌生人聊天', frameFrom: 0, frameTo: 9 },
      ],
      games: [],
      videos: [],
      contentFlags: {
        minorContent: false,
        scamSuspect: { detected: true, evidence: '对方发送「把你的验证码发我」并要求转账 2000 元' },
        emotionalIssue: { detected: false, evidence: '' },
        gameAddiction: { detected: false, evidence: '' },
        highSpending: { detected: true, evidence: '界面出现 2000 元转账确认' },
      },
      riskLevel: 'high',
      keywords: ['验证码', '转账'],
      topics: [],
    }
  }
  return {
    summary: '这段时间在玩《王者荣耀》，屏幕显示对局结算界面，出现「胜利」与战绩面板',
    activities: [
      { app: '王者荣耀', packageName: 'com.tencent.tmgp.sgame', category: 'game', description: '进行对局并打完一局', frameFrom: 0, frameTo: 9 },
    ],
    games: [
      { name: '王者荣耀', scene: 'result', roundCompleted: true, confidence: 0.92, evidence: '屏幕中央出现「胜利」字样与战绩面板' },
    ],
    videos: [],
    contentFlags: {
      minorContent: false,
      scamSuspect: { detected: false, evidence: '' },
      emotionalIssue: { detected: false, evidence: '' },
      gameAddiction: { detected: true, evidence: '连续多局未中断，单次时长超过 40 分钟' },
      highSpending: { detected: false, evidence: '' },
    },
    riskLevel: 'medium',
    keywords: ['胜利', 'victory', '王者荣耀'],
    topics: [{ subject: 'english', term: 'victory', meaning: '胜利' }],
  }
}

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url?.startsWith('/v1/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'mock-vl' }, { id: 'mock-text' }] }))
    return
  }

  if (req.method !== 'POST' || !req.url?.includes('/chat/completions')) {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'not found' } }))
    return
  }

  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8')
    let parsed = {}
    try { parsed = JSON.parse(body) } catch { /* 保底 */ }

    // 记录请求形状，供测试断言「服务端确实按多模态格式发了图」
    const message = parsed.messages?.[1]
    const imageParts = Array.isArray(message?.content)
      ? message.content.filter((p) => p.type === 'image_url')
      : []
    process.stdout.write(
      `[mock-ai] model=${parsed.model} images=${imageParts.length} ` +
      `response_format=${parsed.response_format?.type ?? 'none'}\n`,
    )

    const isTextOnly = Array.isArray(message?.content)
      ? imageParts.length === 0
      : true

    const content = isTextOnly && parsed.response_format?.type === 'json_object' && process.env.MOCK_AI_QUIZ === '1'
      // 出题请求（无图）：返回一道与屏幕内容相关的题
      ? JSON.stringify({
          subject: 'english',
          question: '刚才屏幕上出现了「victory」，它的意思是？',
          options: ['胜利', '失败', '开始', '暂停'],
          correctAnswer: 0,
          explanation: 'victory = 胜利',
          sourceTerm: 'victory',
        })
      : JSON.stringify(scriptedInsight())

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      id: 'chatcmpl-mock',
      object: 'chat.completion',
      model: parsed.model || 'mock-vl',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1234, completion_tokens: 321, total_tokens: 1555 },
    }))
  })
})

server.listen(port, '127.0.0.1', () => {
  console.log(`[mock-ai] listening on http://127.0.0.1:${port}/v1 (scenario=${process.env.MOCK_AI_SCENARIO || 'game_result'})`)
})
