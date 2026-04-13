import crypto from 'crypto';
import { pool } from '../../database/db';
import { config } from '../../config/config';

export type LicensePlan = 'monthly' | 'yearly' | 'lifetime';

export interface License {
  id:                string;
  userId:            string;
  licenseKey:        string;
  plan:              LicensePlan;
  status:            'inactive' | 'active' | 'revoked' | 'expired';
  deviceFingerprint?: string;
  deviceName?:       string;
  activatedAt?:      Date;
  expiresAt?:        Date;
  createdAt:         Date;
}

export class LicenseService {

  // ──────────────────────────────────────────
  //  Génération clé HMAC
  // ──────────────────────────────────────────

  generateLicenseKey(userId: string, plan: LicensePlan): string {
    const ts       = Date.now().toString(36).toUpperCase();
    const userPart = userId.replace(/-/g, '').substring(0, 8).toUpperCase();
    const planCode = plan === 'monthly' ? 'M' : plan === 'yearly' ? 'Y' : 'L';
    const payload  = `${planCode}${userPart}${ts}`.substring(0, 13).padEnd(13, '0');
    const hmac     = crypto
      .createHmac('sha256', config.license.hmacSecret)
      .update(payload).digest('hex').substring(0, 8).toUpperCase();
    const full = `${payload}${hmac}`;
    return [
      full.substring(0, 5), full.substring(5, 9),
      full.substring(9, 13), full.substring(13, 17), full.substring(17, 21),
    ].join('-');
  }

  verifyKeyChecksum(licenseKey: string): boolean {
    const clean   = licenseKey.replace(/-/g, '');
    if (clean.length !== 21) return false;
    const payload  = clean.substring(0, 13);
    const checksum = clean.substring(13, 21);
    const expected = crypto
      .createHmac('sha256', config.license.hmacSecret)
      .update(payload).digest('hex').substring(0, 8).toUpperCase();
    return expected === checksum;
  }

  // ──────────────────────────────────────────
  //  Création en BDD
  // ──────────────────────────────────────────

  async createLicense(
    userId:    string,
    plan:      LicensePlan,
    paymentId?: string,
  ): Promise<License> {
    const licenseKey = this.generateLicenseKey(userId, plan);
    const expiresAt  = this.calcExpiry(plan);

    const result = await pool.query(
      `INSERT INTO licenses (user_id, license_key, plan, status, expires_at, payment_id)
       VALUES ($1, $2, $3, 'inactive', $4, $5)
       RETURNING *`,
      [userId, licenseKey, plan, expiresAt, paymentId || null],
    );

    return this.mapRow(result.rows[0]);
  }

  // ──────────────────────────────────────────
  //  Activation sur un appareil
  // ──────────────────────────────────────────

  async activateLicense(
    licenseKey:        string,
    deviceFingerprint: string,
    deviceName:        string,
  ): Promise<{ success: boolean; message: string; license?: License }> {

    if (!this.verifyKeyChecksum(licenseKey)) {
      return { success: false, message: 'Clé de licence invalide.' };
    }

    const result = await pool.query(
      'SELECT * FROM licenses WHERE license_key = $1',
      [licenseKey],
    );
    if (result.rows.length === 0) {
      return { success: false, message: 'Licence non trouvée.' };
    }

    const row = result.rows[0];

    if (row.status === 'revoked') {
      return { success: false, message: 'Cette licence a été révoquée.' };
    }
    if (row.expires_at && new Date(row.expires_at) < new Date()) {
      await pool.query("UPDATE licenses SET status='expired' WHERE id=$1", [row.id]);
      return { success: false, message: 'Cette licence a expiré.' };
    }

    if (row.device_fingerprint && row.device_fingerprint !== deviceFingerprint) {
      if (row.transfer_count >= row.max_transfers) {
        return { success: false, message: `Maximum ${row.max_transfers} appareils atteint.` };
      }
      await pool.query(
        `UPDATE licenses
         SET device_fingerprint=$1, device_name=$2,
             transfer_count=transfer_count+1, status='active',
             activated_at=NOW(), updated_at=NOW()
         WHERE id=$3`,
        [deviceFingerprint, deviceName, row.id],
      );
    } else {
      await pool.query(
        `UPDATE licenses
         SET device_fingerprint=$1, device_name=$2,
             status='active', activated_at=COALESCE(activated_at,NOW()), updated_at=NOW()
         WHERE id=$3`,
        [deviceFingerprint, deviceName, row.id],
      );
    }

    const updated = await pool.query('SELECT * FROM licenses WHERE id=$1', [row.id]);
    return { success: true, message: 'Licence activée avec succès.', license: this.mapRow(updated.rows[0]) };
  }

  // ──────────────────────────────────────────
  //  Validation session
  // ──────────────────────────────────────────

  async validateSession(
    licenseKey:        string,
    deviceFingerprint: string,
  ): Promise<{ valid: boolean; message: string }> {

    const result = await pool.query(
      'SELECT * FROM licenses WHERE license_key=$1',
      [licenseKey],
    );
    if (result.rows.length === 0) return { valid: false, message: 'Licence non trouvée.' };

    const row = result.rows[0];

    if (row.status !== 'active')
      return { valid: false, message: `Licence ${row.status}.` };

    if (row.device_fingerprint !== deviceFingerprint)
      return { valid: false, message: 'Appareil non autorisé.' };

    if (row.expires_at && new Date(row.expires_at) < new Date()) {
      await pool.query("UPDATE licenses SET status='expired' WHERE id=$1", [row.id]);
      return { valid: false, message: 'Licence expirée.' };
    }

    return { valid: true, message: 'OK' };
  }

  // ──────────────────────────────────────────
  //  Utilitaires
  // ──────────────────────────────────────────

  private calcExpiry(plan: LicensePlan): Date | null {
    if (plan === 'lifetime') return null;
    const d = new Date();
    if (plan === 'monthly') d.setMonth(d.getMonth() + 1);
    if (plan === 'yearly')  d.setFullYear(d.getFullYear() + 1);
    return d;
  }

  private mapRow(row: any): License {
    return {
      id:                row.id,
      userId:            row.user_id,
      licenseKey:        row.license_key,
      plan:              row.plan,
      status:            row.status,
      deviceFingerprint: row.device_fingerprint,
      deviceName:        row.device_name,
      activatedAt:       row.activated_at ? new Date(row.activated_at) : undefined,
      expiresAt:         row.expires_at   ? new Date(row.expires_at)   : undefined,
      createdAt:         new Date(row.created_at),
    };
  }
}

export const licenseService = new LicenseService();
