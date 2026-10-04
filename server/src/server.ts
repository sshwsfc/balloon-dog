import 'dotenv/config'; // 必须在最前：先把 .env 载入 process.env，config 才能校验
import { createApp } from './app';
import { config } from './config';
import { logger } from './logger';
import { prisma } from './prisma';
import { commandsService } from './features/devices/commands.service';
import { ensureMediaDir } from './features/media/media.storage';
import { insightsService } from './features/insights/insights.service';

const app = createApp();

// 启动前先确认数据库可达：与其等到第一个请求才 500，不如启动即失败（fail-fast）
async function bootstrap() {
  await prisma.$queryRaw`SELECT 1`;
  ensureMediaDir();

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

  async function shutdown(signal: string) {
    logger.info({ msg: 'Shutting down', signal });
    clearInterval(sweepTimer);
    clearInterval(retentionTimer);
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
