import { Router, Request, Response } from 'express';

export const pairingRouter = Router();

// Code → { pcAccountId, registeredAt }
const pairingCodes = new Map<string, { pcAccountId: string; registeredAt: number }>();

// POST /api/pair/register  — le PC enregistre son code
pairingRouter.post('/register', (req: Request, res: Response) => {
  const { pairingCode, pcAccountId } = req.body as { pairingCode?: string; pcAccountId?: string };

  if (!pairingCode || !/^\d{5}$/.test(pairingCode)) {
    res.status(400).json({ error: 'Code invalide (5 chiffres requis)' });
    return;
  }
  if (!pcAccountId || typeof pcAccountId !== 'string') {
    res.status(400).json({ error: 'pcAccountId manquant' });
    return;
  }

  pairingCodes.set(pairingCode, { pcAccountId, registeredAt: Date.now() });
  console.log(`[PAIR] PC enregistré — code: ${pairingCode} id: ${pcAccountId.slice(0, 8)}…`);
  res.json({ ok: true });
});

// POST /api/pair/verify  — l'Android vérifie le code et obtient le pcAccountId
pairingRouter.post('/verify', (req: Request, res: Response) => {
  const { pairingCode } = req.body as { pairingCode?: string };

  if (!pairingCode || !/^\d{5}$/.test(pairingCode)) {
    res.status(400).json({ error: 'Code invalide' });
    return;
  }

  const entry = pairingCodes.get(pairingCode);
  if (!entry) {
    res.status(404).json({ error: 'Code introuvable. Vérifiez le code affiché sur votre PC.' });
    return;
  }

  res.json({ ok: true, pcAccountId: entry.pcAccountId });
});

// Nettoyer les codes inactifs depuis plus de 7 jours
setInterval(() => {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const [code, entry] of pairingCodes.entries()) {
    if (entry.registeredAt < cutoff) pairingCodes.delete(code);
  }
}, 60 * 60 * 1000);
