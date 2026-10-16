import { z } from 'zod';

/** 路径参数：开关 key（`pay.channel.wechat` 这种点分形式）。 */
export const flagKeySchema = z.object({
  key: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9]+(\.[a-z0-9]+)*$/, '开关 key 只能是小写字母、数字和点'),
});

/**
 * 修改开关。三个字段都可选，只改传进来的那几个。
 *
 * 白名单上限 200 条不是技术限制，是防呆：真正需要手动放量的对象应该屈指可数，
 * 一个几百条的白名单通常意味着「应该用百分比放量」。
 */
export const flagPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    rolloutPercent: z.number().int().min(0).max(100).optional(),
    allowIds: z.array(z.string().min(1).max(64)).max(200).optional(),
    description: z.string().max(200).optional(),
  })
  .strict();

/** 预览：拿一个对象 id 试算，看它命中还是不命中、为什么。 */
export const flagPreviewQuerySchema = z.object({
  subjectId: z.string().max(64).optional(),
});
