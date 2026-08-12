import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Load ONLY backend/.env (keep secrets here — not backend/src/.env)
// override: true so .env wins over leftover shell/system DB_* vars
dotenv.config({ path: path.resolve(__dirname, '../.env'), override: true });

export const config = {
  port: Number(process.env.PORT || 4000),
  nodeEnv: process.env.NODE_ENV || 'development',
  appUrl: process.env.APP_URL || 'http://localhost:5173',
  apiUrl: process.env.API_URL || 'http://localhost:4000',
  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'whatsapp_bsp',
    // Aiven and many cloud MySQL hosts require TLS (ssl-mode=REQUIRED)
    ssl: ['1', 'true', 'yes', 'required'].includes(
      String(process.env.DB_SSL || '').toLowerCase()
    ),
  },
  redis: {
    // Render / managed Redis usually provide REDIS_URL (redis:// or rediss://)
    url: process.env.REDIS_URL || '',
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: Number(process.env.REDIS_PORT || 6379),
    password: process.env.REDIS_PASSWORD || undefined,
  },
  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET || 'dev_access_secret_change_me_32chars',
    refreshSecret: process.env.JWT_REFRESH_SECRET || 'dev_refresh_secret_change_me_32chars',
    accessExpires: process.env.JWT_ACCESS_EXPIRES || '15m',
    refreshExpires: process.env.JWT_REFRESH_EXPIRES || '7d',
  },
  smtp: {
    provider: process.env.SMTP_PROVIDER || '',
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    user: process.env.SMTP_USER,
    // Prefer SMTP_PASSWORD; keep SMTP_PASS as fallback for existing .env files
    pass: process.env.SMTP_PASSWORD || process.env.SMTP_PASS,
    // Prefer EMAIL_FROM; keep SMTP_FROM as fallback
    from:
      process.env.EMAIL_FROM ||
      process.env.SMTP_FROM ||
      process.env.SMTP_USER ||
      'noreply@example.com',
    secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
  },
  meta: {
    appId: process.env.META_APP_ID || '',
    appSecret: process.env.META_APP_SECRET || '',
    configId: process.env.META_CONFIG_ID || '',
    webhookVerifyToken: process.env.META_WEBHOOK_VERIFY_TOKEN || 'whatsapp_verify_token',
    graphVersion: process.env.META_GRAPH_VERSION || 'v21.0',
    systemUserToken: process.env.META_SYSTEM_USER_TOKEN || '',
    tokenEncryptionKey: process.env.META_TOKEN_ENCRYPTION_KEY || '',
    redirectUri: process.env.META_REDIRECT_URI || '',
  },
  razorpay: {
    keyId: process.env.RAZORPAY_KEY_ID || '',
    keySecret: process.env.RAZORPAY_KEY_SECRET || '',
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || '',
  },
  wallet: {
    minRecharge: Number(process.env.WALLET_MIN_RECHARGE || 100),
    maxRecharge: Number(process.env.WALLET_MAX_RECHARGE || 100000),
    currency: process.env.WALLET_CURRENCY || 'INR',
    processingFee: Number(process.env.WALLET_PROCESSING_FEE || 0),
    processingFeePercent: Number(process.env.WALLET_PROCESSING_FEE_PERCENT || 0),
    defaultProviderCost: Number(process.env.DEFAULT_PROVIDER_COST || 0),
  },
  uploadDir: process.env.UPLOAD_DIR || 'uploads',
  defaultMessageCost: Number(process.env.DEFAULT_MESSAGE_COST || 0.5),
  lowWalletThreshold: Number(process.env.LOW_WALLET_THRESHOLD || 100),
  campaignConcurrency: Number(process.env.CAMPAIGN_CONCURRENCY || 5),
  campaignSendDelayMs: Number(process.env.CAMPAIGN_SEND_DELAY_MS || 100),
};
