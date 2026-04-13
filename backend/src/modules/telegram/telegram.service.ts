import axios from 'axios';
import { config } from '../../config/config';
import { pool } from '../../database/db';
import { licenseService, LicensePlan } from '../license/license.service';
import { createOrder, COINS, PLANS } from '../payment/onchain-payment.service';

const API = `https://api.telegram.org/bot${config.telegram.botToken}`;

export class TelegramService {

  // ──────────────────────────────────────────
  //  Envoyer un message à un chat_id
  // ──────────────────────────────────────────

  async sendMessage(chatId: string | number, text: string): Promise<boolean> {
    try {
      await axios.post(`${API}/sendMessage`, {
        chat_id:    chatId,
        text,
        parse_mode: 'HTML',
      });
      return true;
    } catch (err: any) {
      console.error('[TELEGRAM] Erreur envoi:', err.response?.data || err.message);
      return false;
    }
  }

  // ──────────────────────────────────────────
  //  Clavier inline
  // ──────────────────────────────────────────

  async sendInlineKeyboard(
    chatId:  string | number,
    text:    string,
    buttons: Array<Array<{ text: string; callback_data: string }>>,
  ): Promise<void> {
    await axios.post(`${API}/sendMessage`, {
      chat_id:      chatId,
      text,
      parse_mode:   'HTML',
      reply_markup: { inline_keyboard: buttons },
    });
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    await axios.post(`${API}/answerCallbackQuery`, {
      callback_query_id: callbackQueryId,
      text,
    });
  }

  // ──────────────────────────────────────────
  //  Flow /buy — sélection plan
  // ──────────────────────────────────────────

  private async handleBuy(chatId: number): Promise<void> {
    const prices = config.nowpayments.prices;
    const buttons = PLANS.map(p => ([{
      text:          `${p.emoji} ${p.label} — $${prices[p.id as keyof typeof prices]}`,
      callback_data: `buy_plan:${p.id}`,
    }]));

    await this.sendInlineKeyboard(
      chatId,
      `🛒 <b>Choisissez votre plan</b>\n\n` +
      `📅 Mensuel  — $${prices.monthly}\n` +
      `📆 Annuel   — $${prices.yearly}\n` +
      `♾️ À vie     — $${prices.lifetime}`,
      buttons,
    );
  }

  // ──────────────────────────────────────────
  //  Callback queries (boutons inline)
  // ──────────────────────────────────────────

  async handleCallbackQuery(query: any): Promise<void> {
    const chatId   = query.message.chat.id;
    const data     = query.data as string;
    const queryId  = query.id;

    await this.answerCallbackQuery(queryId);

    // Sélection du plan → afficher les coins
    if (data.startsWith('buy_plan:')) {
      const plan = data.split(':')[1];
      const buttons = [
        COINS.slice(0, 2).map(c => ({
          text: `${c.emoji} ${c.label}`, callback_data: `buy_coin:${plan}:${c.id}`,
        })),
        COINS.slice(2).map(c => ({
          text: `${c.emoji} ${c.label}`, callback_data: `buy_coin:${plan}:${c.id}`,
        })),
      ];
      await this.sendInlineKeyboard(
        chatId,
        `💳 <b>Choisissez votre crypto</b>`,
        buttons,
      );
      return;
    }

    // Sélection du coin → générer l'adresse et afficher
    if (data.startsWith('buy_coin:')) {
      const [, plan, coin] = data.split(':');
      const coinInfo = COINS.find(c => c.id === coin)!;
      const planInfo = PLANS.find(p => p.id === plan)!;

      await this.sendMessage(chatId, '⏳ Génération de votre adresse de paiement…');

      try {
        const order = await createOrder(chatId.toString(), plan as LicensePlan, coin);
        const expireStr = order.expiresAt.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

        await this.sendMessage(
          chatId,
          `${coinInfo.emoji} <b>Paiement ${planInfo.label}</b>\n\n` +
          `Envoyez exactement :\n` +
          `<b>${order.expectedAmount} ${order.symbol}</b>\n\n` +
          `À cette adresse :\n` +
          `<code>${order.address}</code>\n\n` +
          `⏱ Expire à <b>${expireStr}</b> (2h)\n\n` +
          `Je vous enverrai votre clé de licence automatiquement dès réception.`,
        );
      } catch (err: any) {
        await this.sendMessage(chatId, `❌ Erreur : ${err.message}`);
      }
      return;
    }
  }

  // ──────────────────────────────────────────
  //  Envoyer la clé de licence
  // ──────────────────────────────────────────

  async sendLicenseKey(
    chatId:     string | number,
    licenseKey: string,
    plan:       string,
  ): Promise<boolean> {
    const apkUrl = (config as any).apkDownloadUrl || 'https://avicontrole.app/download/avicontrole.apk';
    const activationLink = `avicontrole://activate?key=${licenseKey}`;
    return this.sendLicenseToClient(chatId, licenseKey, plan, activationLink, apkUrl);
  }

  async sendLicenseToClient(
    chatId:         string | number,
    licenseKey:     string,
    plan:           string,
    activationLink: string,
    apkUrl:         string,
  ): Promise<boolean> {
    const planLabel: Record<string, string> = {
      monthly:  'Mensuel (1 mois)',
      yearly:   'Annuel (1 an)',
      lifetime: 'À vie ♾️',
    };

    const msg =
`🎉 <b>Votre licence Avi Contrôle est prête !</b>

Plan : <b>${planLabel[plan] ?? plan}</b>

━━━━━━━━━━━━━━━━━━━━
<b>📥 Étape 1 — Télécharger l'app</b>
<a href="${apkUrl}">Télécharger Avi Contrôle APK</a>

<b>⚡ Étape 2 — Activer en 1 tap</b>
Après l'installation, appuyez sur ce lien :
<a href="${activationLink}">Activer ma licence</a>

<b>✅ Étape 3 — Accepter les permissions</b>
L'app vous guidera automatiquement.

━━━━━━━━━━━━━━━━━━━━
🔑 Clé (si besoin) : <code>${licenseKey}</code>

⚠️ Cette licence est liée à <b>1 seul appareil</b>.`;

    return this.sendMessage(chatId, msg);
  }

  // ──────────────────────────────────────────
  //  Vérification admin
  // ──────────────────────────────────────────

  isAdmin(chatId: string | number): boolean {
    return config.telegram.adminChatIds.includes(String(chatId));
  }

  // ──────────────────────────────────────────
  //  Commandes admin
  // ──────────────────────────────────────────

  private async handleAdminCommand(chatId: number, text: string): Promise<void> {
    const parts = text.trim().split(/\s+/);
    const cmd   = parts[0].toLowerCase();

    // /genkey [plan] [@username_telegram ou note]
    // plan: monthly | yearly | lifetime
    if (cmd === '/genkey') {
      const plan  = (parts[1] || 'lifetime') as LicensePlan;
      const target = parts[2] || '';   // @username ou note
      if (!['monthly','yearly','lifetime'].includes(plan)) {
        await this.sendMessage(chatId, '❌ Plan invalide. Utiliser : monthly | yearly | lifetime');
        return;
      }

      // Créer un user admin fictif si nécessaire
      let userId: string;
      const adminUser = await pool.query("SELECT id FROM users WHERE email='admin@avicontrole.local'");
      if (adminUser.rows.length === 0) {
        const ins = await pool.query(
          `INSERT INTO users (email, password_hash, name, is_admin)
           VALUES ('admin@avicontrole.local', 'N/A', 'Admin', true) RETURNING id`,
        );
        userId = ins.rows[0].id;
      } else {
        userId = adminUser.rows[0].id;
      }

      const lic = await licenseService.createLicense(userId, plan);
      const activationLink = `avicontrole://activate?key=${lic.licenseKey}`;
      const apkUrl = config.apkDownloadUrl || 'https://avicontrole.app/download/avicontrole.apk';

      // Message admin
      await this.sendMessage(chatId,
        `✅ <b>Clé générée</b>\n\n` +
        `Plan : <b>${plan}</b>\n` +
        (target ? `Pour : ${target}\n` : '') +
        `\nClé :\n<code>${lic.licenseKey}</code>\n\n` +
        `Lien d'activation :\n<code>${activationLink}</code>`
      );

      // Si un @username est fourni → envoyer directement au client
      if (target.startsWith('@')) {
        const clientChatId = await this.getChatIdByUsername(target);
        if (clientChatId) {
          await this.sendLicenseToClient(clientChatId, lic.licenseKey, plan, activationLink, apkUrl);
          await this.sendMessage(chatId, `📤 Message envoyé à ${target}`);
        } else {
          await this.sendMessage(chatId,
            `⚠️ ${target} n'a pas encore démarré le bot.\n` +
            `Demandez-lui d'envoyer /start au bot d'abord.`
          );
        }
      }
      return;
    }

    // /revoke [clé]
    if (cmd === '/revoke') {
      const key = parts[1];
      if (!key) { await this.sendMessage(chatId, '❌ Usage : /revoke XXXXX-XXXX-XXXX-XXXX-XXXXX'); return; }
      const r = await pool.query(
        "UPDATE licenses SET status='revoked', updated_at=NOW() WHERE license_key=$1 RETURNING id, license_key",
        [key.toUpperCase()],
      );
      if (r.rows.length === 0) {
        await this.sendMessage(chatId, '❌ Clé introuvable.');
      } else {
        await this.sendMessage(chatId, `🚫 Licence <code>${r.rows[0].license_key}</code> révoquée.`);
      }
      return;
    }

    // /extend [clé] [jours]
    if (cmd === '/extend') {
      const key  = parts[1];
      const days = parseInt(parts[2] || '30');
      if (!key || isNaN(days)) {
        await this.sendMessage(chatId, '❌ Usage : /extend XXXXX-XXXX-XXXX-XXXX-XXXXX 30');
        return;
      }
      const r = await pool.query(
        `UPDATE licenses
         SET expires_at = COALESCE(expires_at, NOW()) + INTERVAL '1 day' * $1,
             status     = CASE WHEN status='expired' THEN 'active' ELSE status END,
             updated_at = NOW()
         WHERE license_key=$2
         RETURNING license_key, expires_at`,
        [days, key.toUpperCase()],
      );
      if (r.rows.length === 0) {
        await this.sendMessage(chatId, '❌ Clé introuvable.');
      } else {
        const exp = r.rows[0].expires_at
          ? new Date(r.rows[0].expires_at).toLocaleDateString('fr-FR')
          : '♾️ Lifetime';
        await this.sendMessage(chatId,
          `✅ Licence prolongée de <b>${days} jours</b>\n` +
          `Clé : <code>${r.rows[0].license_key}</code>\n` +
          `Nouvelle expiration : <b>${exp}</b>`
        );
      }
      return;
    }

    // /keyinfo [clé]
    if (cmd === '/keyinfo') {
      const key = parts[1];
      if (!key) { await this.sendMessage(chatId, '❌ Usage : /keyinfo XXXXX-XXXX-XXXX-XXXX-XXXXX'); return; }
      const r = await pool.query(
        `SELECT l.*, u.email
         FROM licenses l LEFT JOIN users u ON u.id=l.user_id
         WHERE l.license_key=$1`,
        [key.toUpperCase()],
      );
      if (r.rows.length === 0) {
        await this.sendMessage(chatId, '❌ Clé introuvable.');
        return;
      }
      const l   = r.rows[0];
      const exp = l.expires_at ? new Date(l.expires_at).toLocaleDateString('fr-FR') : '♾️ Lifetime';
      const act = l.activated_at ? new Date(l.activated_at).toLocaleDateString('fr-FR') : 'Non activée';
      await this.sendMessage(chatId,
        `📋 <b>Infos licence</b>\n\n` +
        `Clé : <code>${l.license_key}</code>\n` +
        `Plan : ${l.plan}\n` +
        `Statut : ${l.status}\n` +
        `Email : ${l.email || 'N/A'}\n` +
        `Appareil : ${l.device_name || 'N/A'}\n` +
        `Activée le : ${act}\n` +
        `Expire le : ${exp}\n` +
        `Transferts : ${l.transfer_count}/${l.max_transfers}`
      );
      return;
    }

    // /listkeys [page]
    if (cmd === '/listkeys') {
      const page  = parseInt(parts[1] || '1') - 1;
      const limit = 10;
      const r = await pool.query(
        `SELECT license_key, plan, status, device_name, expires_at
         FROM licenses
         ORDER BY created_at DESC
         LIMIT $1 OFFSET $2`,
        [limit, page * limit],
      );
      if (r.rows.length === 0) {
        await this.sendMessage(chatId, '📋 Aucune licence trouvée.');
        return;
      }
      const lines = r.rows.map((l: any) => {
        const icon = l.status === 'active' ? '✅' : l.status === 'revoked' ? '🚫' : l.status === 'expired' ? '⏰' : '⬜';
        return `${icon} <code>${l.license_key}</code> — ${l.plan}`;
      }).join('\n');
      const total = await pool.query('SELECT COUNT(*) FROM licenses');
      await this.sendMessage(chatId,
        `📋 <b>Licences (page ${page+1})</b> — ${total.rows[0].count} total\n\n${lines}\n\n` +
        `Page suivante : /listkeys ${page+2}`
      );
      return;
    }

    // /help admin
    if (cmd === '/admin' || cmd === '/help') {
      await this.sendMessage(chatId,
        `🔧 <b>Commandes Admin — Avi Contrôle</b>\n\n` +
        `/genkey [monthly|yearly|lifetime] [note] — Générer une clé\n` +
        `/revoke [clé] — Révoquer une licence\n` +
        `/extend [clé] [jours] — Prolonger une licence\n` +
        `/keyinfo [clé] — Infos sur une clé\n` +
        `/listkeys [page] — Lister les licences\n`
      );
      return;
    }

    await this.sendMessage(chatId, '❓ Commande inconnue. Tapez /help pour la liste.');
  }

  // ──────────────────────────────────────────
  //  Traiter les mises à jour du bot (webhook)
  // ──────────────────────────────────────────

  async handleUpdate(update: any): Promise<void> {
    // ── Callback query (boutons inline) ───────────────────
    if (update.callback_query) {
      await this.handleCallbackQuery(update.callback_query);
      return;
    }

    const message = update.message;
    if (!message) return;

    const chatId   = message.chat.id;
    const username = message.from?.username;
    const text     = message.text?.trim();
    if (!text) return;

    // ── Commandes admin (uniquement si chat_id autorisé) ──
    const adminCmds = ['/genkey', '/revoke', '/extend', '/keyinfo', '/listkeys', '/admin', '/help'];
    const isAdminCmd = adminCmds.some(c => text.toLowerCase().startsWith(c));
    if (isAdminCmd) {
      if (!this.isAdmin(chatId)) {
        await this.sendMessage(chatId, '🚫 Accès refusé.');
        return;
      }
      await this.handleAdminCommand(chatId, text);
      return;
    }

    // ── Commande /buy ─────────────────────────────────────
    if (text === '/buy') {
      await this.handleBuy(chatId);
      return;
    }

    // ── Commande /start ───────────────────────────────────
    if (text === '/start' || text.startsWith('/start ')) {
      await this.registerChatId(chatId, username);
      await this.sendMessage(chatId,
        `👋 Bonjour <b>${message.from.first_name}</b> !\n\n` +
        `Je suis le bot <b>Avi Contrôle</b>.\n\n` +
        `Commandes disponibles :\n` +
        `/buy — Acheter une licence (BTC, ETH, USDT, LTC)\n` +
        `/status — Voir vos licences actives`
      );
      return;
    }

    // ── Commande /status ──────────────────────────────────
    if (text === '/status') {
      const result = await pool.query(
        `SELECT l.license_key, l.plan, l.status, l.expires_at, l.device_name
         FROM licenses l
         JOIN users u ON u.id = l.user_id
         WHERE u.telegram_chat_id = $1
         ORDER BY l.created_at DESC LIMIT 5`,
        [chatId.toString()],
      );

      if (result.rows.length === 0) {
        await this.sendMessage(chatId, '❌ Aucune licence trouvée pour votre compte.');
        return;
      }

      const lines = result.rows.map((lic: any) => {
        const exp = lic.expires_at
          ? `expire le ${new Date(lic.expires_at).toLocaleDateString('fr-FR')}`
          : '♾️ lifetime';
        const icon = lic.status === 'active' ? '✅' : '❌';
        return `${icon} <code>${lic.license_key}</code>\nPlan: ${lic.plan} — ${exp}\nAppareil: ${lic.device_name || 'non activée'}`;
      }).join('\n\n');

      await this.sendMessage(chatId, `📋 <b>Vos licences Avi Contrôle</b>\n\n${lines}`);
      return;
    }

    // ── Message inconnu ───────────────────────────────────
    await this.sendMessage(chatId,
      `Commandes disponibles :\n` +
      `/buy — Acheter une licence\n` +
      `/status — Voir vos licences`
    );
  }

  // ──────────────────────────────────────────
  //  Enregistrer le chat_id en BDD
  // ──────────────────────────────────────────

  async registerChatId(chatId: number, username?: string): Promise<void> {
    // Mettre à jour l'utilisateur si son username Telegram correspond
    if (username) {
      await pool.query(
        `UPDATE users SET telegram_chat_id=$1, updated_at=NOW()
         WHERE telegram_username=$2`,
        [chatId.toString(), username.toLowerCase()],
      );
    }

    // Sinon : créer un enregistrement temporaire (sera lié lors du paiement)
    await pool.query(
      `INSERT INTO telegram_pending (chat_id, username, created_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (chat_id) DO UPDATE SET username=$2, created_at=NOW()`,
      [chatId.toString(), username?.toLowerCase() ?? null],
    );

    console.log(`[TELEGRAM] Chat ID enregistré: ${chatId} (@${username})`);
  }

  // ──────────────────────────────────────────
  //  Trouver le chat_id depuis un username
  // ──────────────────────────────────────────

  async getChatIdByUsername(username: string): Promise<string | null> {
    const clean = username.replace('@', '').toLowerCase();

    // Chercher dans les users enregistrés
    const r1 = await pool.query(
      'SELECT telegram_chat_id FROM users WHERE telegram_username=$1',
      [clean],
    );
    if (r1.rows[0]?.telegram_chat_id) return r1.rows[0].telegram_chat_id;

    // Chercher dans la table pending (avant inscription)
    const r2 = await pool.query(
      'SELECT chat_id FROM telegram_pending WHERE username=$1',
      [clean],
    );
    return r2.rows[0]?.chat_id ?? null;
  }

  // ──────────────────────────────────────────
  //  Configurer le webhook Telegram
  // ──────────────────────────────────────────

  async setWebhook(serverUrl: string): Promise<void> {
    const webhookUrl = `${serverUrl}/api/telegram/webhook`;
    const res = await axios.post(`${API}/setWebhook`, { url: webhookUrl });
    console.log('[TELEGRAM] Webhook configuré:', res.data);
  }
}

export const telegramService = new TelegramService();
