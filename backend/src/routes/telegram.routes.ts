import { Router, Request, Response } from 'express';
import { telegramService } from '../modules/telegram/telegram.service';
import { config } from '../config/config';

export const telegramRouter = Router();

// POST /api/telegram/webhook  — Mises à jour du bot Telegram
telegramRouter.post('/webhook', async (req: Request, res: Response) => {
  // Vérifier le secret token pour sécuriser le webhook
  const token = req.headers['x-telegram-bot-api-secret-token'];
  if (token !== config.telegram.webhookSecret) {
    return res.status(403).json({ error: 'Non autorisé' });
  }

  try {
    await telegramService.handleUpdate(req.body);
    return res.json({ ok: true });
  } catch (err: any) {
    console.error('[TELEGRAM WEBHOOK]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/telegram/setup-webhook  — Configurer le webhook (appel unique au déploiement)
telegramRouter.post('/setup-webhook', async (req: Request, res: Response) => {
  const { serverUrl } = req.body;
  if (!serverUrl) return res.status(400).json({ error: 'serverUrl requis' });

  try {
    await telegramService.setWebhook(serverUrl);
    return res.json({ ok: true, webhook: `${serverUrl}/api/telegram/webhook` });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});
