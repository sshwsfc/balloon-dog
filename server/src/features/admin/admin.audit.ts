import { Request, Response, NextFunction } from 'express';
import { prisma } from '../../prisma';
import { logger } from '../../logger';

/**
 * 管理后台操作审计。
 *
 * 每一次 /api/admin 请求（含登录失败的尝试）都会在响应完成后异步写入 OperationLog：
 * 操作人、操作描述、方法、路径、状态码、脱敏后的请求参数、IP。
 *
 * 两条原则：
 *  1. **写日志失败绝不影响业务响应** —— fire-and-forget，异常只记 logger；
 *  2. **密码类字段先脱敏再落库** —— 审计表本身不能成为凭据泄露源。
 */

/** 需要脱敏的字段名（大小写不敏感）。 */
const SENSITIVE_KEY = /password|secret|token|authorization|openid|hash/i;

function sanitize(value: unknown, depth = 0): unknown {
  // 防御深层嵌套导致的栈溢出/超大对象
  if (depth > 6) return '[deep]';
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitize(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? '***' : sanitize(v, depth + 1);
    }
    return out;
  }
  // 超长字符串截断，避免把整个题干塞进日志
  if (typeof value === 'string' && value.length > 300) return `${value.slice(0, 300)}…`;
  return value;
}

/** 把「方法 + 路径」归纳成人类可读的操作描述。 */
export function describeAction(method: string, originalUrl: string): string {
  const path = originalUrl.replace(/^\/api\/admin/, '').split('?')[0] || '/';
  const segs = path.split('/').filter(Boolean);
  const resource = segs[0] ?? '';
  const sub = segs[2] ?? '';

  // 无资源段的基础接口
  if (path === '/login') return '管理员登录';
  if (path === '/profile') return '查看当前管理员';
  if (path === '/password') return '修改自己的密码';
  if (path === '/stats') return '查看数据看板';

  switch (resource) {
    case 'logs':
      return '查看操作日志';

    case 'users':
      if (sub === 'status') return '修改家长账号状态';
      if (method === 'DELETE') return '删除家长账号';
      if (method === 'GET') return segs.length > 1 ? '查看家长账号详情' : '查看家长账号列表';
      return '家长账号操作';

    case 'devices':
      if (sub === 'unbind') return '强制解绑设备';
      if (method === 'DELETE') return '删除设备';
      if (method === 'GET') return segs.length > 1 ? '查看设备详情' : '查看设备列表';
      return '设备操作';

    case 'commands':
      if (sub === 'cancel') return '撤销设备指令';
      return '查看指令记录';

    case 'questions':
      if (method === 'POST') return '新增题目';
      if (method === 'PATCH' || method === 'PUT') return '修改题目';
      if (method === 'DELETE') return '删除题目';
      return '查看题库';

    case 'quiz-records':
      return '查看答题记录';

    case 'sms-codes':
      if (sub === 'purge' || method === 'POST') return '清理历史验证码';
      return '查看验证码发送记录';

    case 'admins':
      if (sub === 'password') return '重置管理员密码';
      if (sub === 'status') return '修改管理员状态';
      if (method === 'POST') return '新建管理员';
      if (method === 'DELETE') return '删除管理员';
      return '查看管理员列表';

    default:
      return `${method} ${path}`;
  }
}

export function adminAudit(req: Request, res: Response, next: NextFunction) {
  res.on('finish', () => {
    try {
      const path = req.originalUrl || req.path;
      // 登录失败的请求还没有 req.auth，此时从请求体里取账号名，保证「谁在尝试登录」有迹可循
      const body = (req.body ?? {}) as Record<string, unknown>;
      const adminId = req.auth?.kind === 'admin' ? req.auth.id : null;
      const adminName =
        req.auth?.kind === 'admin' ? req.auth.username : typeof body.username === 'string' ? body.username : '';

      const detail = JSON.stringify({
        body: sanitize(body),
        params: sanitize(req.params),
        query: sanitize(req.query),
      });

      void prisma.operationLog
        .create({
          data: {
            adminId,
            adminName: adminName.slice(0, 64),
            action: describeAction(req.method, path).slice(0, 128),
            method: req.method,
            path: path.slice(0, 255),
            status: res.statusCode,
            detail: detail.slice(0, 4000),
            ip: req.ip ?? null,
          },
        })
        .catch((err: unknown) => {
          // 审计写入失败不能影响业务响应，但要留痕以便排查
          logger.warn({ msg: 'operation log write failed', error: (err as Error)?.message });
        });
    } catch (err) {
      logger.warn({ msg: 'adminAudit failed', error: (err as Error)?.message });
    }
  });
  next();
}
