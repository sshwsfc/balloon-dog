import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';

/** 为每个请求分配/透传 requestId，写入响应头并挂到 req 上供日志串联。 */
export function requestId(req: Request, res: Response, next: NextFunction) {
  const id = (req.headers['x-request-id'] as string) || randomUUID();
  req.requestId = id;
  res.setHeader('X-Request-Id', id);
  next();
}
