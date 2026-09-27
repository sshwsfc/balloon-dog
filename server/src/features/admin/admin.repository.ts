import bcrypt from 'bcryptjs';
import { prisma } from '../../prisma';

const BCRYPT_ROUNDS = 10;

/** 管理员账号仓储（与家长账号完全隔离，独立表）。 */
export const adminRepo = {
  findByUsername: (username: string) => prisma.admin.findUnique({ where: { username } }),
  findById: (id: number) => prisma.admin.findUnique({ where: { id } }),

  list: () =>
    prisma.admin.findMany({
      select: {
        id: true,
        username: true,
        name: true,
        role: true,
        status: true,
        lastLoginAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    }),

  countByRole: (role: string, extra?: { status?: string; excludeId?: number }) =>
    prisma.admin.count({
      where: {
        role,
        ...(extra?.status ? { status: extra.status } : {}),
        ...(extra?.excludeId ? { id: { not: extra.excludeId } } : {}),
      },
    }),

  create: async (input: { username: string; password: string; name?: string; role: string }) =>
    prisma.admin.create({
      data: {
        username: input.username,
        passwordHash: await bcrypt.hash(input.password, BCRYPT_ROUNDS),
        name: input.name?.trim() || '管理员',
        role: input.role,
      },
      select: { id: true, username: true, name: true, role: true, status: true, createdAt: true },
    }),

  updatePassword: async (id: number, password: string) =>
    prisma.admin.update({
      where: { id },
      data: { passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS) },
    }),

  setStatus: (id: number, status: string) =>
    prisma.admin.update({ where: { id }, data: { status } }),

  touchLogin: (id: number) =>
    prisma.admin.update({ where: { id }, data: { lastLoginAt: new Date() } }),

  remove: (id: number) => prisma.admin.delete({ where: { id } }),

  verify: (hash: string, password: string) => bcrypt.compare(password, hash),

  /** 与家长账号同款的「有效密码哈希」占位比较，用于抹平账号不存在时的响应时间差。 */
  dummyCompare: (password: string) =>
    bcrypt.compare(password, '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv'),
};
