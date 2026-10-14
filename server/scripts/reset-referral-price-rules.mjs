/**
 * 把受邀定价规则重置成代码里的默认值（开发/演示用）。
 *
 * 只做这一件事，因为它是**演示数据**：默认值改一次就得重灌一次，
 * 而从后台页面一条条改又慢又容易改漏。生产环境不要跑这个脚本 ——
 * 它会覆盖运营在后台调好的规则。
 *
 * 用法（必须走 tsx，因为它要 import 一个 .ts 常量文件，裸 node 会报
 * "does not provide an export named 'DEFAULT_REFERRAL_PRICE_RULES'"）：
 *     cd server && npx tsx scripts/reset-referral-price-rules.mjs
 */
import { PrismaClient } from '@prisma/client';
import { DEFAULT_REFERRAL_PRICE_RULES } from '../src/features/membership/membership.constants.ts';

const prisma = new PrismaClient();
await prisma.membershipReferralPriceRule.deleteMany({});
await prisma.membershipReferralPriceRule.createMany({
  data: DEFAULT_REFERRAL_PRICE_RULES.map((r) => ({ ...r })),
});
const rows = await prisma.membershipReferralPriceRule.findMany({ orderBy: { priority: 'desc' } });
for (const r of rows) {
  console.log(`${r.name} | ${r.priceType} ${r.priceValue} | tier ${r.targetTier} | period ${r.targetPeriod} | prio ${r.priority}`);
}
await prisma.$disconnect();
