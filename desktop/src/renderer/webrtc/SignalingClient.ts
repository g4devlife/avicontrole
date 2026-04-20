import { io, Socket } from 'socket.io-client';

const SERVER_URL: string =
  (import.meta as any).env?.VITE_SERVER_URL ?? 'https://api.avicontrole.app';

type EventHandler = (data: any) => void;

class SignalingClient {
  private socket: Socket | null = null;
  private handlers: Map<string, EventHandler> = new Map();

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = io(SERVER_URL, { transports: ['websocket'] });

      this.socket.on('connect', () => {
        console.log('[SIGNALING] Connecté au serveur');
        resolve();
      });

      this.socket.on('connect_error', reject);

      const events = [
        'desktop:joined', 'desktop:sessions-list', 'desktop:phone-available',
        'desktop:phone-disconnected', 'session:ended', 'error',
        'webrtc:offer', 'webrtc:answer', 'webrtc:ice-candidate',
        'android:clipboard', 'android:fields',
      ];
      events.forEach(event => {
        this.socket!.on(event, (data: any) => {
          this.handlers.get(event)?.(data);
        });
      });
    });
  }

  // Enregistrer le desktop pour recevoir les notifs de téléphones
  register(pcAccountId: string): void {
    this.socket?.emit('desktop:register', { pcAccountId });
  }

  // Demander la liste des téléphones connectés
  listSessions(pcAccountId: string): void {
    this.socket?.emit('desktop:list-sessions', { pcAccountId });
  }

  // Rejoindre la session d'un téléphone spécifique
  joinSession(sessionCode: string, pcAccountId: string): void {
    this.socket?.emit('desktop:join-session', { sessionCode, pcAccountId });
  }

  sendAnswer(sdp: RTCSessionDescriptionInit): void {
    this.socket?.emit('webrtc:answer', { sdp });
  }

  sendIceCandidate(candidate: RTCIceCandidateInit): void {
    this.socket?.emit('webrtc:ice-candidate', { candidate });
  }

  sendControlEvent(event: ControlEvent): void {
    this.socket?.emit('control:event', event);
  }

  on(event: string, handler: EventHandler): void {
    this.handlers.set(event, handler);
  }

  disconnect(): void {
    this.socket?.disconnect();
    this.socket = null;
  }
}

export interface ControlEvent {
  type:       'touch' | 'scroll' | 'key' | 'text' | 'back' | 'home' | 'recents' | 'longpress' | 'pinch' | 'copy' | 'paste' | 'screen:wake' | 'field:set' | 'volume:up' | 'volume:down' | 'volume:mute' | 'media:play' | 'media:next' | 'media:prev' | 'media:stop' | 'quick:settings' | 'notifications' | 'lock' | 'screenshot';
  action?:    'down' | 'move' | 'up';
  x?:         number;
  y?:         number;
  pointerId?: number;
  dx?:        number;
  dy?:        number;
  keyCode?:   string;
  content?:   string;
  scale?:     number;
  id?:        number;
}

export { SignalingClient };
export const signalingClient = new SignalingClient();
