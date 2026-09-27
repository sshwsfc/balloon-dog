import jwt from 'jsonwebtoken';
import { config } from '../config';
import { UnauthorizedError } from '../errors';

/** 家长端令牌载荷。`kind` 用于区分主体，避免设备令牌被当成家长令牌使用。 */
export interface UserTokenPayload {
  kind: 'user';
  sub: number;
}

/** 设备端 Agent 令牌载荷。`userId` 冗余 owner（未认领的设备为 null）。 */
export interface DeviceTokenPayload {
  kind: 'device';
  sub: string; // deviceId
  userId: number | null;
}

/**
 * 管理员令牌载荷。
 * 与家长令牌共用 JWT_SECRET，但 `kind` 不同 —— 家长令牌无法访问 /api/admin，
 * 管理员令牌也无法访问家长接口（见 middleware/auth.ts 的严格 kind 断言）。
 */
export interface AdminTokenPayload {
  kind: 'admin';
  sub: number; // adminId
  username: string;
  role: string;
}

/** 三种主体：家长 / 设备 / 管理员。 */
export type AnyTokenPayload = UserTokenPayload | DeviceTokenPayload | AdminTokenPayload;

export function signUserToken(userId: number): string {
  return jwt.sign({ kind: 'user' }, config.JWT_SECRET, {
    subject: String(userId),
    expiresIn: config.ACCESS_TOKEN_TTL as jwt.SignOptions['expiresIn'],
  });
}

export function signDeviceToken(deviceId: string, userId: number | null): string {
  return jwt.sign({ kind: 'device', userId }, config.JWT_SECRET, {
    subject: deviceId,
    expiresIn: config.DEVICE_TOKEN_TTL as jwt.SignOptions['expiresIn'],
  });
}

/** 管理员令牌有效期独立于家长令牌（后台会话更短，减少泄露窗口）。 */
export function signAdminToken(admin: { id: number; username: string; role: string }): string {
  return jwt.sign({ kind: 'admin', username: admin.username, role: admin.role }, config.JWT_SECRET, {
    subject: String(admin.id),
    expiresIn: config.ADMIN_TOKEN_TTL as jwt.SignOptions['expiresIn'],
  });
}

/** 校验并解析令牌；失败一律抛 401（不区分「过期」和「伪造」，避免给攻击者信息）。 */
export function verifyToken(token: string): AnyTokenPayload {
  let payload: jwt.JwtPayload;
  try {
    payload = jwt.verify(token, config.JWT_SECRET) as jwt.JwtPayload;
  } catch {
    throw new UnauthorizedError('登录状态已失效，请重新登录');
  }
  if (!payload.sub) throw new UnauthorizedError('登录状态已失效，请重新登录');

  if (payload.kind === 'device') {
    const userId = payload.userId;
    if (userId !== null && typeof userId !== 'number') {
      throw new UnauthorizedError('设备令牌无效');
    }
    return { kind: 'device', sub: payload.sub, userId: userId ?? null };
  }

  if (payload.kind === 'admin') {
    const adminId = Number(payload.sub);
    if (!Number.isInteger(adminId) || adminId <= 0) {
      throw new UnauthorizedError('管理员令牌无效');
    }
    return {
      kind: 'admin',
      sub: adminId,
      username: typeof payload.username === 'string' ? payload.username : '',
      role: typeof payload.role === 'string' ? payload.role : 'operator',
    };
  }

  const userId = Number(payload.sub);
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new UnauthorizedError('登录状态已失效，请重新登录');
  }
  return { kind: 'user', sub: userId };
}

/** 从 Authorization 头里取出 Bearer 令牌；没有则抛 401。 */
export function extractBearer(req: { headers: Record<string, unknown> }): string {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
    throw new UnauthorizedError('缺少访问令牌');
  }
  return header.slice(7).trim();
}
