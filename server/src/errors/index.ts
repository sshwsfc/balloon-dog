/**
 * 类型化错误层级 —— 所有可预期的业务错误都从这里派生。
 * - 操作性错误(isOperational=true)：交回结构化响应给客户端
 * - 非操作性（编程错误）：记录日志并返回笼统 500，绝不暴露堆栈
 *
 * 前端约定：错误响应体的 `message` 一定是可直接展示给用户的中文短句，
 * `title` 是机器可判别的错误码，`detail` 是可选补充信息。
 */
export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number,
    public readonly isOperational = true,
    /** 可选的补充信息（随错误体返回给客户端）。 */
    public readonly detail?: unknown,
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = new.target.name;
  }
}

export class BadRequestError extends AppError {
  constructor(message = '请求参数错误') {
    super(message, 'BAD_REQUEST', 400);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = '未授权，请先登录') {
    super(message, 'UNAUTHORIZED', 401);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = '无权限执行此操作') {
    super(message, 'FORBIDDEN', 403);
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id?: string) {
    super(id ? `${resource}不存在：${id}` : `${resource}不存在`, 'NOT_FOUND', 404);
  }
}

export class ConflictError extends AppError {
  constructor(message = '资源冲突') {
    super(message, 'CONFLICT', 409);
  }
}

export class TooManyRequestsError extends AppError {
  constructor(message = '请求过于频繁，请稍后再试') {
    super(message, 'TOO_MANY_REQUESTS', 429);
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message = '服务暂时不可用，请稍后重试', code = 'SERVICE_UNAVAILABLE') {
    super(message, code, 503);
  }
}

export class ValidationError extends AppError {
  constructor(public readonly errors: { path: string; message: string }[]) {
    super('校验失败', 'VALIDATION_ERROR', 422);
  }
}
