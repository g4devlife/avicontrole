import { Server as SocketIOServer, Socket } from 'socket.io';

interface SessionPeer {
  androidSocket?: Socket;
  desktopSocket?: Socket;
  sessionCode:    string;
  pcAccountId:    string;
  deviceFP:       string;
  createdAt:      Date;
}

// Sessions actives en mémoire (code → peers)
const activeSessions = new Map<string, SessionPeer>();

// Génère un code de session à 8 chars
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

    // ─── Android : créer une session (lié à un pcAccountId) ─────
    socket.on('android:create-session', async (data: {
      pcAccountId:       string;
      deviceFingerprint: string;
    }) => {
      const { pcAccountId, deviceFingerprint } = data;

      if (!isValidUUID(pcAccountId)) {
        socket.emit('error', { code: 'INVALID_ACCOUNT', message: 'Téléphone non associé à un PC. Scannez le QR code depuis votre PC.' });
        socket.disconnect();
        return;
      }

      // Générer un code unique
      let sessionCode: string;
      do { sessionCode = generateSessionCode(); }
      while (activeSessions.has(sessionCode));

      const session: SessionPeer = {
        androidSocket: socket,
        sessionCode,
        pcAccountId,
        deviceFP: deviceFingerprint,
        createdAt: new Date(),
      };
      activeSessions.set(sessionCode, session);
      (socket as any).sessionCode = sessionCode;
      (socket as any).role = 'android';

      socket.emit('android:session-created', { sessionCode });
      console.log(`[SIGNALING] Session créée: ${sessionCode} (PC: ${pcAccountId.slice(0,8)}…)`);
    });

    // ─── Desktop : rejoindre une session ────────────────────────
    socket.on('desktop:join-session', (data: { sessionCode: string; pcAccountId: string }) => {
      const { sessionCode, pcAccountId } = data;
      const session = activeSessions.get(sessionCode);

      if (!session || !session.androidSocket) {
        socket.emit('error', { code: 'SESSION_NOT_FOUND', message: 'Session introuvable ou téléphone déconnecté.' });
        return;
      }
      // Vérifier que le téléphone appartient bien à ce PC
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
      (socket as any).role = 'desktop';

      session.androidSocket.emit('android:desktop-joined', { socketId: socket.id });
      socket.emit('desktop:joined', { androidSocketId: session.androidSocket.id });
      console.log(`[SIGNALING] Desktop rejoint session: ${sessionCode}`);
    });

    // ─── Desktop : lister ses téléphones actifs ──────────────────
    socket.on('desktop:list-sessions', (data: { pcAccountId: string }) => {
      const { pcAccountId } = data;
      const result: Array<{ sessionCode: string; deviceFP: string }> = [];

      for (const [, sess] of activeSessions) {
        if (sess.pcAccountId === pcAccountId && sess.androidSocket?.connected) {
          result.push({ sessionCode: sess.sessionCode, deviceFP: sess.deviceFP });
        }
      }

      socket.emit('desktop:sessions-list', { sessions: result });
    });

    // ─── WebRTC Signaling relay ──────────────────────────────────

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

    // ─── Commandes de contrôle tactile ──────────────────────────
    socket.on('control:event', (data: ControlEvent) => {
      const session = getSession(socket);
      if (!session?.androidSocket) return;
      session.androidSocket.emit('control:event', data);
    });

    // ─── Déconnexion ────────────────────────────────────────────
    socket.on('disconnect', () => {
      const code = (socket as any).sessionCode as string;
      const role = (socket as any).role as string;
      if (!code) return;

      const session = activeSessions.get(code);
      if (!session) return;

      if (role === 'android') {
        session.desktopSocket?.emit('session:ended', { reason: 'android_disconnected' });
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

interface ControlEvent {
  type:       'touch' | 'scroll' | 'key' | 'text' | 'back' | 'home' | 'recents';
  action?:    'down' | 'move' | 'up';
  x?:         number;
  y?:         number;
  pointerId?: number;
  dx?:        number;
  dy?:        number;
  keyCode?:   number;
  content?:   string;
}
