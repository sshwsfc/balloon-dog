import { Request, Response, NextFunction } from 'express';
import { prisma } from '../prisma';
import { ForbiddenError, UnauthorizedError } from '../errors';
import { extractBearer, verifyToken } from '../shared/tokens';

/**
 * 家长端鉴权：校验 Bearer 令牌 → 确认主体是 user → 确认账号未被禁用。
 * 通过后把 req.auth 设为 { kind: 'user', id }。
 *
 * 注意：每个请求都会查一次用户状态（而不是只信任 JWT），
 * 这样家长被禁用后已签发的令牌会立即失效 —— mock 版那种「令牌即身份」的写法不要再用。
 */
export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  try {
    const payload = verifyToken(extractBearer(req));
    if (payload.kind !== 'user') {
      throw new UnauthorizedError('该接口仅家长账号可访问');
    }
    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, status: true },
    });
    if (!user) throw new UnauthorizedError('账号不存在');
    if (user.status === 'disabled') throw new UnauthorizedError('账号已被禁用，请联系管理员');

    req.auth = { kind: 'user', id: user.id };
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * 设备端鉴权：校验 Bearer 令牌 → 主体必须是 device → 设备存在且其所属家长未被禁用。
 * 通过后把 req.auth 设为 { kind: 'device', id: deviceId, userId }。
 */
export async function authenticateDevice(req: Request, _res: Response, next: NextFunction) {
  try {
    const payload = verifyToken(extractBearer(req));
    if (payload.kind !== 'device') {
      throw new UnauthorizedError('该接口仅设备端可访问');
    }
    const device = await prisma.childDevice.findUnique({
      where: { id: payload.sub },
      select: { id: true, userId: true, user: { select: { status: true } } },
    });
    if (!device) throw new UnauthorizedError('设备未注册或已被解绑');
    // 未认领的设备（user 为 null）仍可鉴权：它需要心跳/领指令来完成配对流程。
    // 只有「所属家长被禁用」才拒绝。
    if (device.user?.status === 'disabled') throw new UnauthorizedError('所属账号已被禁用');

    req.auth = { kind: 'device', id: device.id, userId: device.userId };
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * 管理后台鉴权：主体必须是 admin 令牌，且账号存在、未被禁用。
 * 通过后把 req.auth 设为 { kind: 'admin', id, username, role }。
 *
 * 与家长端鉴权是两条完全独立的通道：
 *  - 家长令牌调 /api/admin/* → 401（这里 kind 断言直接拒绝）
 *  - 管理员令牌调家长接口 → 401（authenticate 里同样是严格 kind 断言）
 * 因此后台账号被盗不会顺势拿到家长的数据权限，反之亦然。
 */
export async function authenticateAdmin(req: Request, _res: Response, next: NextFunction) {
  try {
    const payload = verifyToken(extractBearer(req));
    if (payload.kind !== 'admin') {
      throw new UnauthorizedError('该接口仅管理后台可访问');
    }
    // 每请求查库：管理员被禁用/删除后，已签发的令牌立即失效
    const admin = await prisma.admin.findUnique({
      where: { id: payload.sub },
      select: { id: true, username: true, role: true, status: true },
    });
    if (!admin) throw new UnauthorizedError('管理员账号不存在');
    if (admin.status === 'disabled') throw new UnauthorizedError('管理员账号已被禁用');

    req.auth = { kind: 'admin', id: admin.id, username: admin.username, role: admin.role };
    next();
  } catch (err) {
    next(err);
  }
}

/** 仅超级管理员可执行（如新建/删除管理员、重置他人密码）。需置于 authenticateAdmin 之后。 */
export function requireSuperAdmin(req: Request, _res: Response, next: NextFunction) {
  if (req.auth?.kind !== 'admin') {
    return next(new UnauthorizedError('该接口仅管理后台可访问'));
  }
  if (req.auth.role !== 'super') {
    return next(new ForbiddenError('需要超级管理员权限'));
  }
  next();
}

/** 取出当前管理员；非管理员主体直接 401。 */
export function currentAdmin(req: Request): { id: number; username: string; role: string } {
  if (req.auth?.kind !== 'admin') {
    throw new UnauthorizedError('该接口仅管理后台可访问');
  }
  return { id: req.auth.id, username: req.auth.username, role: req.auth.role };
}
