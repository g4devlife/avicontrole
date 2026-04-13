import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { pool } from '../database/db';
import { config } from '../config/config';

export const authRouter = Router();

// POST /api/auth/register
authRouter.post('/register', async (req: Request, res: Response) => {
  const { email, password, name } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email et password requis.' });

  const hash = await bcrypt.hash(password, 12);
  try {
    const result = await pool.query(
      'INSERT INTO users (email, password_hash, name) VALUES ($1,$2,$3) RETURNING id, email, name',
      [email.toLowerCase(), hash, name],
    );
    const user  = result.rows[0];
    const token = jwt.sign({ id: user.id, email: user.email }, config.jwt.secret, { expiresIn: config.jwt.expiresIn as any });
    return res.status(201).json({ token, user: { id: user.id, email: user.email, name: user.name } });
  } catch (err: any) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email déjà utilisé.' });
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// POST /api/auth/login
authRouter.post('/login', async (req: Request, res: Response) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email et password requis.' });

  const result = await pool.query('SELECT * FROM users WHERE email=$1', [email.toLowerCase()]);
  if (result.rows.length === 0) return res.status(401).json({ error: 'Identifiants incorrects.' });

  const user = result.rows[0];
  const ok   = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Identifiants incorrects.' });

  const token = jwt.sign({ id: user.id, email: user.email }, config.jwt.secret, { expiresIn: config.jwt.expiresIn as any });
  return res.json({ token, user: { id: user.id, email: user.email, name: user.name } });
});
