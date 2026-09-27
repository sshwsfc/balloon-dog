/**
 * 清理测试期间产生的临时数据。
 *
 * `npm run smoke`（冒烟测试）会真实写入一批临时账号与设备（家长昵称以
 * 「隔离测试B」「后台处置测试」开头，设备码形如 SMOKE123 / OPTEST1234）。
 * 反复运行后后台列表里会堆一排垃圾，这个脚本把它们清掉，让演示数据保持干净。
 *
 * 运行（用 tsx，与 seed 一致 —— 项目是 CJS 包，Node 原生类型擦除读不了这些模块）：
 *   npm run db:clean                 # 预演，只打印会删什么
 *   npm run db:clean -- --apply      # 真正删除（从 server/ 目录跑时用 npm run clean:test-data）
 *
 * 也支持环境变量 APPLY=1：`npm run db:clean` 经由 `npm --prefix` 转发时，
 * 附加参数会被 npm 自己消费掉而不传给内层脚本，用环境变量可以绕开这个坑。
 *
 * 只匹配**明确的测试命名**，不会碰真实数据。
 */
import 'dotenv/config';
import { prisma } from '../src/prisma';

const apply = process.argv.includes('--apply') || process.env.APPLY === '1' || process.env.APPLY === 'true';

/** 冒烟测试创建的家长昵称前缀。 */
const TEST_NICKNAMES = ['隔离测试B', '后台处置测试', '冒烟测试'];
/** 测试/示例注册的设备码前缀。 */
const TEST_DEVICE_PREFIXES = ['SMOKE', 'OPTEST'];
/** 设备名里含这些字样的也清掉。 */
const TEST_DEVICE_NAME_HINTS = ['冒烟测试', '运营处置测试'];
/** 示例 Agent 用的固定设备码。 */
const TEST_DEVICE_CODES = ['AGENT001'];

async function main() {
  const users = await prisma.user.findMany({
    where: { OR: TEST_NICKNAMES.map((n) => ({ nickname: { startsWith: n } })) },
    select: { id: true, nickname: true, phone: true },
  });

  const devices = await prisma.childDevice.findMany({
    where: {
      OR: [
        ...TEST_DEVICE_PREFIXES.map((p) => ({ deviceCode: { startsWith: p } })),
        ...TEST_DEVICE_NAME_HINTS.map((n) => ({ name: { contains: n } })),
        { deviceCode: { in: TEST_DEVICE_CODES } },
      ],
    },
    select: { id: true, name: true, deviceCode: true },
  });

  const tempAdmins = await prisma.admin.findMany({
    where: { username: { startsWith: 'smoke_admin_' } },
    select: { id: true, username: true },
  });

  console.log(`\n${apply ? '🗑  即将删除' : '🔍 预演（未删除任何内容）'}\n`);

  console.log(`  家长账号 ${users.length} 个：`);
  for (const u of users.slice(0, 20)) console.log(`    · #${u.id} ${u.nickname} ${u.phone ?? ''}`);
  if (users.length > 20) console.log(`    … 其余 ${users.length - 20} 个`);

  console.log(`\n  设备 ${devices.length} 台：`);
  for (const d of devices.slice(0, 20)) console.log(`    · ${d.deviceCode} ${d.name}`);
  if (devices.length > 20) console.log(`    … 其余 ${devices.length - 20} 台`);

  console.log(`\n  临时管理员 ${tempAdmins.length} 个：`);
  for (const a of tempAdmins) console.log(`    · ${a.username}`);

  console.log('\n  说明：操作日志不在清理范围内 —— 审计记录应当保留。');

  if (!apply) {
    console.log('\n提示：加 --apply 才会真正执行删除。\n');
    return;
  }

  // 先删设备（级联清掉指令/位置/媒体/答题记录），再删账号
  const removedDevices = await prisma.childDevice.deleteMany({
    where: { id: { in: devices.map((d) => d.id) } },
  });
  const removedUsers = await prisma.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } });
  const removedAdmins = await prisma.admin.deleteMany({ where: { id: { in: tempAdmins.map((a) => a.id) } } });

  console.log(
    `\n✅ 已删除：设备 ${removedDevices.count} 台 · 家长账号 ${removedUsers.count} 个 · 临时管理员 ${removedAdmins.count} 个`,
  );
  console.log('   服务器上的媒体文件（server/uploads）可能残留无引用的文件，可按需手动清理。\n');
}

main()
  .catch((err) => {
    console.error('清理失败：', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
