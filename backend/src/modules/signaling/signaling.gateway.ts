import { Server as SocketIOServer, Socket } from 'socket.io';

interface SessionPeer {
  androidSocket?: Socket;
  desktopSocket?: Socket;
  sessionCode:    string;
  pcAccountId:    string;
  deviceFP:       string;
  localIp:        string;
  createdAt:      Date;
}

// Sessions actives en mémoire (sessionCode → peers)
const activeSessions = new Map<string, SessionPeer>();

// Desktops enregistrés (pcAccountId → socket de gestion)
const registeredDesktops = new Map<string, Socket>();

function generateSessionCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function isValidUUID(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

export function initSignaling(io: SocketIOServer): void {

  io.on('connection', (socket: Socket) => {
    console.log(`[SIGNALING] Nouveau socket: ${socket.id}`);

    // ─── Desktop : s'enregistrer pour recevoir les notifs ────────
    socket.on('desktop:register', (data: { pcAccountId: string }) => {
      const { pcAccountId } = data;
      if (!isValidUUID(pcAccountId)) return;
      registeredDesktops.set(pcAccountId, socket);
      (socket as any).pcAccountId  = pcAccountId;
      (socket as any).role         = 'desktop-manager';
      console.log(`[SIGNALING] Desktop enregistré: ${pcAccountId.slice(0, 8)}…`);

      // Envoyer la liste des téléphones déjà connectés
      const sessions = getSessionsForPc(pcAccountId);
      socket.emit('desktop:sessions-list', { sessions });
    });

    // ─── Desktop : actualiser la liste des téléphones ────────────
    socket.on('desktop:list-sessions', (data: { pcAccountId: string }) => {
      const sessions = getSessionsForPc(data.pcAccountId);
      socket.emit('desktop:sessions-list', { sessions });
    });

    // ─── Android : créer une session ─────────────────────────────
    socket.on('android:create-session', (data: {
      pcAccountId:       string;
      deviceFingerprint: string;
      localIp?:          string;
    }) => {
      const { pcAccountId, deviceFingerprint, localIp = '' } = data;

      if (!isValidUUID(pcAccountId)) {
        socket.emit('error', { code: 'INVALID_ACCOUNT', message: 'Téléphone non associé à un PC.' });
        socket.disconnect();
        return;
      }

      let sessionCode: string;
      do { sessionCode = generateSessionCode(); }
      while (activeSessions.has(sessionCode));

      const session: SessionPeer = {
        androidSocket: socket,
        sessionCode,
        pcAccountId,
        deviceFP: deviceFingerprint,
        localIp,
        createdAt: new Date(),
      };
      activeSessions.set(sessionCode, session);
      (socket as any).sessionCode = sessionCode;
      (socket as any).role        = 'android';

      socket.emit('android:session-created', { sessionCode });
      console.log(`[SIGNALING] Session créée: ${sessionCode} (PC: ${pcAccountId.slice(0, 8)}…)`);

      // Notifier le desktop si déjà enregistré
      const desktopSocket = registeredDesktops.get(pcAccountId);
      if (desktopSocket?.connected) {
        desktopSocket.emit('desktop:phone-available', {
          sessionCode,
          deviceFP: deviceFingerprint,
          localIp,
        });
        console.log(`[SIGNALING] Desktop notifié: téléphone ${sessionCode}`);
      }
    });

    // ─── Desktop : rejoindre une session ─────────────────────────
    socket.on('desktop:join-session', (data: { sessionCode: string; pcAccountId: string }) => {
      const { sessionCode, pcAccountId } = data;
      const session = activeSessions.get(sessionCode);

      if (!session || !session.androidSocket) {
        socket.emit('error', { code: 'SESSION_NOT_FOUND', message: 'Téléphone déconnecté ou introuvable.' });
        return;
      }
      if (session.pcAccountId !== pcAccountId) {
        socket.emit('error', { code: 'WRONG_ACCOUNT', message: 'Ce téléphone n\'est pas associé à votre PC.' });
        return;
      }
      if (session.desktopSocket) {
        socket.emit('error', { code: 'SESSION_BUSY', message: 'Quelqu\'un contrôle déjà ce téléphone.' });
        return;
      }

      session.desktopSocket = socket;
      (socket as any).sessionCode = sessionCode;
      (socket as any).role        = 'desktop';

      session.androidSocket.emit('android:desktop-joined', { socketId: socket.id });
      socket.emit('desktop:joined', { androidSocketId: session.androidSocket.id });
      console.log(`[SIGNALING] Desktop rejoint session: ${sessionCode}`);
    });

    // ─── WebRTC Signaling relay ───────────────────────────────────

    socket.on('webrtc:offer', (data: { sdp: any }) => {
      const session = getSession(socket);
      if (!session?.desktopSocket) return;
      session.desktopSocket.emit('webrtc:offer', { sdp: data.sdp });
    });

    socket.on('webrtc:answer', (data: { sdp: any }) => {
      const session = getSession(socket);
      if (!session?.androidSocket) return;
      session.androidSocket.emit('webrtc:answer', { sdp: data.sdp });
    });

    socket.on('webrtc:ice-candidate', (data: { candidate: any }) => {
      const session = getSession(socket);
      if (!session) return;
      const role   = (socket as any).role;
      const target = role === 'android' ? session.desktopSocket : session.androidSocket;
      target?.emit('webrtc:ice-candidate', { candidate: data.candidate });
    });

    // ─── Commandes de contrôle tactile ───────────────────────────
    socket.on('control:event', (data: ControlEvent) => {
      const session = getSession(socket);
      if (!session?.androidSocket) return;
      session.androidSocket.emit('control:event', data);
    });

    // ─── Presse-papiers Android → Desktop ────────────────────────
    socket.on('android:clipboard', (data: { content: string }) => {
      const session = getSession(socket);
      if (!session?.desktopSocket) return;
      session.desktopSocket.emit('android:clipboard', { content: data.content });
    });

    // ─── Champs de saisie Android → Desktop ──────────────────────
    socket.on('android:fields', (data: { fields: any[] }) => {
      const session = getSession(socket);
      if (!session?.desktopSocket) return;
      session.desktopSocket.emit('android:fields', { fields: data.fields });
    });

    // ─── Déconnexion ──────────────────────────────────────────────
    socket.on('disconnect', () => {
      const role = (socket as any).role as string;

      // Desktop manager
      if (role === 'desktop-manager') {
        const pcId = (socket as any).pcAccountId as string;
        if (pcId) registeredDesktops.delete(pcId);
        console.log(`[SIGNALING] Desktop manager déconnecté: ${pcId?.slice(0, 8)}…`);
        return;
      }

      const code = (socket as any).sessionCode as string;
      if (!code) return;
      const session = activeSessions.get(code);
      if (!session) return;

      if (role === 'android') {
        session.desktopSocket?.emit('session:ended', { reason: 'android_disconnected' });
        // Notifier le desktop manager
        const mgr = registeredDesktops.get(session.pcAccountId);
        mgr?.emit('desktop:phone-disconnected', { sessionCode: code });
        activeSessions.delete(code);
        console.log(`[SIGNALING] Session ${code} fermée (Android déconnecté)`);
      } else if (role === 'desktop') {
        session.desktopSocket = undefined;
        session.androidSocket?.emit('android:desktop-left');
        console.log(`[SIGNALING] Desktop quitté session ${code}`);
      }
    });
  });

  // Nettoyer les sessions mortes toutes les 5 min
  setInterval(() => {
    const now = new Date();
    for (const [code, session] of activeSessions.entries()) {
      const ageMin = (now.getTime() - session.createdAt.getTime()) / 60000;
      if (ageMin > 120) {
        session.androidSocket?.disconnect();
        session.desktopSocket?.disconnect();
        activeSessions.delete(code);
      }
    }
  }, 5 * 60 * 1000);
}

function getSession(socket: Socket): SessionPeer | undefined {
  const code = (socket as any).sessionCode as string;
  return activeSessions.get(code);
}

function getSessionsForPc(pcAccountId: string): Array<{ sessionCode: string; deviceFP: string; localIp: string }> {
  const result: Array<{ sessionCode: string; deviceFP: string; localIp: string }> = [];
  for (const [, sess] of activeSessions) {
    if (sess.pcAccountId === pcAccountId && sess.androidSocket?.connected) {
      result.push({ sessionCode: sess.sessionCode, deviceFP: sess.deviceFP, localIp: sess.localIp ?? '' });
    }
  }
  return result;
}

interface ControlEvent {
  type:       'touch' | 'scroll' | 'key' | 'text' | 'back' | 'home' | 'recents' | 'longpress' | 'pinch' | 'copy' | 'paste' | 'screen:wake' | 'field:set' | 'volume:up' | 'volume:down' | 'volume:mute' | 'media:play' | 'media:next' | 'media:prev' | 'media:stop' | 'quick:settings' | 'notifications' | 'lock' | 'screenshot';
  action?:    'down' | 'move' | 'up';
  x?:         number;
  y?:         number;
  pointerId?: number;
  dx?:        number;
  dy?:        number;
  keyCode?:   number;
  content?:   string;
}
