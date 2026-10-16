import { z } from 'zod';

/**
 * 合规相关的入参（规划 §5.3）。
 *
 * docType / docVersion 只做形状校验，**不在这里枚举合法值**：
 * 文本目录在服务端常量里，认不出来时要给一句人话（404「找不到这份合规文本」），
 * 而不是笼统的「有 N 项未通过校验」—— zod 的报错在 `detail` 里，家长看不懂。
 */
export const acceptConsentSchema = z.object({
  docType: z.string().trim().min(1, '请指定合规文本').max(64),
  docVersion: z.string().trim().min(1, '请带上你看到的文本版本').max(32),
});

export const consentIdSchema = z.object({ consentId: z.string().min(1) });

/** 撤回同意要密码 + 手动打字：这个动作会解绑所有设备，不该被误触。 */
export const revokeConsentSchema = z.object({
  password: z.string().min(1, '请输入账号密码'),
  confirm: z.string().min(1, '请手动输入确认文字'),
});

export const requestDeletionSchema = z.object({
  password: z.string().min(1, '请输入账号密码'),
  confirm: z.string().min(1, '请手动输入确认文字'),
});

export type AcceptConsentInput = z.infer<typeof acceptConsentSchema>;
export type RevokeConsentInput = z.infer<typeof revokeConsentSchema>;
export type RequestDeletionInput = z.infer<typeof requestDeletionSchema>;
