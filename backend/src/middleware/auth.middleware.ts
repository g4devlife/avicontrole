import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config/config';

export function authenticateJwt(req: Request, res: Response, next: NextFunction) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Token manquant.' });

  try {
    const payload = jwt.verify(auth.split(' ')[1], config.jwt.secret);
    (req as any).user = payload;
    next();
  } catch {
    return res.status(401).json({ error: 'Token invalide ou expiré.' });
  }
}
