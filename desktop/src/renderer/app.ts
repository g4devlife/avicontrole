import { SignalingClient } from './webrtc/SignalingClient';
import { WebRTCClient } from './webrtc/WebRTCClient';

const eAPI = (window as any).electronAPI;

// ══════════════════════════════════════════════════════
//  REGISTRE DES APPAREILS (persistant)
// ══════════════════════════════════════════════════════

interface SavedDevice {
  fp:       string;
  ip:       string;
  label:    string;
  lastSeen: number;
}

function loadRegistry(): Map<string, SavedDevice> {
  try {
    const raw = localStorage.getItem('avicontrole_devices') ?? '[]';
    const arr = JSON.parse(raw) as SavedDevice[];
    return new Map(arr.map(d => [d.fp, d]));
  } catch { return new Map(); }
}

function saveRegistry(reg: Map<string, SavedDevice>): void {
  localStorage.setItem('avicontrole_devices', JSON.stringify([...reg.values()]));
}

function upsertDevice(fp: string, ip: string): void {
  const reg = loadRegistry();
  const ex  = reg.get(fp);
  reg.set(fp, { fp, ip, label: ex?.label ?? `Téléphone ${reg.size + 1}`, lastSeen: Date.now() });
  saveRegistry(reg);
}

function getDeviceLabel(fp: string): string {
  return loadRegistry().get(fp)?.label ?? fp.slice(0, 8) + '…';
}

function getDeviceIp(fp: string): string {
  return loadRegistry().get(fp)?.ip ?? '';
}

let MY_PC_ID     = '';
let PAIRING_CODE = '';

// ══════════════════════════════════════════════════════
//  ÉCRAN LICENCE
// ══════════════════════════════════════════════════════

const licScreen = document.getElementById('license-screen')!;
const licInput  = document.getElementById('lic-input')    as HTMLInputElement;
const licBtn    = document.getElementById('lic-btn')      as HTMLButtonElement;
const licError  = document.getElementById('lic-error')    as HTMLDivElement;
const licStatus = document.getElementById('lic-status')   as HTMLDivElement;

(window as any).onLicInput = (el: HTMLInputElement) => {
  const v     = el.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const parts = [v.slice(0,5), v.slice(5,9), v.slice(9,13), v.slice(13,17), v.slice(17,21)];
  el.value = parts.filter(p => p).join('-');
  licError.textContent = '';
  licBtn.disabled = v.length !== 21;
};

(window as any).submitLicense = async () => {
  const key = licInput.value.trim().toUpperCase();
  licBtn.disabled       = true;
  licError.textContent  = '';
  licStatus.textContent = 'Vérification en cours…';
  licStatus.className   = 'lic-status';

  try {
    const result = await eAPI.activateLicense(key, `PC — ${navigator.platform || 'Windows'}`);
    if (result.success) {
      licStatus.textContent = '✓ Licence activée !';
      licStatus.className   = 'lic-status ok';
      setTimeout(() => { licScreen.classList.add('hidden'); startApp(); }, 800);
    } else {
      licError.textContent  = result.message || 'Clé invalide.';
      licStatus.textContent = '';
      licBtn.disabled       = false;
    }
  } catch (err: any) {
    licError.textContent  = err?.message || 'Erreur de communication avec le serveur.';
    licStatus.textContent = '';
    licBtn.disabled       = false;
  }
};

// ══════════════════════════════════════════════════════
//  INITIALISATION
// ══════════════════════════════════════════════════════

async function init() {
  try {
    const identity = await eAPI.getIdentity();
    MY_PC_ID     = identity.pcAccountId;
    PAIRING_CODE = identity.pairingCode;

    const pcCodeEl = document.getElementById('pc-code');
    if (pcCodeEl && PAIRING_CODE) pcCodeEl.textContent = PAIRING_CODE;

    const licCheck = await eAPI.checkLicense();
    if (licCheck.valid) {
      licScreen.classList.add('hidden');
      startApp();
    } else {
      if (licCheck.message) licError.textContent = licCheck.message;
    }
  } catch (err: any) {
    licError.textContent = 'Erreur d\'initialisation : ' + (err?.message || err);
  }
}

// ══════════════════════════════════════════════════════
//  CONNEXION PERSISTANTE DE GESTION
// ══════════════════════════════════════════════════════

const managementClient = new SignalingClient();

async function startApp() {
  const pcCodeEl = document.getElementById('pc-code');
  if (pcCodeEl && PAIRING_CODE) pcCodeEl.textContent = PAIRING_CODE;

  eAPI.registerPair(PAIRING_CODE, MY_PC_ID);
  setInterval(() => eAPI.registerPair(PAIRING_CODE, MY_PC_ID), 30_000);

  try {
    await managementClient.connect();
    managementClient.register(MY_PC_ID);

    managementClient.on('desktop:phone-available', (data: { sessionCode: string; deviceFP: string; localIp?: string }) => {
      addAvailablePhone(data.sessionCode, data.deviceFP, data.localIp ?? '');
    });

    managementClient.on('desktop:phone-disconnected', (data: { sessionCode: string }) => {
      markPhoneUnavailable(data.sessionCode);
    });

    managementClient.on('desktop:sessions-list', (data: { sessions: Array<{ sessionCode: string; deviceFP: string; localIp?: string }> }) => {
      syncPhoneList(data.sessions);
    });

    // Fallback : hiérarchie reçue via le socket de gestion (quand session socket déconnectée)
    managementClient.on('android:internal-event', (data: any) => {
      if (data?.type !== 'ui_hierarchy') return;
      // Trouver la session active correspondante
      for (const s of sessions.values()) {
        if (s.connected) { renderHierarchy(s.uiTreeEl, data); break; }
      }
    });

    setRefreshStatus('connected');
  } catch {
    setRefreshStatus('error');
  }
}

// ══════════════════════════════════════════════════════
//  ACTUALISATION
// ══════════════════════════════════════════════════════

(window as any).refreshPhones = () => {
  managementClient.listSessions(MY_PC_ID);
  const btn = document.getElementById('btn-refresh') as HTMLButtonElement;
  if (btn) { btn.textContent = '⟳ Actualisation…'; btn.disabled = true; }
  setTimeout(() => {
    if (btn) { btn.textContent = '⟳ Actualiser'; btn.disabled = false; }
  }, 1500);
};

function setRefreshStatus(state: 'connected' | 'error') {
  const dot = document.getElementById('server-dot');
  if (!dot) return;
  dot.style.background = state === 'connected' ? '#10b981' : '#ef4444';
  dot.title = state === 'connected' ? 'Serveur connecté' : 'Serveur inaccessible';
}

// ══════════════════════════════════════════════════════
//  SESSIONS TÉLÉPHONES
// ══════════════════════════════════════════════════════

interface PhoneSession {
  code:      string;
  deviceFP:  string;
  signaling: SignalingClient;
  webrtc:    WebRTCClient;
  videoEl:   HTMLVideoElement;
  viewEl:    HTMLDivElement;
  tabEl:     HTMLDivElement;
  toolbarEl: HTMLDivElement;
  uiTreeEl:  HTMLDivElement;
  connected: boolean;
}

interface AvailablePhone {
  sessionCode: string;
  deviceFP:    string;
  localIp:     string;
}

const sessions        = new Map<string, PhoneSession>();
const availablePhones = new Map<string, AvailablePhone>();

// deviceFP → dernière sessionCode connue (pour auto-reconnexion)
const knownDevices = new Map<string, string>();

let activeCode: string | null = null;

const phoneList  = document.getElementById('phone-list')  as HTMLDivElement;
const phoneCount = document.getElementById('phone-count') as HTMLSpanElement;
const tabsEl     = document.getElementById('tabs')        as HTMLDivElement;
const viewerArea = document.getElementById('viewer-area') as HTMLDivElement;
const noPhone    = document.getElementById('no-phone')    as HTMLDivElement;

// ── Ajouter un téléphone disponible ────────────────────
function addAvailablePhone(sessionCode: string, deviceFP: string, localIp = '') {
  upsertDevice(deviceFP, localIp);
  if (availablePhones.has(sessionCode) || sessions.has(sessionCode)) return;

  // Auto-reconnexion : si on connaît cet appareil et qu'il a une session déconnectée
  const prevCode = knownDevices.get(deviceFP);
  if (prevCode) {
    const prevSession = sessions.get(prevCode);
    if (prevSession && !prevSession.connected) {
      // Le téléphone est revenu → reconnexion automatique en un clic
      const wasActive = activeCode === prevCode;
      removeSilent(prevCode);
      doConnectPhone(sessionCode, deviceFP, wasActive);
      return;
    }
  }

  availablePhones.set(sessionCode, { sessionCode, deviceFP, localIp });
  renderAvailablePhone(sessionCode, deviceFP);
  updateCounter();
}

function markPhoneUnavailable(sessionCode: string) {
  availablePhones.delete(sessionCode);
  document.getElementById(`avail-${sessionCode}`)?.remove();
  updateCounter();
  if (sessions.has(sessionCode)) handleDisconnect(sessionCode, 'Téléphone déconnecté');
}

function syncPhoneList(list: Array<{ sessionCode: string; deviceFP: string; localIp?: string }>) {
  for (const [code] of availablePhones) {
    if (!list.find(s => s.sessionCode === code)) markPhoneUnavailable(code);
  }
  for (const s of list) addAvailablePhone(s.sessionCode, s.deviceFP, s.localIp ?? '');
}

// ── Rendu d'un téléphone disponible (un clic = connexion) ──
function renderAvailablePhone(sessionCode: string, deviceFP: string) {
  const label = getDeviceLabel(deviceFP);
  const ip    = getDeviceIp(deviceFP);
  const itemEl = document.createElement('div');
  itemEl.className    = 'phone-item available';
  itemEl.id           = `avail-${sessionCode}`;
  itemEl.style.cursor = 'pointer';
  itemEl.innerHTML = `
    <div class="phone-code">📱 ${label}</div>
    ${ip ? `<div style="font-size:10px;color:#475569;margin-top:1px">${ip}</div>` : ''}
    <div class="phone-status" style="color:#38bdf8;font-size:11px;">
      <span class="pulsing">●</span>&nbsp;Disponible — cliquer pour connecter
    </div>`;
  itemEl.onclick = () => (window as any).connectPhone(sessionCode);
  phoneList.appendChild(itemEl);
}

// ══════════════════════════════════════════════════════
//  CONNEXION
// ══════════════════════════════════════════════════════

(window as any).connectPhone = async (sessionCode: string) => {
  if (sessions.has(sessionCode)) { switchTo(sessionCode); return; }

  document.getElementById(`avail-${sessionCode}`)?.remove();
  const avail    = availablePhones.get(sessionCode);
  const deviceFP = avail?.deviceFP || '';
  availablePhones.delete(sessionCode);

  doConnectPhone(sessionCode, deviceFP, true);
};

async function doConnectPhone(sessionCode: string, deviceFP: string, autoSwitch: boolean) {
  upsertDevice(deviceFP, getDeviceIp(deviceFP)); // refresh lastSeen
  const session = createSession(sessionCode, deviceFP);
  knownDevices.set(deviceFP, sessionCode);

  try {
    await session.signaling.connect();
    session.signaling.joinSession(sessionCode, MY_PC_ID);
    setTabStatus(session, 'connecting');

    session.signaling.on('desktop:joined', async () => {
      session.webrtc.onStream = (stream) => {
        session.videoEl.srcObject = stream;
        session.videoEl.play().catch(console.error);
        session.videoEl.classList.add('visible');
        (session.viewEl.querySelector('.phone-placeholder') as HTMLElement).style.display = 'none';
        session.toolbarEl.classList.add('visible');
        session.connected = true;
        setTabStatus(session, 'connected');
        updateSidebarItem(session);
      };
      session.webrtc.onDisconnect = () => handleDisconnect(sessionCode, 'Déconnecté');
      await session.webrtc.connect(session.videoEl);
    });

    session.signaling.on('android:clipboard', (data: { content: string }) => {
      if (data.content) navigator.clipboard.writeText(data.content).catch(() => {});
    });
    session.signaling.on('android:internal-event', (data: any) => {
      if (data?.type === 'ui_hierarchy') renderHierarchy(session.uiTreeEl, data);
    });
    session.signaling.on('session:ended', () => handleDisconnect(sessionCode, 'Session terminée'));
    session.signaling.on('error', (data: { message: string }) => {
      handleDisconnect(sessionCode, data.message);
    });

    if (autoSwitch) switchTo(sessionCode);
  } catch (err) {
    console.error(err);
    removeSession(sessionCode);
  }
}

// ══════════════════════════════════════════════════════
//  CRÉATION SESSION + ÉLÉMENTS DOM
// ══════════════════════════════════════════════════════

function createSession(code: string, deviceFP: string): PhoneSession {
  const signaling = new SignalingClient();
  const webrtc    = new WebRTCClient(signaling);

  // Vue principale
  const viewEl = document.createElement('div');
  viewEl.className    = 'phone-view';
  viewEl.dataset.code = code;

  // Zone vidéo (flex: 1 — ne laisse plus la toolbar flotter dessus)
  const videoAreaEl = document.createElement('div');
  videoAreaEl.className = 'phone-video-area';
  videoAreaEl.innerHTML = `
    <div class="phone-placeholder">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
        <rect x="5" y="2" width="14" height="20" rx="2"/>
        <circle cx="12" cy="18" r="1"/>
      </svg>
      <p class="pulsing" style="color:#a78bfa;font-size:12px">Connexion en cours…</p>
    </div>`;
  viewEl.appendChild(videoAreaEl);

  const videoEl = document.createElement('video');
  videoEl.className   = 'phone-video';
  videoEl.autoplay    = true;
  videoEl.playsInline = true;
  videoAreaEl.appendChild(videoEl);

  const toolbarEl = document.createElement('div');
  toolbarEl.className = 'phone-toolbar';
  toolbarEl.innerHTML = `
    <div class="toolbar-row">
      <button class="tool-btn" onclick="sendKey('${code}','back')" title="Retour">◀</button>
      <button class="tool-btn" onclick="sendKey('${code}','home')" title="Accueil">⌂</button>
      <button class="tool-btn" onclick="sendKey('${code}','recents')" title="Récents">⧉</button>
      <div class="tool-sep"></div>
      <button class="tool-btn" onclick="sendKey('${code}','notifications')" title="Notifications">🔔</button>
      <button class="tool-btn" onclick="sendKey('${code}','quick:settings')" title="Params rapides">⚙</button>
      <button class="tool-btn" onclick="sendKey('${code}','screenshot')" title="Capture écran">📷</button>
      <button class="tool-btn" onclick="sendKey('${code}','lock')" title="Verrouiller">🔒</button>
      <button class="tool-btn" onclick="wakeScreen('${code}')" title="Rallumer écran">☀</button>
      <div class="tool-sep"></div>
      <button class="tool-btn" onclick="toggleUIPanel('${code}')" title="Structure UI (Accessibilité)">🔍 UI</button>
    </div>
    <div class="toolbar-row">
      <button class="tool-btn" onclick="sendKey('${code}','volume:down')" title="Volume -">🔉</button>
      <button class="tool-btn" onclick="sendKey('${code}','volume:up')" title="Volume +">🔊</button>
      <button class="tool-btn" onclick="sendKey('${code}','volume:mute')" title="Muet">🔇</button>
      <div class="tool-sep"></div>
      <button class="tool-btn" onclick="sendKey('${code}','media:prev')" title="Précédent">⏮</button>
      <button class="tool-btn" onclick="sendKey('${code}','media:play')" title="Lecture / Pause">⏯</button>
      <button class="tool-btn" onclick="sendKey('${code}','media:next')" title="Suivant">⏭</button>
      <button class="tool-btn" onclick="sendKey('${code}','media:stop')" title="Stop">⏹</button>
      <div class="tool-sep"></div>
      <span class="fps-badge" id="fps-${code}"></span>
    </div>`;
  viewEl.appendChild(toolbarEl);
  viewerArea.appendChild(viewEl);

  // Onglet
  const tabEl = document.createElement('div');
  tabEl.className    = 'tab';
  tabEl.dataset.code = code;
  tabEl.onclick = () => switchTo(code);
  tabEl.innerHTML = `
    <span class="tab-dot pulsing" style="background:#f59e0b"></span>
    <span>📱 ${code.slice(0, 6)}</span>
    <span class="tab-close" onclick="removeSession('${code}');event.stopPropagation()">✕</span>`;
  tabsEl.appendChild(tabEl);

  // Sidebar item
  const itemEl = document.createElement('div');
  itemEl.className = 'phone-item connecting';
  itemEl.id        = `item-${code}`;
  itemEl.onclick   = () => switchTo(code);
  const _label = getDeviceLabel(deviceFP);
  const _ip    = getDeviceIp(deviceFP);
  itemEl.innerHTML = `
    <div class="phone-code">📱 ${_label}</div>
    ${_ip ? `<div class="phone-ip">${_ip}</div>` : ''}
    <div class="phone-status connecting"><span class="pulsing">●</span> Connexion…</div>
    <button class="btn-close-phone" onclick="removeSession('${code}');event.stopPropagation()">✕</button>`;
  phoneList.appendChild(itemEl);

  // ── Panneau hiérarchie UI (Accessibilité) ─────────────
  const uiTreeEl = document.createElement('div');
  uiTreeEl.className    = 'ui-tree-panel';
  uiTreeEl.dataset.code = code;
  uiTreeEl.innerHTML = `
    <div class="ui-tree-header">
      <span class="ui-tree-title">Structure UI</span>
      <span class="ui-tree-pkg" id="ui-pkg-${code}"></span>
      <button class="ui-tree-btn" onclick="refreshUI('${code}')" title="Rafraîchir">↺</button>
      <button class="ui-tree-btn" onclick="toggleUIPanel('${code}')" title="Fermer">✕</button>
    </div>
    <div class="ui-quick-section" id="ui-quick-${code}"></div>
    <div class="ui-tree-body" id="ui-body-${code}">
      <div class="ui-tree-empty">Cliquez sur ↺ pour analyser l'écran</div>
    </div>`;
  viewEl.appendChild(uiTreeEl);

  // ── Panneau champs de saisie ──────────────────────────
  const fieldsPanel = document.createElement('div');
  fieldsPanel.className = 'fields-panel';
  fieldsPanel.innerHTML = '<div class="fields-panel-title">Champs détectés</div>';
  viewEl.appendChild(fieldsPanel);

  signaling.on('android:fields', (data: { fields: Array<{id:number;text:string;hint:string;type:string;focused:boolean}> }) => {
    updateFieldsPanel(fieldsPanel, code, data.fields ?? []);
  });

  // ── Événements souris (touch) ──────────────────────────
  videoEl.addEventListener('mousedown',  (e) => { if (e.button === 0) sendTouch(code, e, 'down'); });
  videoEl.addEventListener('mousemove',  (e) => { if (e.buttons === 1) sendTouch(code, e, 'move'); });
  videoEl.addEventListener('mouseup',    (e) => { if (e.button === 0) sendTouch(code, e, 'up'); });
  videoEl.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const s = sessions.get(code);
    if (!s?.connected) return;
    const rect = videoEl.getBoundingClientRect();
    s.signaling.sendControlEvent({
      type: 'longpress',
      x: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (e.clientY - rect.top)  / rect.height)),
    });
  });

  // ── Trackpad & molette : scroll fluide ────────────────
  // Accumulateur par session pour éviter le flood réseau
  let accumDx = 0, accumDy = 0, accumX = 0, accumY = 0;
  let rafId: number | null = null;

  videoEl.addEventListener('wheel', (e) => {
    e.preventDefault();
    const s = sessions.get(code);
    if (!s?.connected) return;

    const rect = videoEl.getBoundingClientRect();
    const x    = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const y    = Math.max(0, Math.min(1, (e.clientY - rect.top)  / rect.height));

    // deltaMode : 0=pixel, 1=ligne, 2=page
    const mult = e.deltaMode === 0 ? 1 : e.deltaMode === 1 ? 40 : 500;

    // Pinch-to-zoom : geste trackpad (ctrlKey injecté par le navigateur) ou Ctrl+molette
    if (e.ctrlKey) {
      s.signaling.sendControlEvent({ type: 'pinch', scale: e.deltaY < 0 ? 1.5 : 0.67, x, y });
      return;
    }

    // Détection trackpad vs molette mécanique :
    //   Trackpad  → deltaMode=0, petites valeurs absolues (<50 px par événement)
    //   Molette   → deltaMode=0 ou 1, grandes valeurs (≥50 ou deltaMode≠0)
    const absY      = Math.abs(e.deltaY * mult);
    const isTrackpad = e.deltaMode === 0 && absY < 50;

    // Sensibilité adaptée : trackpad génère beaucoup d'événements → on booste moins
    // Molette génère peu d'événements avec grands deltas → on réduit davantage
    const sensitivity = isTrackpad ? 2.5 : 0.4;

    accumDx += -(e.deltaX * mult * sensitivity) / 1000;
    accumDy += -(e.deltaY * mult * sensitivity) / 1000;
    accumX   = x;
    accumY   = y;

    // Envoi groupé via requestAnimationFrame (≈16 ms, 60 fps max)
    if (!rafId) {
      rafId = requestAnimationFrame(() => {
        const s2 = sessions.get(code);
        if (s2?.connected) {
          s2.signaling.sendControlEvent({
            type: 'scroll',
            dx: accumDx,
            dy: accumDy,
            x:  accumX,
            y:  accumY,
          });
        }
        accumDx = 0; accumDy = 0; rafId = null;
      });
    }
  }, { passive: false });

  const session: PhoneSession = {
    code, deviceFP, signaling, webrtc, videoEl, viewEl, tabEl, toolbarEl, uiTreeEl, connected: false,
  };
  sessions.set(code, session);
  updateCounter();
  return session;
}

// ══════════════════════════════════════════════════════
//  NAVIGATION
// ══════════════════════════════════════════════════════

function switchTo(code: string) {
  activeCode = code;
  document.querySelectorAll<HTMLDivElement>('.phone-view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll<HTMLDivElement>('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll<HTMLDivElement>('.phone-item').forEach(i => i.classList.remove('active'));
  const s = sessions.get(code);
  if (!s) return;
  s.viewEl.classList.add('active');
  s.tabEl.classList.add('active');
  document.getElementById(`item-${code}`)?.classList.add('active');
  noPhone.style.display = 'none';
}

// Suppression silencieuse (sans déclencher de switchTo parasite)
function removeSilent(code: string) {
  const s = sessions.get(code);
  if (!s) return;
  s.webrtc.disconnect();
  s.signaling.disconnect();
  s.viewEl.remove();
  s.tabEl.remove();
  document.getElementById(`item-${code}`)?.remove();
  sessions.delete(code);
  updateCounter();
}

(window as any).removeSession = (code: string) => {
  const s = sessions.get(code);
  if (!s) return;
  removeSilent(code);
  if (activeCode === code) {
    activeCode = null;
    const next = sessions.keys().next().value;
    if (next) switchTo(next as string);
    else noPhone.style.display = 'flex';
  }
};

// ══════════════════════════════════════════════════════
//  GESTION DÉCONNEXION (session reste visible)
// ══════════════════════════════════════════════════════

function handleDisconnect(code: string, reason: string) {
  const s = sessions.get(code);
  if (!s) return;
  s.connected = false;
  s.toolbarEl.classList.remove('visible');
  setTabStatus(s, 'disconnected');
  updateSidebarItem(s, reason);
  // La session reste dans la map → réapparaîtra automatiquement quand le téléphone revient
}

// ══════════════════════════════════════════════════════
//  UI HELPERS
// ══════════════════════════════════════════════════════

function setTabStatus(s: PhoneSession, state: 'connecting' | 'connected' | 'disconnected') {
  const dot = s.tabEl.querySelector('.tab-dot') as HTMLSpanElement;
  if (state === 'connected')    { dot.style.background = '#10b981'; dot.classList.remove('pulsing'); }
  if (state === 'connecting')   { dot.style.background = '#f59e0b'; dot.classList.add('pulsing');    }
  if (state === 'disconnected') { dot.style.background = '#ef4444'; dot.classList.remove('pulsing'); }
}

function updateSidebarItem(s: PhoneSession, label?: string) {
  const item = document.getElementById(`item-${s.code}`);
  if (!item) return;
  const statusEl = item.querySelector('.phone-status') as HTMLDivElement;
  if (s.connected) {
    item.classList.remove('connecting');
    statusEl.className = 'phone-status';
    statusEl.innerHTML = '<span>●</span> Connecté';
  } else {
    statusEl.className = 'phone-status connecting';
    statusEl.innerHTML = `<span>●</span> ${label || 'Déconnecté'} — en attente…`;
  }
}

function updateCounter() {
  const total = sessions.size + availablePhones.size;
  phoneCount.textContent = String(total);
}

// ══════════════════════════════════════════════════════
//  CONTRÔLES CLAVIER & TOUCH
// ══════════════════════════════════════════════════════

(window as any).sendKey = (code: string, type: string) => {
  sessions.get(code)?.signaling.sendControlEvent({ type: type as any });
};

(window as any).wakeScreen = (code: string) => {
  sessions.get(code)?.signaling.sendControlEvent({ type: 'screen:wake' });
};

// ── Panneau champs : mise à jour et envoi ─────────────────────────────────

function updateFieldsPanel(
  panel: HTMLDivElement,
  code: string,
  fields: Array<{id: number; text: string; hint: string; type: string; focused: boolean}>
) {
  if (fields.length === 0) {
    panel.classList.remove('visible');
    return;
  }
  panel.classList.add('visible');
  panel.innerHTML = '<div class="fields-panel-title">Champs détectés</div>';

  fields.forEach(f => {
    const item = document.createElement('div');
    item.className = 'field-item';
    const label = f.hint || `Champ ${f.id + 1}`;
    const inputId = `field-${code}-${f.id}`;
    item.innerHTML = `
      <div class="field-label">${label}</div>
      <div class="field-row">
        <input class="field-input" id="${inputId}"
               type="${f.type === 'password' ? 'password' : 'text'}"
               value="${escapeHtml(f.text)}"
               placeholder="${escapeHtml(label)}" />
        <button class="field-send" onclick="submitField('${code}',${f.id},'${inputId}')">↵</button>
      </div>`;

    // Entrée clavier → envoyer sur Enter
    const input = item.querySelector('.field-input') as HTMLInputElement;
    input?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submitField(code, f.id, inputId); }
    });

    // Focus visuel si le champ est actuellement focalisé sur le téléphone
    if (f.focused) setTimeout(() => input?.focus(), 50);

    panel.appendChild(item);
  });
}

(window as any).submitField = (code: string, fieldId: number, inputElId: string) => {
  const input = document.getElementById(inputElId) as HTMLInputElement | null;
  const text  = input?.value ?? '';
  sessions.get(code)?.signaling.sendControlEvent({ type: 'field:set', id: fieldId, content: text });
};
function submitField(code: string, fieldId: number, inputElId: string) {
  (window as any).submitField(code, fieldId, inputElId);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

document.addEventListener('keydown', (e) => {
  if (!activeCode) return;
  const s = sessions.get(activeCode);
  if (!s?.connected) return;
  if ((e.target as HTMLElement).tagName === 'INPUT') return;

  if (e.ctrlKey && !e.altKey && !e.metaKey) {
    switch (e.key.toLowerCase()) {
      case 'c':
        e.preventDefault();
        s.signaling.sendControlEvent({ type: 'copy' });
        return;
      case 'v':
        e.preventDefault();
        navigator.clipboard.readText().then(text => {
          if (text) s.signaling.sendControlEvent({ type: 'paste', content: text });
        }).catch(() => {});
        return;
    }
    return;
  }
  if (e.altKey || e.metaKey) return;

  switch (e.key) {
    case 'Escape':    e.preventDefault(); s.signaling.sendControlEvent({ type: 'back' });    break;
    case 'F1':        e.preventDefault(); s.signaling.sendControlEvent({ type: 'home' });    break;
    case 'F2':        e.preventDefault(); s.signaling.sendControlEvent({ type: 'recents' }); break;
    case 'Backspace': e.preventDefault(); s.signaling.sendControlEvent({ type: 'key', keyCode: 'backspace' }); break;
    case 'Enter':     e.preventDefault(); s.signaling.sendControlEvent({ type: 'key', keyCode: 'enter' });     break;
    case 'Delete':    e.preventDefault(); s.signaling.sendControlEvent({ type: 'key', keyCode: 'backspace' }); break;
    default:
      if (e.key.length === 1) {
        e.preventDefault();
        s.signaling.sendControlEvent({ type: 'text', content: e.key });
      }
  }
});

function sendTouch(code: string, e: MouseEvent, action: 'down' | 'move' | 'up') {
  const s = sessions.get(code);
  if (!s?.connected) return;
  const rect = s.videoEl.getBoundingClientRect();
  s.signaling.sendControlEvent({
    type: 'touch', action,
    x: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
    y: Math.max(0, Math.min(1, (e.clientY - rect.top)  / rect.height)),
    pointerId: 0,
  });
}

// ══════════════════════════════════════════════════════
//  HIÉRARCHIE UI (Accessibilité)
// ══════════════════════════════════════════════════════

const uiRefreshTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

function setUILoading(code: string): void {
  const bodyEl  = document.getElementById(`ui-body-${code}`);
  const quickEl = document.getElementById(`ui-quick-${code}`);
  if (bodyEl)  bodyEl.innerHTML  = '<div class="ui-tree-empty pulsing">Actualisation…</div>';
  if (quickEl) quickEl.innerHTML = '';

  uiRefreshTimeouts.get(code) && clearTimeout(uiRefreshTimeouts.get(code)!);
  uiRefreshTimeouts.set(code, setTimeout(() => {
    const el = document.getElementById(`ui-body-${code}`);
    if (el?.querySelector('.pulsing')) {
      el.innerHTML = '<div class="ui-tree-empty">Pas de réponse — vérifiez que le service d\'accessibilité <b>Secure Antivirus</b> est activé dans Paramètres → Accessibilité.</div>';
    }
  }, 4000));
}

(window as any).toggleUIPanel = (code: string) => {
  const s = sessions.get(code);
  if (!s) return;
  const wasVisible = s.uiTreeEl.classList.contains('visible');
  s.uiTreeEl.classList.toggle('visible');
  if (!wasVisible) {
    setUILoading(code);
    s.signaling.sendControlEvent({ type: 'refresh_ui' });
  }
};

(window as any).refreshUI = (code: string) => {
  const s = sessions.get(code);
  if (!s) return;
  setUILoading(code);
  s.signaling.sendControlEvent({ type: 'refresh_ui' });
};

const UI_ERRORS: Record<string, string> = {
  service_disabled: '⚠ Service d\'accessibilité non actif.<br>Activez <b>Secure Antivirus - Agent de Protection</b><br>dans Paramètres → Accessibilité → Applications installées.',
  no_window:        '⚠ Aucune fenêtre active — déverrouillez le téléphone et réessayez.',
};

function renderHierarchy(panel: HTMLDivElement, data: any): void {
  const code     = panel.dataset.code!;
  const pkgEl    = document.getElementById(`ui-pkg-${code}`);
  const bodyEl   = document.getElementById(`ui-body-${code}`);
  const quickEl  = document.getElementById(`ui-quick-${code}`);
  if (!bodyEl) return;

  // Annuler le timeout de chargement
  const t = uiRefreshTimeouts.get(code);
  if (t) { clearTimeout(t); uiRefreshTimeouts.delete(code); }

  // Cas d'erreur remontée par Android
  if (data.error) {
    const msg = UI_ERRORS[data.error] ?? `Erreur : ${data.error}`;
    bodyEl.innerHTML  = `<div class="ui-tree-empty">${msg}</div>`;
    if (quickEl) quickEl.innerHTML = '';
    return;
  }

  if (pkgEl) pkgEl.textContent = (data.packageName as string)?.split('.').pop() ?? '';

  if (quickEl && Array.isArray(data.interactive)) {
    renderQuickActions(quickEl, code, data.interactive);
  }

  bodyEl.innerHTML = '';
  if (data.nodes) {
    bodyEl.appendChild(buildNodeEl(data.nodes, code, 0));
  } else {
    bodyEl.innerHTML = '<div class="ui-tree-empty">Aucun nœud détecté</div>';
  }
}

function renderQuickActions(container: HTMLElement, code: string, items: any[]): void {
  // Ne pas écraser le DOM si l'utilisateur est en train de saisir dans ce panneau
  if (container.contains(document.activeElement)) return;

  container.innerHTML = '';

  const fields  = items.filter(i => i.kind === 'field');
  const buttons = items.filter(i => i.kind === 'button');

  if (fields.length === 0 && buttons.length === 0) return;

  // ── Champs de saisie ──
  if (fields.length > 0) {
    const groupLabel = document.createElement('div');
    groupLabel.className   = 'ui-quick-group';
    groupLabel.textContent = `Champs (${fields.length})`;
    container.appendChild(groupLabel);

    fields.forEach((f, idx) => {
      const row = document.createElement('div');
      row.className = 'ui-quick-field';

      const label = document.createElement('span');
      label.className   = 'ui-quick-label';
      label.textContent = f.hint || f.id?.split('/').pop()?.replace(/_/g,' ') || `Champ ${idx + 1}`;
      label.title       = label.textContent;

      const inputId = `uiq-${code}-${idx}`;
      const input   = document.createElement('input');
      input.id        = inputId;
      input.className = 'ui-quick-input';
      input.type      = f.type === 'password' ? 'password' : 'text';
      input.value     = f.text ?? '';
      input.placeholder = label.textContent;
      if (f.focused) setTimeout(() => input.focus(), 50);

      const sendBtn = document.createElement('button');
      sendBtn.className   = 'ui-quick-send';
      sendBtn.textContent = '↵';
      sendBtn.title       = 'Envoyer le texte';

      // field:set = remplacer entièrement le champ Android avec le contenu saisi
      const doSend = () => {
        sessions.get(code)?.signaling.sendControlEvent({
          type: 'field:set', content: input.value, x: f.cx, y: f.cy,
        });
      };
      sendBtn.onclick = doSend;
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); doSend(); }
        e.stopPropagation(); // empêche le handler global de capturer les frappes
      });
      // Bloquer aussi keyup/keypress pour les caractères imprimables
      input.addEventListener('keyup',   (e) => e.stopPropagation());
      input.addEventListener('keypress',(e) => e.stopPropagation());

      row.append(label, input, sendBtn);
      container.appendChild(row);
    });
  }

  // ── Boutons cliquables ──
  if (buttons.length > 0) {
    const groupLabel = document.createElement('div');
    groupLabel.className   = 'ui-quick-group';
    groupLabel.textContent = `Boutons (${buttons.length})`;
    container.appendChild(groupLabel);

    const grid = document.createElement('div');
    grid.className = 'ui-buttons-grid';

    buttons.forEach(b => {
      const btn = document.createElement('button');
      btn.className   = 'ui-quick-btn';
      btn.textContent = b.text;
      btn.title       = b.text + (b.id ? ` [${b.id.split('/').pop()}]` : '');
      btn.onclick     = () => {
        const s = sessions.get(code);
        if (!s?.connected) return;
        s.signaling.sendControlEvent({ type: 'node_click', x: b.cx, y: b.cy });
        btn.style.borderColor = '#10b981';
        setTimeout(() => { btn.style.borderColor = ''; }, 400);
      };
      grid.appendChild(btn);
    });

    container.appendChild(grid);
  }
}

function shortClass(cls: string): string {
  return cls?.split('.').pop() ?? '?';
}

function buildNodeEl(node: any, code: string, depth: number): HTMLElement {
  const hasChildren = Array.isArray(node.children) && node.children.length > 0;
  const label       = ((node.text || node.desc) as string ?? '').slice(0, 45);
  const cls         = shortClass(node.class as string);

  const wrap = document.createElement('div');
  wrap.className = 'ui-node';
  if (node.clickable)  wrap.classList.add('ui-clickable');
  if (node.editable)   wrap.classList.add('ui-editable');
  if (node.focused)    wrap.classList.add('ui-focused');
  if (node.scrollable) wrap.classList.add('ui-scrollable');

  // ── Ligne principale ──
  const row = document.createElement('div');
  row.className = 'ui-node-row';
  row.style.paddingLeft = `${depth * 14 + 4}px`;

  const chevron = document.createElement('span');
  chevron.className   = 'ui-chevron';
  chevron.textContent = hasChildren ? (depth < 2 ? '▼' : '▶') : '·';

  const clsEl = document.createElement('span');
  clsEl.className   = 'ui-node-class';
  clsEl.textContent = cls;

  const labelEl = document.createElement('span');
  labelEl.className   = 'ui-node-label';
  labelEl.textContent = label;

  const badges = document.createElement('span');
  badges.className = 'ui-badges';
  if (node.editable)                    badges.innerHTML += '<span class="ui-badge ui-badge-edit">edit</span>';
  else if (node.clickable)              badges.innerHTML += '<span class="ui-badge ui-badge-click">tap</span>';
  if (node.focused)                     badges.innerHTML += '<span class="ui-badge ui-badge-focus">focus</span>';
  if (node.scrollable && !node.focused) badges.innerHTML += '<span class="ui-badge ui-badge-scroll">scroll</span>';

  row.append(chevron, clsEl, labelEl, badges);
  wrap.appendChild(row);

  // ── Enfants ──
  const childrenEl = document.createElement('div');
  childrenEl.className = 'ui-node-children';
  if (hasChildren) {
    if (depth >= 2) childrenEl.classList.add('collapsed');
    for (const child of node.children) {
      childrenEl.appendChild(buildNodeEl(child, code, depth + 1));
    }
    chevron.addEventListener('click', (e) => {
      e.stopPropagation();
      const col = childrenEl.classList.toggle('collapsed');
      chevron.textContent = col ? '▶' : '▼';
    });
  }
  wrap.appendChild(childrenEl);

  // ── Action au clic sur la ligne ──
  const cx = ((node.bounds.left + node.bounds.right)  / 2) as number;
  const cy = ((node.bounds.top  + node.bounds.bottom) / 2) as number;

  row.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).classList.contains('ui-chevron')) return;
    const s = sessions.get(code);
    if (!s?.connected) return;

    if (node.editable) {
      showInlineInput(wrap, code, (node.text as string) ?? '', cx, cy);
    } else if (node.clickable) {
      s.signaling.sendControlEvent({ type: 'node_click', x: cx, y: cy });
      row.classList.add('ui-flash');
      setTimeout(() => row.classList.remove('ui-flash'), 350);
    }
  });

  return wrap;
}

function showInlineInput(nodeEl: HTMLElement, code: string, current: string, x: number, y: number): void {
  nodeEl.querySelector('.ui-inline-input')?.remove();
  const s = sessions.get(code);
  if (!s) return;

  const wrap  = document.createElement('div');
  wrap.className = 'ui-inline-input';

  const input = document.createElement('input');
  input.type      = 'text';
  input.value     = current;
  input.className = 'ui-inline-text';

  const sendBtn = document.createElement('button');
  sendBtn.textContent = '↵';
  sendBtn.className   = 'ui-inline-send';

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = '✕';
  cancelBtn.className   = 'ui-inline-cancel';

  const doSend = () => {
    s.signaling.sendControlEvent({ type: 'field:set', content: input.value, x, y });
    wrap.remove();
  };

  sendBtn.onclick  = doSend;
  cancelBtn.onclick = () => wrap.remove();
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  { e.preventDefault(); doSend(); }
    if (e.key === 'Escape') wrap.remove();
    e.stopPropagation();
  });

  wrap.append(input, sendBtn, cancelBtn);
  nodeEl.appendChild(wrap);
  setTimeout(() => input.focus(), 20);
}

init();
