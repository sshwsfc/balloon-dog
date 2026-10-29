#!/usr/bin/env node
/**
 * 生产环境的**唯一超管**初始化（不跑演示 seed）。
 *
 * 为什么不用 `prisma/seed.ts`：那个 seed 会建演示家长 `13800138000`、演示设备、演示孩子，
 * 线上跑一遍等于往真实库里灌测试数据。上线只需要一个能登录后台的账号，所以单独一个小脚本，
 * 只做一件事，且**幂等**：账号已存在就不覆盖密码（避免误把线上密码改回旧值），
 * 需要改密码时显式加 `--reset-password`。
 *
 * 用法（在 bdog-server 容器里跑，已带 DATABASE_URL）：
 *   docker exec -it bdog-server node scripts/bootstrap-admin.mjs \
 *     --username admin --password 'xxxx' --name 超级管理员
 *
 * 参数也可以用环境变量：BOOTSTRAP_ADMIN_USERNAME / BOOTSTRAP_ADMIN_PASSWORD / BOOTSTRAP_ADMIN_NAME
 */

import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';

const BCRYPT_ROUNDS = 10;

function arg(name, envName, fallback = '') {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  return process.env[envName] || fallback;
}

const username = arg('username', 'BOOTSTRAP_ADMIN_USERNAME', 'admin').trim();
const password = arg('password', 'BOOTSTRAP_ADMIN_PASSWORD', '');
const name = arg('name', 'BOOTSTRAP_ADMIN_NAME', '超级管理员');
const resetPassword = process.argv.includes('--reset-password');

if (!username) {
  console.error('✗ --username 不能为空');
  process.exit(1);
}
if (password.length < 8) {
  console.error('✗ --password 至少 8 位（后台是能看全站数据的入口，别用弱密码）');
  process.exit(1);
}

const prisma = new PrismaClient();

try {
  const existing = await prisma.admin.findUnique({ where: { username } });
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  if (existing) {
    if (!resetPassword) {
      console.log(`· 超管「${username}」已存在（role=${existing.role} status=${existing.status}），密码保持不变`);
      console.log('  需要强制重置密码请加 --reset-password');
      process.exit(0);
    }
    await prisma.admin.update({
      where: { username },
      data: { passwordHash, status: 'active' },
    });
    console.log(`✓ 已重置超管「${username}」的密码，并确保账号为 active`);
    process.exit(0);
  }

  await prisma.admin.create({
    data: { username, passwordHash, name, role: 'super', status: 'active' },
  });
  console.log(`✓ 已创建超管「${username}」（role=super，名称=${name}）`);
  console.log('  登录地址：/admin/login');
} catch (error) {
  console.error('✗ 初始化超管失败：', error instanceof Error ? error.message : error);
  process.exit(1);
} finally {
  await prisma.$disconnect();
}
