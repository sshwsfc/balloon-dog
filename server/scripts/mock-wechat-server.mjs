#!/usr/bin/env node
/**
 * 微信服务号的「假上游」——规划 §2.1 第二档（微信模板消息）的联调与回归工具。
 *
 * 为什么要有它：真实的模板消息要公众号 appid/secret、要家长真的关注、要一个能公网
 * 回调的域名，本地跑不了；而这条链路里**最容易写错的地方恰恰不是微信本身**，是
 * 「取令牌 → 发消息 → 令牌被提前判失效 → 丢掉缓存重取再发」的时序，以及模板字段名
 * 对不对。这两件事都能在本地完整验证，所以把它们做成一个没有依赖的假上游。
 *
 * 端点（与真微信同名）：
 *   GET  /cgi-bin/token?grant_type=client_credential&appid=..&secret=..
 *        每次调用发一个新令牌，旧的立刻作废 —— 真微信也是这样（新令牌会让旧令牌失效）。
 *   POST /cgi-bin/message/template/send?access_token=..
 *        令牌不对 → { errcode: 40001 }（触发服务端「重取再试」）；
 *        字段不合法 → { errcode: 47003 }（**严格模式默认开**：必须是
 *        first / keyword1 / keyword2 / remark 且 template_id 匹配，
 *        所以这个假上游同时是一份「模板字段约定」的契约测试）。
 *
 * 测试专用（前缀 __mock，不属于微信 API）：
 *   GET  /__mock/messages           看收到了哪些消息（含渲染后的标题/正文/跳转链接）
 *   POST /__mock/invalidate-token   让当前令牌立刻失效（测重取路径）
 *   POST /__mock/reset              清空消息与令牌计数
 *
 * 失败注入：任何字段的值里含 `__mock_fail__` → 回 47003。用来验证「发失败时
 * `lastError` 会留下微信的原文」，不需要改环境变量或重启。
 *
 * 用法：
 *   node server/scripts/mock-wechat-server.mjs            # 默认 :4100
 *   MOCK_WECHAT_PORT=4200 node server/scripts/mock-wechat-server.mjs
 */
import http from 'node:http';

const PORT = Number(process.env.MOCK_WECHAT_PORT || 4100);
const REQUIRED_FIELDS = ['first', 'keyword1', 'keyword2', 'remark'];

const state = {
  token: 'mock-wx-token-1',
  tokenSeq: 1,
  tokenFetches: 0,
  messages: [],
  /** 收到的原始请求体（排查字段名不对时最有用） */
  rawBodies: [],
};

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);

  if (url.pathname === '/cgi-bin/token') {
    state.tokenSeq += 1;
    state.tokenFetches += 1;
    state.token = `mock-wx-token-${state.tokenSeq}`;
    json(res, 200, { access_token: state.token, expires_in: 7200 });
    return;
  }

  if (url.pathname === '/cgi-bin/message/template/send') {
    const accessToken = url.searchParams.get('access_token') || '';
    const raw = await readBody(req);
    state.rawBodies.push(raw);
    if (accessToken !== state.token) {
      // 真微信的原文：invalid credential, access_token is invalid or not latest
      json(res, 200, { errcode: 40001, errmsg: 'invalid credential, access_token is invalid or not latest' });
      return;
    }
    let payload = {};
    try {
      payload = JSON.parse(raw);
    } catch {
      json(res, 200, { errcode: 47003, errmsg: 'argument invalid! data is not JSON' });
      return;
    }
    const data = payload.data || {};
    const values = Object.values(data).map((f) => String((f && f.value) || ''));
    if (values.some((v) => v.includes('__mock_fail__'))) {
      json(res, 200, { errcode: 47003, errmsg: 'argument invalid! data.keyword2.value invalid' });
      return;
    }
    const templateId = process.env.MOCK_WECHAT_TEMPLATE_ID || payload.template_id;
    if (!payload.touser || !payload.template_id || !templateId) {
      json(res, 200, { errcode: 40037, errmsg: 'invalid template_id' });
      return;
    }
    const missing = REQUIRED_FIELDS.filter((f) => !(f in data));
    if (missing.length > 0) {
      json(res, 200, {
        errcode: 47003,
        errmsg: `argument invalid! data.${missing[0]}.value invalid`,
      });
      return;
    }
    state.messages.push({
      to: payload.touser,
      templateId: payload.template_id,
      url: payload.url || '',
      first: String((data.first && data.first.value) || ''),
      keyword1: String((data.keyword1 && data.keyword1.value) || ''),
      keyword2: String((data.keyword2 && data.keyword2.value) || ''),
      remark: String((data.remark && data.remark.value) || ''),
      at: new Date().toISOString(),
    });
    json(res, 200, { errcode: 0, errmsg: 'ok', msgid: state.messages.length });
    return;
  }

  if (url.pathname === '/__mock/messages') {
    json(res, 200, { messages: state.messages, tokenFetches: state.tokenFetches, rawBodies: state.rawBodies });
    return;
  }

  if (url.pathname === '/__mock/invalidate-token') {
    state.token = `mock-wx-token-invalidated-${(state.tokenSeq += 1)}`;
    json(res, 200, { ok: true });
    return;
  }

  if (url.pathname === '/__mock/reset') {
    state.tokenFetches = 0;
    state.messages = [];
    state.rawBodies = [];
    json(res, 200, { ok: true });
    return;
  }

  json(res, 404, { errcode: 404, errmsg: `no such mock endpoint: ${url.pathname}` });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-wechat] listening on http://127.0.0.1:${PORT}`);
});
