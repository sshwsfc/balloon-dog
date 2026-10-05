import { z } from 'zod';

export const locationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export const createSafeZoneSchema = z.object({
  name: z.string().trim().min(1, '请输入安全区名称').max(30),
  latitude: z.coerce.number().min(-90).max(90),
  longitude: z.coerce.number().min(-180).max(180),
  radiusMeters: z.coerce.number().int().min(50, '半径至少 50 米').max(10_000).default(200),
  address: z.string().trim().max(200).optional(),
  type: z.enum(['home', 'school', 'other']).default('other'),
  /**
   * 是否启用（§2）。契约要求 /api/agent/config 只下发启用中的安全区，
   * 因此必须有这个开关；默认 true 保证既有数据行为不变。
   */
  enabled: z.boolean().optional(),
});

export const updateSafeZoneSchema = createSafeZoneSchema.partial();

export const safeZoneIdSchema = z.object({ safeZoneId: z.string().trim().min(1) });
