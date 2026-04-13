import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port:    parseInt(process.env.PORT || '3000'),
  nodeEnv: process.env.NODE_ENV || 'development',

  database: {
    url: process.env.DATABASE_URL || 'postgresql://localhost:5432/avicontrole',
  },

  jwt: {
    secret:          process.env.JWT_SECRET || 'dev_secret_change_in_prod',
    expiresIn:       process.env.JWT_EXPIRES_IN || '1h',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
  },

  license: {
    hmacSecret:    process.env.LICENSE_HMAC_SECRET || 'dev_license_secret',
    maxTransfers:  2,
  },

  // Prix USD des plans (utilisés pour la conversion crypto)
  nowpayments: {
    prices: {
      monthly:  parseFloat(process.env.PRICE_MONTHLY_USD  || '9.99'),
      yearly:   parseFloat(process.env.PRICE_YEARLY_USD   || '79.99'),
      lifetime: parseFloat(process.env.PRICE_LIFETIME_USD || '199.99'),
    },
  },

  telegram: {
    botToken:      process.env.TELEGRAM_BOT_TOKEN       || '',
    webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET  || '',
    adminChatIds:  (process.env.TELEGRAM_ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean),
  },

  apkDownloadUrl: process.env.APK_DOWNLOAD_URL || 'https://avicontrole.app/download/avicontrole.apk',
};
