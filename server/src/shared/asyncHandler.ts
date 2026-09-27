import { RequestHandler, Request, Response, NextFunction } from 'express';

type AsyncFn = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;

/**
 * Express 4 不会自动捕获 async handler 里的 rejection，
 * 统一包一层把 rejection 转给 next(err)，交给全局 errorHandler。
 */
export const ah = (fn: AsyncFn): RequestHandler => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};
