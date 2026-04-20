import { app, BrowserWindow, ipcMain, safeStorage, shell } from 'electron';
import path from 'path';
import fs from 'fs';
import https from 'https';
import http from 'http';
import { randomUUID } from 'crypto';

const isDev      = !app.isPackaged;
const SERVER_URL = process.env.SERVER_URL || 'https://api.avicontrole.app';

let mainWindow: BrowserWindow | null = null;

// ── Chemins de stockage ──────────────────────────────────────
const LICENSE_FILE  = path.join(app.getPath('userData'), 'lic.dat');
const IDENTITY_FILE = path.join(app.getPath('userData'), 'identity.json');

// ── Identity PC (pcAccountId + pairingCode) ──────────────────
interface Identity { pcAccountId: string; pairingCode: string; }

function loadIdentity(): Identity {
  try {
    if (fs.existsSync(IDENTITY_FILE)) {
      return JSON.parse(fs.readFileSync(IDENTITY_FILE, 'utf8'));
    }
  } catch {}
  const identity: Identity = {
    pcAccountId:  randomUUID(),
    pairingCode:  String(Math.floor(10000 + Math.random() * 90000)),
  };
  fs.writeFileSync(IDENTITY_FILE, JSON.stringify(identity), 'utf8');
  return identity;
}

// ── Licence chiffrée (safeStorage) ───────────────────────────
interface LicenseData { key: string; pcAccountId: string; validatedAt: number; }

function saveLicense(data: LicenseData): void {
  if (!safeStorage.isEncryptionAvailable()) {
    fs.writeFileSync(LICENSE_FILE, JSON.stringify(data), 'utf8');
    return;
  }
  const encrypted = safeStorage.encryptString(JSON.stringify(data));
  fs.writeFileSync(LICENSE_FILE, encrypted);
}

function loadLicense(): LicenseData | null {
  try {
    if (!fs.existsSync(LICENSE_FILE)) return null;
    const buf = fs.readFileSync(LICENSE_FILE);
    if (!safeStorage.isEncryptionAvailable()) return JSON.parse(buf.toString('utf8'));
    return JSON.parse(safeStorage.decryptString(buf));
  } catch {
    return null;
  }
}

function deleteLicense(): void {
  try { fs.unlinkSync(LICENSE_FILE); } catch {}
}

// ── Requête HTTP(S) depuis le main process ───────────────────
function apiPost(url: string, body: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const data    = JSON.stringify(body);
    const parsed  = new URL(url);
    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    };
    const req = (parsed.protocol === 'https:' ? https : http).request(options, (res) => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch { reject(new Error('Réponse invalide du serveur')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(new Error('Timeout')); });
    req.write(data);
    req.end();
  });
}

// ── Fenêtre principale ───────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width:           1100,
    height:          750,
    minWidth:        800,
    minHeight:       600,
    frame:           false,
    titleBarStyle:   'hidden',
    backgroundColor: '#0f0f1a',
    webPreferences: {
      preload:          path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
    icon: path.join(__dirname, '../../assets/icon.png'),
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    // DevTools désactivés en prod — ne pas les ouvrir ici
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ── IPC : fenêtre ────────────────────────────────────────────
ipcMain.on('window:minimize', () => mainWindow?.minimize());
ipcMain.on('window:maximize', () => {
  mainWindow?.isMaximized() ? mainWindow.unmaximize() : mainWindow?.maximize();
});
ipcMain.on('window:close', () => mainWindow?.close());
ipcMain.on('open-external', (_e, url: string) => shell.openExternal(url));

// ── IPC : identité PC ────────────────────────────────────────
ipcMain.handle('identity:get', () => loadIdentity());

// ── IPC : enregistrer le code d'appairage ────────────────────
ipcMain.handle('pair:register', async (_e, { pairingCode, pcAccountId }: { pairingCode: string; pcAccountId: string }) => {
  try {
    await apiPost(`${SERVER_URL}/api/pair/register`, { pairingCode, pcAccountId });
  } catch {
    // silencieux — réessai automatique
  }
});

// ── IPC : activer la licence ─────────────────────────────────
ipcMain.handle('license:activate', async (_e, { key, deviceName }: { key: string; deviceName: string }) => {
  const identity = loadIdentity();
  try {
    const data = await apiPost(`${SERVER_URL}/api/license/activate`, {
      licenseKey:        key,
      deviceFingerprint: identity.pcAccountId,
      deviceName,
    });

    if (data.success) {
      saveLicense({ key, pcAccountId: identity.pcAccountId, validatedAt: Date.now() });
      return { success: true };
    }
    return { success: false, message: data.message || 'Clé invalide.' };
  } catch {
    return { success: false, message: 'Serveur inaccessible. Vérifiez votre connexion.' };
  }
});

// ── IPC : vérifier la licence au démarrage ───────────────────
ipcMain.handle('license:check', async () => {
  const identity = loadIdentity();
  const stored   = loadLicense();

  // Aucune licence sauvegardée
  if (!stored || stored.pcAccountId !== identity.pcAccountId) {
    return { valid: false };
  }

  // Validation distante
  try {
    const data = await apiPost(`${SERVER_URL}/api/license/validate`, {
      licenseKey:        stored.key,
      deviceFingerprint: identity.pcAccountId,
    });

    if (data.valid) {
      saveLicense({ ...stored, validatedAt: Date.now() });
      return { valid: true };
    }

    // Révoquée ou expirée
    deleteLicense();
    return { valid: false, message: data.message || 'Licence expirée ou révoquée.' };

  } catch {
    // Serveur inaccessible — grace period 7 jours max
    const daysSince = (Date.now() - stored.validatedAt) / 86_400_000;
    if (daysSince < 7) {
      return { valid: true, offline: true };
    }
    deleteLicense();
    return { valid: false, message: 'Connexion requise pour valider la licence (7 jours hors ligne atteints).' };
  }
});
