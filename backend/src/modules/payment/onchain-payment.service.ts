import { pool }        from '../../database/db';
import { config }       from '../../config/config';
import { licenseService, LicensePlan } from '../license/license.service';
import { telegramService }             from '../telegram/telegram.service';
import { getHdWallet }                 from './hd-wallet.service';
import { usdToCrypto, checkPaymentReceived } from './chain-monitor.service';

export const COINS = [
  { id: 'btc',  label: 'Bitcoin',  symbol: 'BTC',  emoji: '₿' },
  { id: 'eth',  label: 'Ethereum', symbol: 'ETH',  emoji: 'Ξ' },
  { id: 'usdt', label: 'USDT',     symbol: 'USDT', emoji: '₮' },
  { id: 'ltc',  label: 'Litecoin', symbol: 'LTC',  emoji: 'Ł' },
];

export const PLANS = [
  { id: 'monthly',  label: 'Mensuel',  emoji: '📅' },
  { id: 'yearly',   label: 'Annuel',   emoji: '📆' },
  { id: 'lifetime', label: 'À vie',    emoji: '♾️'  },
];

// ── Créer une commande ───────────────────────────────────────
export async function createOrder(
  chatId: string,
  plan:   LicensePlan,
  coin:   string,
): Promise<{
  address:        string;
  expectedAmount: number;
  symbol:         string;
  expiresAt:      Date;
}> {
  const wallet   = getHdWallet();
  const priceUsd = config.nowpayments.prices[plan];

  // Index unique = compteur global d'ordres
  const idxRes = await pool.query('SELECT COUNT(*) FROM on_chain_orders');
  const hdIndex = parseInt(idxRes.rows[0].count);

  const address        = wallet.deriveAddress(coin, hdIndex);
  const expectedAmount = await usdToCrypto(priceUsd, coin);
  const expiresAt      = new Date(Date.now() + 2 * 60 * 60 * 1000); // 2h

  const coinInfo = COINS.find(c => c.id === coin)!;

  await pool.query(
    `INSERT INTO on_chain_orders
       (chat_id, plan, coin, address, hd_index, expected_usd, expected_amount, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [chatId, plan, coin, address, hdIndex, priceUsd, expectedAmount, expiresAt],
  );

  return { address, expectedAmount, symbol: coinInfo.symbol, expiresAt };
}

// ── Boucle de surveillance (lancée au démarrage) ─────────────
export function startOrderMonitor(): void {
  console.log('[ONCHAIN] Moniteur de paiements démarré');
  // Vérifie toutes les 30 secondes
  setInterval(checkPendingOrders, 30_000);
}

async function checkPendingOrders(): Promise<void> {
  const res = await pool.query(
    `SELECT * FROM on_chain_orders
     WHERE status = 'pending' AND expires_at > NOW()`,
  );

  for (const order of res.rows) {
    try {
      const result = await checkPaymentReceived(
        order.coin,
        order.address,
        parseFloat(order.expected_amount),
      );

      if (result.received) {
        await processConfirmedOrder(order, result.txHash);
      }
    } catch (err: any) {
      console.error(`[ONCHAIN] Erreur vérif order ${order.id}:`, err.message);
    }
  }

  // Expirer les commandes dépassées
  await pool.query(
    `UPDATE on_chain_orders SET status='expired'
     WHERE status='pending' AND expires_at <= NOW()`,
  );
}

async function processConfirmedOrder(order: any, txHash?: string): Promise<void> {
  // Idempotence
  const existing = await pool.query(
    'SELECT id FROM on_chain_orders WHERE id=$1 AND status=$2',
    [order.id, 'confirmed'],
  );
  if (existing.rows.length > 0) return;

  // Marquer confirmé
  await pool.query(
    `UPDATE on_chain_orders
     SET status='confirmed', tx_hash=$1, processed_at=NOW()
     WHERE id=$2`,
    [txHash || null, order.id],
  );

  // Créer ou récupérer l'user admin
  let userId: string;
  const adminUser = await pool.query(
    "SELECT id FROM users WHERE email='admin@avicontrole.local'",
  );
  if (adminUser.rows.length === 0) {
    const ins = await pool.query(
      `INSERT INTO users (email, password_hash, name, is_admin)
       VALUES ('admin@avicontrole.local','N/A','Admin',true) RETURNING id`,
    );
    userId = ins.rows[0].id;
  } else {
    userId = adminUser.rows[0].id;
  }

  // Créer la licence
  const license = await licenseService.createLicense(userId, order.plan as LicensePlan);

  // Envoyer la clé sur Telegram
  await telegramService.sendLicenseKey(order.chat_id, license.licenseKey, order.plan);

  const coinInfo = COINS.find(c => c.id === order.coin);
  console.log(
    `[ONCHAIN] ✅ Paiement confirmé — plan:${order.plan} coin:${order.coin}` +
    ` adresse:${order.address} tx:${txHash || 'N/A'}`,
  );

  // Notifier les admins
  for (const adminId of config.telegram.adminChatIds) {
    await telegramService.sendMessage(
      adminId,
      `💰 <b>Nouveau paiement reçu</b>\n\n` +
      `Plan : ${order.plan}\n` +
      `Montant : ${order.expected_amount} ${coinInfo?.symbol}\n` +
      `Clé : <code>${license.licenseKey}</code>\n` +
      (txHash ? `TX : <code>${txHash}</code>` : ''),
    );
  }
}
