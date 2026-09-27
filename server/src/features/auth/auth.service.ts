import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import type { User } from '@prisma/client';
import { authRepo } from './auth.repository';
import { sendVerificationCode, verifyCode, type SmsPurpose } from './auth.sms';
import * as wechat from './auth.wechat';
import { signUserToken } from '../../shared/tokens';
import { BadRequestError, ConflictError, NotFoundError, UnauthorizedError } from '../../errors';
import { logger } from '../../logger';

const BCRYPT_ROUNDS = 10;

/** 对外的用户视图：绝不包含 passwordHash。同时给出 name 与 nickname 两个别名。 */
export interface PublicUser {
  id: number;
  name: string;
  nickname: string;
  phone: string | null;
  email: string | null;
  avatar: string;
  wechatBound: boolean;
  createdAt: Date;
}

function toPublic(u: User): PublicUser {
  return {
    id: u.id,
    name: u.nickname,
    nickname: u.nickname,
    phone: u.phone,
    email: u.email,
    avatar: u.avatar,
    wechatBound: Boolean(u.wechatOpenid),
    createdAt: u.createdAt,
  };
}

/** 手机号注册默认昵称：手机用户 + 后 4 位。 */
function phoneNickname(phone: string): string {
  return `家长用户${phone.slice(-4)}`;
}

/** 生成一个稳定的默认头像（DiceBear，无需自建图床）。 */
function defaultAvatar(seed: string): string {
  return `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(seed)}`;
}

/** 已禁用账号拒绝登录。 */
function assertUserActive(u: Pick<User, 'status'>): void {
  if (u.status === 'disabled') {
    throw new UnauthorizedError('账号已被禁用，请联系客服');
  }
}

/** 给验证码/微信这种「无密码注册」的账号生成随机密码占位，保证 passwordHash 非空且不可猜。 */
async function randomPasswordHash(): Promise<string> {
  return bcrypt.hash(crypto.randomBytes(24).toString('hex'), BCRYPT_ROUNDS);
}

export const authService = {
  /**
   * 发送短信验证码。
   * 注册用途会先检查手机号未被占用，避免白跑一趟、也避免给已注册用户发码。
   */
  async sendCode(phone: string, purpose: SmsPurpose) {
    if (purpose === 'register') {
      const existing = await authRepo.findByPhone(phone);
      if (existing) throw new ConflictError('该手机号已注册，请直接登录');
    }
    if (purpose === 'login') {
      const existing = await authRepo.findByPhone(phone);
      if (!existing) throw new NotFoundError('该手机号尚未注册', phone);
    }
    return sendVerificationCode(phone, purpose);
  },

  /** 注册：查重 → 校验验证码（消费）→ 落库 → 签发令牌。 */
  async register(phone: string, password: string, code: string, nickname?: string): Promise<{
    token: string;
    user: PublicUser;
  }> {
    const existing = await authRepo.findByPhone(phone);
    if (existing) throw new ConflictError('该手机号已注册，请直接登录');

    // 先校验验证码：通过即消费，避免出现「码用掉了但账号没建成」的重复提交歧义
    await verifyCode(phone, 'register', code);

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const user = await authRepo.create({
      phone,
      passwordHash,
      nickname: nickname?.trim() || phoneNickname(phone),
      avatar: defaultAvatar(phone),
    });

    logger.info({ msg: 'user registered', userId: user.id, phone });
    return { token: signUserToken(user.id), user: toPublic(user) };
  },

  /** 密码登录：手机号或邮箱均可。密码比对失败与账号不存在返回同一句提示，避免账号枚举。 */
  async login(identifier: string, password: string): Promise<{ token: string; user: PublicUser }> {
    const user = (await authRepo.findByPhone(identifier)) ?? (await authRepo.findByEmail(identifier));
    if (!user) {
      // 没有该账号也做一次哈希比对，抹平「账号不存在」与「密码错误」的响应时间差
      await bcrypt.compare(password, '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv');
      throw new UnauthorizedError('手机号或密码错误');
    }
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) throw new UnauthorizedError('手机号或密码错误');
    assertUserActive(user);

    return { token: signUserToken(user.id), user: toPublic(user) };
  },

  /** 验证码登录：验证码正确 → 按手机号查/建用户（首次自动注册）。 */
  async smsLogin(phone: string, code: string): Promise<{ token: string; user: PublicUser; isNew: boolean }> {
    await verifyCode(phone, 'login', code);
    let user = await authRepo.findByPhone(phone);
    let isNew = false;
    if (!user) {
      user = await authRepo.create({
        phone,
        passwordHash: await randomPasswordHash(),
        nickname: phoneNickname(phone),
        avatar: defaultAvatar(phone),
      });
      isNew = true;
      logger.info({ msg: 'user auto-registered via sms login', userId: user.id, phone });
    }
    assertUserActive(user);
    return { token: signUserToken(user.id), user: toPublic(user), isNew };
  },

  // ---------------- 微信扫码登录 ----------------

  createWechatQr() {
    return wechat.createQr();
  },

  queryWechatState(state: string) {
    return wechat.queryState(state);
  },

  /** 微信内置浏览器：直接拿授权跳转链接。 */
  wechatAuthorizeUrl(redirectAfter: string): { url: string } {
    const { state } = wechat.createQr();
    return { url: wechat.buildOAuthUrl(state, redirectAfter) };
  },

  /** 本地联调：模拟扫码授权（未配置真实微信时才允许）。 */
  async devWechatScan(state: string): Promise<void> {
    wechat.assertMockScanAllowed();
    wechat.assertSessionExists(state);
    await this.loginByWechatOpenid(state, wechat.mockOpenidFor(state));
  },

  /** 真实回调：code → openid → 登录，返回 token 供前端落地。 */
  async wechatCallback(rawState: string, code: string): Promise<{ token: string; redirectAfter: string }> {
    const { state, redirectAfter } = wechat.splitState(rawState);
    const { openid } = await wechat.exchangeCodeForOpenid(code);
    const token = await this.loginByWechatOpenid(state, openid);
    return { token, redirectAfter };
  },

  /** 按 openid 查/建用户并签发令牌，同时写回扫码会话。 */
  async loginByWechatOpenid(state: string, openid: string): Promise<string> {
    let user = await authRepo.findByWechatOpenid(openid);
    if (!user) {
      user = await authRepo.create({
        wechatOpenid: openid,
        passwordHash: await randomPasswordHash(),
        nickname: `微信用户${crypto.randomInt(0, 10_000).toString().padStart(4, '0')}`,
        avatar: defaultAvatar(openid),
      });
      logger.info({ msg: 'user registered via wechat', userId: user.id });
    }
    assertUserActive(user);
    const token = signUserToken(user.id);
    wechat.completeScan(state, token, toPublic(user));
    return token;
  },

  // ---------------- 资料 ----------------

  async getProfile(userId: number): Promise<PublicUser> {
    const user = await authRepo.findById(userId);
    if (!user) throw new NotFoundError('用户');
    return toPublic(user);
  },

  async updateProfile(
    userId: number,
    data: { name?: string; nickname?: string; email?: string; avatar?: string },
  ): Promise<PublicUser> {
    const patch: Record<string, unknown> = {};
    const nickname = data.nickname ?? data.name;
    if (nickname !== undefined) patch.nickname = nickname;
    if (data.avatar !== undefined) patch.avatar = data.avatar;
    if (data.email !== undefined) {
      const email = data.email.trim();
      if (email) {
        const occupied = await authRepo.findByEmail(email);
        if (occupied && occupied.id !== userId) throw new ConflictError('该邮箱已被其他账号使用');
        patch.email = email;
      } else {
        patch.email = null; // 传空串表示清空
      }
    }
    if (Object.keys(patch).length === 0) {
      throw new BadRequestError('没有需要更新的字段');
    }
    const user = await authRepo.update(userId, patch);
    return toPublic(user);
  },

  async changePassword(userId: number, oldPassword: string, newPassword: string): Promise<{ success: true }> {
    const user = await authRepo.findById(userId);
    if (!user) throw new NotFoundError('用户');
    const ok = await bcrypt.compare(oldPassword, user.passwordHash);
    if (!ok) throw new UnauthorizedError('原密码错误');
    if (oldPassword === newPassword) throw new BadRequestError('新密码与原密码相同');
    await authRepo.update(userId, { passwordHash: await bcrypt.hash(newPassword, BCRYPT_ROUNDS) });
    logger.info({ msg: 'password changed', userId });
    return { success: true };
  },

  /** 绑定/换绑手机号：验证码校验 + 占用检查。 */
  async bindPhone(userId: number, phone: string, code: string): Promise<PublicUser> {
    await verifyCode(phone, 'bind', code);
    const occupied = await authRepo.findByPhone(phone);
    if (occupied && occupied.id !== userId) throw new ConflictError('该手机号已绑定其他账号');
    const user = await authRepo.update(userId, { phone });
    return toPublic(user);
  },
};
