#!/bin/bash
# ═══════════════════════════════════════════════════════
#  Avi Contrôle — Script de déploiement VPS (Ubuntu 22.04)
#  Usage : bash deploy.sh
# ═══════════════════════════════════════════════════════
set -e

DOMAIN="api.avicontrole.app"
APP_DIR="/opt/avicontrole"
DB_NAME="avicontrole"
DB_USER="aviuser"

echo "▶ Mise à jour système..."
apt update && apt upgrade -y

echo "▶ Installation Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs postgresql nginx certbot python3-certbot-nginx git

echo "▶ Installation PM2..."
npm install -g pm2

echo "▶ Configuration PostgreSQL..."
sudo -u postgres psql <<SQL
CREATE DATABASE IF NOT EXISTS $DB_NAME;
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = '$DB_USER') THEN
    CREATE USER $DB_USER WITH PASSWORD '${DB_PASSWORD:?DB_PASSWORD requis}';
  END IF;
END \$\$;
GRANT ALL PRIVILEGES ON DATABASE $DB_NAME TO $DB_USER;
SQL

echo "▶ Clone / mise à jour du repo..."
if [ -d "$APP_DIR" ]; then
  cd $APP_DIR && git pull
else
  git clone https://github.com/g4devlife/avicontrole.git $APP_DIR
fi

echo "▶ Backend — installation deps + build..."
cd $APP_DIR/backend
cp -n .env.example .env || true
npm install
npm run build

echo "▶ Schéma base de données..."
PGPASSWORD=$DB_PASSWORD psql -U $DB_USER -d $DB_NAME -f schema.sql

echo "▶ Dossiers logs + APK..."
mkdir -p /var/log/avicontrole
mkdir -p /var/www/avicontrole/download

echo "▶ Nginx..."
cp $APP_DIR/nginx.conf /etc/nginx/sites-available/avicontrole
ln -sf /etc/nginx/sites-available/avicontrole /etc/nginx/sites-enabled/avicontrole
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

echo "▶ SSL (Let's Encrypt)..."
certbot --nginx -d $DOMAIN --non-interactive --agree-tos -m admin@avicontrole.app

echo "▶ PM2..."
cd $APP_DIR/backend
pm2 start ecosystem.config.js --env production
pm2 save
pm2 startup | tail -1 | bash

echo "▶ Webhook Telegram..."
BOT_TOKEN=${TELEGRAM_BOT_TOKEN:?TELEGRAM_BOT_TOKEN requis}
WEBHOOK_SECRET=${TELEGRAM_WEBHOOK_SECRET:?requis}
curl -s -X POST "https://api.telegram.org/bot$BOT_TOKEN/setWebhook" \
  -d "url=https://$DOMAIN/api/telegram/webhook" \
  -d "secret_token=$WEBHOOK_SECRET"

echo ""
echo "✅ Déploiement terminé !"
echo "   API : https://$DOMAIN/health"
echo ""
echo "⚠️  N'oubliez pas de :"
echo "   1. Éditer /opt/avicontrole/backend/.env avec vos vraies valeurs"
echo "   2. Générer votre mnemonic HD wallet et l'ajouter dans .env"
echo "   3. Uploader l'APK dans /var/www/avicontrole/download/"
echo "   4. pm2 restart avicontrole-api après avoir édité .env"
