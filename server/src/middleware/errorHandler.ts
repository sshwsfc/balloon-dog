import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { AppError, ValidationError } from '../errors';
import { logger } from '../logger';

/** 从 unknown 里安全取字段的小工具（替代 any 断言）。 */
function field(obj: unknown, key: string): unknown {
  if (typeof obj === 'object' && obj !== null && key in obj) {
    return (obj as Record<string, unknown>)[key];
  }
  return undefined;
}

function errorMessage(err: unknown): string | undefined {
  if (err instanceof Error) return err.message;
  const msg = field(err, 'message');
  return typeof msg === 'string' ? msg : undefined;
}

function errorStack(err: unknown): string | undefined {
  if (err instanceof Error) return err.stack;
  const stack = field(err, 'stack');
  return typeof stack === 'string' ? stack : undefined;
}

/**
 * 全局错误处理器。统一错误体：
 * { title(错误码), status, message(可直接展示的中文短句), detail, errors(字段级，可选), request_id }
 *
 * - body-parser 的解析错误 → 400/413（客户端错误，不能落到 500）
 * - Prisma 已知错误码 → 409/404 的可读提示
 * - ZodError → 422，字段级明细展开到 errors
 * - AppError → 按其 statusCode 返回结构化响应
 * - 其余 → 记日志 + 笼统 500，绝不把堆栈或数据库细节返回给客户端
 *
 * 注意第 4 个参数 `_next` 必须保留：Express 靠「4 个形参」来识别错误处理中间件，
 * 少一个就会被当成普通中间件，错误就无法被收敛到这里。
 */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  const respond = (status: number, title: string, message: string, extra?: Partial<{
    detail: unknown;
    errors: { path: string; message: string }[] | null;
  }>) =>
    res.status(status).json({
      title,
      status,
      message,
      detail: extra?.detail ?? null,
      errors: extra?.errors ?? null,
      request_id: req.requestId,
    });

  // 客户端发来的请求体不是合法 JSON / 体积超限
  const type = field(err, 'type');
  if (type === 'entity.parse.failed' || (err instanceof SyntaxError && 'body' in err)) {
    return respond(400, 'BAD_REQUEST', '请求体不是合法的 JSON');
  }
  if (type === 'entity.too.large') {
    return respond(413, 'PAYLOAD_TOO_LARGE', '请求体过大');
  }

  // Prisma 已知错误码
  const prismaCode = field(err, 'code');
  if (prismaCode === 'P2002') {
    const target = field(err, 'meta');
    const fields = field(target, 'target');
    const label = Array.isArray(fields) ? fields.join('、') : '唯一字段';
    return respond(409, 'CONFLICT', `该${label}已存在`);
  }
  if (prismaCode === 'P2025') {
    return respond(404, 'NOT_FOUND', '记录不存在或已被删除');
  }

  if (err instanceof ZodError) {
    const ve = new ValidationError(
      err.errors.map((e) => ({ path: e.path.join('.'), message: e.message })),
    );
    const detail = ve.errors.length
      ? ve.errors.map((e) => (e.path ? `${e.path}: ${e.message}` : e.message)).join('；')
      : null;
    return respond(ve.statusCode, ve.code, ve.errors.length ? `提交内容有 ${ve.errors.length} 项未通过校验` : ve.message, {
      detail,
      errors: ve.errors,
    });
  }

  if (err instanceof AppError && err.isOperational) {
    return respond(err.statusCode, err.code, err.message, { detail: err.detail ?? null });
  }

  logger.error({
    msg: 'Unexpected error',
    err: errorMessage(err),
    stack: errorStack(err),
    request_id: req.requestId,
    path: req.path,
    method: req.method,
  });
  return respond(500, 'INTERNAL_ERROR', '服务器内部错误，请稍后重试');
}
