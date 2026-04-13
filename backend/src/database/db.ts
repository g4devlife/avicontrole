import { Pool } from 'pg';
import { config } from '../config/config';

export const pool = new Pool({ connectionString: config.database.url });

pool.on('error', (err) => console.error('[DB] Erreur pool PostgreSQL:', err));

export async function query(text: string, params?: any[]) {
  const client = await pool.connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}
