import 'dotenv/config'; // 必须在最前：先把 .env 载入 process.env，config 才能校验
import { createApp } from './app';
import { config } from './config';
import { logger } from './logger';
import { prisma } from './prisma';
import { commandsService } from './features/devices/commands.service';
import { ensureMediaDir } from './features/media/media.storage';
import { insightsService } from './features/insights/insights.service';
import { membershipService } from './features/membership/membership.service';
import { referralService } from './features/referral/referral.service';

const app = createApp();

// 启动前先确认数据库可达：与其等到第一个请求才 500，不如启动即失败（fail-fast）
async function bootstrap() {
  await prisma.$queryRaw`SELECT 1`;
  ensureMediaDir();

  // 会员套餐/定价规则是运营数据，但默认那几套必须存在，否则会员中心是空的。
  // ensureDefaults 是幂等的 upsert，且不会覆盖后台已经改过的价格。
  const seeded = await membershipService.ensureDefaults();
  logger.info({ msg: 'membership defaults ready', ...seeded });

  // 分享提成的阶梯/券规则同理：表空的家长端就没有任何奖励可达，先建默认值再补历史邀请码。
  // backfillInviteCodes 是惰性的（只补没有码的账号），重复启动不会重复写。
  const referralSeeded = await referralService.ensureDefaults();
  logger.info({ msg: 'referral defaults ready', ...referralSeeded });

  const server = app.listen(config.PORT, () => {
    logger.info({ msg: 'Server started', port: config.PORT, env: config.NODE_ENV });
  });

  // 启动后立即清一次过期帧图：长期停机再启动时不该让过期数据继续躺在磁盘上
  void insightsService.purgeExpired().catch((err) => {
    logger.warn({ msg: 'startup purge failed', error: (err as Error).message });
  });

  // 定时清理超时未领取/未完成的指令，并回滚它们的乐观状态
  const sweepTimer = setInterval(async () => {
    try {
      const count = await commandsService.sweepExpired();
      if (count > 0) logger.info({ msg: 'expired commands swept', count });
    } catch (err) {
      logger.error({ msg: 'sweepExpired failed', error: (err as Error).message });
    }
  }, config.COMMAND_SWEEP_INTERVAL_MS);

  // 定时清理过期的截屏帧图。
  //
  // 截屏是最高敏感度的数据，留档天数一到就必须真的从磁盘上消失 ——
  // 只删数据库行而留着图片，等于没删。
  const retentionTimer = setInterval(() => {
    void (async () => {
      try {
        const purged = await insightsService.purgeExpired();
        if (purged.batches > 0) {
          logger.info({
            msg: 'screen frames purged',
            batches: purged.batches,
            freedMB: Math.round(purged.bytes / 1024 / 1024),
          });
        }
      } catch (err) {
        logger.error({ msg: 'purgeExpired failed', error: (err as Error).message });
      }
    })();
  }, 60 * 60 * 1000); // 每小时一次

  // 会员维护：过期未支付的订单置为 expired；到期的连续包月尝试扣款（模拟）。
  //
  // 惰性降级（读到期的账号时顺手降级）已经能保证「不会白嫖」，
  // 这个定时任务的价值是把还有 3 天到期的续费提醒、续费失败的标记提前做掉。
  const membershipTimer = setInterval(
    () => {
      void (async () => {
        try {
          const swept = await membershipService.sweep();
          if (swept.orders > 0 || swept.renewed > 0 || swept.failed > 0) {
            logger.info({ msg: 'membership sweep', ...swept });
          }
        } catch (err) {
          logger.error({ msg: 'membership sweep failed', error: (err as Error).message });
        }
      })();
    },
    6 * 60 * 60 * 1000, // 每 6 小时一次
  );

  // 分享提成维护：当月奖励结算（pending → settled）与过期券收敛。
  // 结算日由后台配置（默认次月 10-15 日），sweep 自己判断今天该不该发。
  const referralTimer = setInterval(
    () => {
      void (async () => {
        try {
          const swept = await referralService.sweep();
          if (swept.settled > 0 || swept.expiredCoupons > 0) {
            logger.info({ msg: 'referral sweep', ...swept });
          }
        } catch (err) {
          logger.error({ msg: 'referral sweep failed', error: (err as Error).message });
        }
      })();
    },
    6 * 60 * 60 * 1000, // 每 6 小时一次
  );

  async function shutdown(signal: string) {
    logger.info({ msg: 'Shutting down', signal });
    clearInterval(sweepTimer);
    clearInterval(retentionTimer);
    clearInterval(membershipTimer);
    clearInterval(referralTimer);
    server.close();
    await prisma.$disconnect();
    process.exit(0);
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error({ msg: 'Unhandled rejection', reason: String(reason) });
  });
  process.on('uncaughtException', (err) => {
    logger.error({ msg: 'Uncaught exception', err: err?.message, stack: err?.stack });
    process.exit(1);
  });
}

bootstrap().catch((err) => {
  logger.error({ msg: 'Failed to start server', error: (err as Error).message, stack: (err as Error).stack });
  process.exit(1);
});
