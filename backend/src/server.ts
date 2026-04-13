import express from 'express';
import http from 'http';
import cors from 'cors';
import { Server as SocketIOServer } from 'socket.io';
import { config }              from './config/config';
import { initSignaling }       from './modules/signaling/signaling.gateway';
import { licenseRouter }       from './routes/license.routes';
import { authRouter }          from './routes/auth.routes';
import { telegramRouter }      from './routes/telegram.routes';
import { pairingRouter }       from './routes/pairing.routes';
import { startOrderMonitor }   from './modules/payment/onchain-payment.service';

const app    = express();
const server = http.createServer(app);
const io     = new SocketIOServer(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

app.use(cors());
app.use(express.json());

// ── Routes ────────────────────────────────────────────
app.use('/api/auth',     authRouter);
app.use('/api/license',  licenseRouter);
app.use('/api/telegram', telegramRouter);
app.use('/api/pair',     pairingRouter);

app.get('/health', (_req, res) => res.json({ status: 'ok', ts: new Date() }));

// ── WebRTC Signaling ──────────────────────────────────
initSignaling(io);

// ── Moniteur paiements on-chain ───────────────────────
startOrderMonitor();

// ── Démarrage ─────────────────────────────────────────
server.listen(config.port, () => {
  console.log(`✅ Serveur démarré sur http://localhost:${config.port}`);
  console.log(`   Environnement : ${config.nodeEnv}`);
});
