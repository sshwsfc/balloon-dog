import { prisma } from '../../prisma';

/** 数据访问层：只做数据库读写，不掺业务逻辑。 */
export const authRepo = {
  findByPhone: (phone: string) => prisma.user.findUnique({ where: { phone } }),
  findByEmail: (email: string) => prisma.user.findUnique({ where: { email } }),
  findByWechatOpenid: (openid: string) =>
    prisma.user.findUnique({ where: { wechatOpenid: openid } }),
  findById: (id: number) => prisma.user.findUnique({ where: { id } }),

  create: (data: {
    phone?: string;
    email?: string;
    wechatOpenid?: string;
    passwordHash: string;
    nickname?: string;
    avatar?: string;
  }) => prisma.user.create({ data }),

  update: (id: number, data: Record<string, unknown>) =>
    prisma.user.update({ where: { id }, data }),
};
