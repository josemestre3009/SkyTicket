import { config } from './config.js';

const SENSITIVE_LOG_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwordHash',
  '*.password_hash',
  '*.secret',
  '*.appSecret',
  '*.app_secret',
  '*.access_token',
  '*.accessToken',
  '*.apiToken',
  '*.api_token',
  '*.appid',
  '*.appId',
  '*.token',
  '*.totpSecret',
  '*.totp_secret',
  '*.code',
  '*.voucherCode',
  '*.codeEncrypted',
];

export const loggerOptions = {
  level: config.logLevel,
  redact: {
    paths: SENSITIVE_LOG_PATHS,
    censor: '[REDACTED]',
  },
};
