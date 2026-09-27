import { Request, Response } from 'express';

export function notFound(req: Request, res: Response) {
  res.status(404).json({
    title: 'NOT_FOUND',
    status: 404,
    message: `接口不存在：${req.method} ${req.path}`,
    detail: null,
    errors: null,
    request_id: req.requestId,
  });
}
