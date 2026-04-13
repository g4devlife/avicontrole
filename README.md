# Remote Control — Logiciel de contrôle Android à distance

Comme AnyDesk mais pour Android, avec système de licences payantes.

## Architecture

```
Android App  ←──WebRTC──→  Serveur  ←──WebRTC──→  Desktop App
     │                        │
     └──── API Licences ───────┘
```

## Démarrage rapide

### 1. Backend (serveur)
```bash
cd backend
cp .env.example .env
# Remplir .env avec vos clés Stripe, PostgreSQL, etc.
npm install
npm run db:migrate
npm run dev
```

### 2. Desktop (Windows)
```bash
cd desktop
npm install
npm run dev
```

### 3. Android
- Ouvrir `android/` dans Android Studio
- Remplacer `YOUR_SERVER_URL` dans `WebRTCManager.kt` et `LicenseManager.kt`
- Compiler et installer sur l'appareil

## Flux utilisateur

1. L'utilisateur achète une licence sur votre site → reçoit la clé par email
2. Il installe l'APK Android → entre sa clé → activée sur son appareil
3. Il ouvre l'app → appuie "Démarrer" → un code 8 chars s'affiche
4. Sur son PC → ouvre Remote Control → entre le code → connexion établie
5. Il contrôle son téléphone depuis le PC

## Configuration Paiements Crypto (NOWPayments)

1. Créer un compte sur https://nowpayments.io
2. Récupérer votre **API Key** dans le dashboard
3. Dans "IPN Settings", configurer :
   - URL de webhook : `https://votre-serveur.com/api/payment/webhook`
   - Copier le **IPN Secret**
4. Remplir dans `.env` :
   ```
   NOWPAYMENTS_API_KEY=votre_cle
   NOWPAYMENTS_IPN_SECRET=votre_secret_ipn
   PRICE_MONTHLY_USD=9.99
   PRICE_YEARLY_USD=79.99
   PRICE_LIFETIME_USD=199.99
   ```

**Cryptos acceptées** : BTC, ETH, USDT (TRC20/ERC20), USDC, LTC, BNB, SOL, TRX, XRP

## Production

- Déployer le backend sur un VPS (Docker recommandé)
- Installer Coturn pour le serveur TURN (connexions internet)
- Remplacer `localhost:3000` par l'URL de production dans le code
- Build Electron : `cd desktop && npm run build`
- Signer l'APK Android avec votre keystore
