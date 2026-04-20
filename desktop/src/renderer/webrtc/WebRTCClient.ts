import { SignalingClient } from './SignalingClient';

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  // Ajouter ici votre serveur TURN pour les connexions internet
  // { urls: 'turn:your-server.com:3478', username: 'user', credential: 'pass' },
];

export class WebRTCClient {
  private pc: RTCPeerConnection | null = null;
  private videoEl: HTMLVideoElement | null = null;
  private signaling: SignalingClient;
  onStream?: (stream: MediaStream) => void;
  onDisconnect?: () => void;

  constructor(signaling: SignalingClient) {
    this.signaling = signaling;
  }

  async connect(videoElement: HTMLVideoElement): Promise<void> {
    this.videoEl = videoElement;
    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    this.pc.ontrack = (event) => {
      if (event.streams?.[0]) {
        if (this.videoEl) {
          this.videoEl.srcObject = event.streams[0];
          this.videoEl.play().catch(console.error);
        }
        this.onStream?.(event.streams[0]);
      }
    };

    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.signaling.sendIceCandidate(event.candidate.toJSON());
      }
    };

    this.pc.onconnectionstatechange = () => {
      console.log('[WebRTC] State:', this.pc?.connectionState);
      if (this.pc?.connectionState === 'disconnected' || this.pc?.connectionState === 'failed') {
        this.onDisconnect?.();
      }
    };

    this.signaling.on('webrtc:offer', async (data: { sdp: RTCSessionDescriptionInit }) => {
      await this.pc!.setRemoteDescription(new RTCSessionDescription(data.sdp));
      const answer = await this.pc!.createAnswer();
      await this.pc!.setLocalDescription(answer);
      this.signaling.sendAnswer(answer);
    });

    this.signaling.on('webrtc:ice-candidate', async (data: { candidate: RTCIceCandidateInit }) => {
      try {
        await this.pc!.addIceCandidate(new RTCIceCandidate(data.candidate));
      } catch (e) {
        console.error('[WebRTC] ICE candidate error:', e);
      }
    });

    this.signaling.on('session:ended', () => {
      this.disconnect();
      this.onDisconnect?.();
    });
  }

  disconnect(): void {
    this.pc?.close();
    this.pc = null;
    if (this.videoEl) {
      this.videoEl.srcObject = null;
    }
  }

  isConnected(): boolean {
    return this.pc?.connectionState === 'connected';
  }
}

