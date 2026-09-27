import 'express';

declare global {
  namespace Express {
    interface Request {
      requestId?: string;
      /**
       * 访问主体。家长端令牌 → { kind: 'user', id }；
       * 设备端 Agent 令牌 → { kind: 'device', id: deviceId, userId }。
       */
      auth?:
        | { kind: 'user'; id: number }
        | { kind: 'device'; id: string; userId: number | null }
        /** 管理员主体（/api/admin 专用，与家长/设备令牌严格互斥） */
        | { kind: 'admin'; id: number; username: string; role: string };
    }
  }
}

export {};
