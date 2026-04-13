-- ═══════════════════════════════════════════════════════════
--  Avi Contrôle — Schéma PostgreSQL complet
-- ═══════════════════════════════════════════════════════════

-- Extension UUID
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── Utilisateurs ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email             VARCHAR(255) UNIQUE NOT NULL,
  password_hash     TEXT NOT NULL,
  name              VARCHAR(255),
  telegram_username VARCHAR(100),
  telegram_chat_id  VARCHAR(50),
  is_admin          BOOLEAN DEFAULT false,
  created_at        TIMESTAMP DEFAULT NOW(),
  updated_at        TIMESTAMP DEFAULT NOW()
);

-- ── Licences ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS licenses (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID REFERENCES users(id) ON DELETE SET NULL,
  license_key        VARCHAR(50) UNIQUE NOT NULL,
  plan               VARCHAR(20) NOT NULL CHECK (plan IN ('monthly','yearly','lifetime')),
  status             VARCHAR(20) DEFAULT 'inactive'
                       CHECK (status IN ('inactive','active','revoked','expired')),
  device_fingerprint VARCHAR(255),
  device_name        VARCHAR(255),
  transfer_count     INT DEFAULT 0,
  max_transfers      INT DEFAULT 2,
  payment_id         VARCHAR(100),
  activated_at       TIMESTAMP,
  expires_at         TIMESTAMP,
  created_at         TIMESTAMP DEFAULT NOW(),
  updated_at         TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_licenses_key    ON licenses(license_key);
CREATE INDEX IF NOT EXISTS idx_licenses_status ON licenses(status);

-- ── Commandes on-chain ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS on_chain_orders (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id         VARCHAR(50) NOT NULL,
  plan            VARCHAR(20) NOT NULL,
  coin            VARCHAR(10) NOT NULL CHECK (coin IN ('btc','eth','usdt','ltc')),
  address         VARCHAR(100) NOT NULL,
  hd_index        INTEGER NOT NULL,
  expected_usd    DECIMAL(10,2) NOT NULL,
  expected_amount DECIMAL(20,8),
  status          VARCHAR(20) DEFAULT 'pending'
                    CHECK (status IN ('pending','confirmed','expired')),
  tx_hash         VARCHAR(100),
  created_at      TIMESTAMP DEFAULT NOW(),
  expires_at      TIMESTAMP DEFAULT NOW() + INTERVAL '2 hours',
  processed_at    TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_orders_status  ON on_chain_orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_address ON on_chain_orders(address);

-- ── Telegram pending (avant inscription) ─────────────────────
CREATE TABLE IF NOT EXISTS telegram_pending (
  chat_id    VARCHAR(50) PRIMARY KEY,
  username   VARCHAR(100),
  created_at TIMESTAMP DEFAULT NOW()
);

-- ── Refresh tokens JWT ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
  token      TEXT UNIQUE NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens ON refresh_tokens(token);

-- ── User admin système (pour les licences générées manuellement) ──
INSERT INTO users (email, password_hash, name, is_admin)
VALUES ('admin@avicontrole.local', 'N/A', 'Admin', true)
ON CONFLICT (email) DO NOTHING;
