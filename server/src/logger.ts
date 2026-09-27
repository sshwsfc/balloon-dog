import pino from 'pino';
import { config } from './config';

/**
 * 结构化 JSON 日志。生产环境用 info，本地开发用 debug。
 * 每个请求会派生一个带 requestId 的子 logger（见 middleware/requestId）。
 * 业务日志请用 logger，不要用 console.log。
 *
 * redact 列表里的字段会在输出前被打码，避免验证码/令牌/密码进日志。
 */
export const logger = pino({
  level: config.LOG_LEVEL || (config.NODE_ENV === 'production' ? 'info' : 'debug'),
  redact: {
    paths: [
      'req.headers.authorization',
      'password',
      'passwordHash',
      'token',
      'code',
      'codeHash',
      'deviceSecret',
      '*.password',
      '*.token',
      '*.code',
    ],
    censor: '[REDACTED]',
  },
});
