import { PrismaClient } from '@prisma/client';
import { config } from './config';

/**
 * PrismaClient 单例：避免开发期热重载（tsx watch）反复创建连接池把数据库打满。
 */
export const prisma = new PrismaClient({
  log: config.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
});
