import { Router, Request, Response } from 'express';
import { licenseService } from '../modules/license/license.service';
import { pool } from '../database/db';
import { authenticateJwt } from '../middleware/auth.middleware';

export const licenseRouter = Router();

// POST /api/license/activate  — App Android : activer la licence sur l'appareil
licenseRouter.post('/activate', async (req: Request, res: Response) => {
  const { licenseKey, deviceFingerprint, deviceName } = req.body;

  if (!licenseKey || !deviceFingerprint) {
    return res.status(400).json({ error: 'licenseKey et deviceFingerprint requis.' });
  }

  const result = await licenseService.activateLicense(licenseKey, deviceFingerprint, deviceName || 'Android');
  return res.status(result.success ? 200 : 400).json(result);
});

// POST /api/license/validate  — Vérification à chaque démarrage de session
licenseRouter.post('/validate', async (req: Request, res: Response) => {
  const { licenseKey, deviceFingerprint } = req.body;

  if (!licenseKey || !deviceFingerprint) {
    return res.status(400).json({ valid: false, message: 'Paramètres manquants.' });
  }

  const result = await licenseService.validateSession(licenseKey, deviceFingerprint);
  return res.status(result.valid ? 200 : 403).json(result);
});

// GET /api/license/my  — Utilisateur connecté : voir ses licences
licenseRouter.get('/my', authenticateJwt, async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  const result = await pool.query(
    'SELECT * FROM licenses WHERE user_id=$1 ORDER BY created_at DESC',
    [userId],
  );
  return res.json({ licenses: result.rows });
});

// POST /api/license/verify-key  — Vérification checksum sans BDD (pour UI)
licenseRouter.post('/verify-key', (req: Request, res: Response) => {
  const { licenseKey } = req.body;
  const valid = licenseKey ? licenseService.verifyKeyChecksum(licenseKey) : false;
  return res.json({ valid });
});
