import express from 'express';
import http from 'http';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import path from 'path';
import fs from 'fs';
import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import { config } from './config.js';
import { errorHandler } from './middleware/error.js';
import { setIO } from './realtime.js';
import { startCampaignWorker } from './queues/campaign.queue.js';

import authRoutes from './routes/auth.routes.js';
import walletRoutes from './routes/wallet.routes.js';
import adminWalletRoutes from './routes/admin.wallet.routes.js';
import whatsappRoutes from './routes/whatsapp.routes.js';
import profileRoutes from './routes/profile.routes.js';
import templateRoutes from './routes/template.routes.js';
import contactRoutes from './routes/contact.routes.js';
import campaignRoutes from './routes/campaign.routes.js';
import dashboardRoutes from './routes/dashboard.routes.js';
import reportRoutes from './routes/report.routes.js';
import notificationRoutes from './routes/notification.routes.js';
import webhookRoutes from './routes/webhook.routes.js';
import numbersRoutes from './routes/numbers.routes.js';
import metaRoutes from './routes/meta.routes.js';
import razorpayWebhookRoutes from './routes/razorpayWebhook.routes.js';

fs.mkdirSync(path.resolve(config.uploadDir), { recursive: true });

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: config.appUrl, credentials: true },
});
setIO(io);

io.on('connection', (socket) => {
  socket.on('authenticate', (token) => {
    try {
      if (!token || typeof token !== 'string') return;
      const payload = jwt.verify(token, config.jwt.accessSecret);
      const userId = Number(payload.sub);
      if (!userId) return;
      if (socket.data.userId && socket.data.userId !== userId) {
        socket.leave(`user:${socket.data.userId}`);
      }
      socket.data.userId = userId;
      socket.join(`user:${userId}`);
    } catch {
      /* ignore invalid socket auth */
    }
  });

  socket.on('subscribe:campaign', (campaignId) => {
    if (campaignId) socket.join(`campaign:${campaignId}`);
  });
});

app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(
  cors({
    origin: config.appUrl,
    credentials: true,
  })
);
app.use(morgan(config.nodeEnv === 'production' ? 'combined' : 'dev'));
app.use('/webhooks/whatsapp', express.json({ verify: rawBodySaver }), webhookRoutes);
app.use('/api/webhooks/meta', express.json({ verify: rawBodySaver }), webhookRoutes);
app.use('/api/webhooks/razorpay', express.json({ verify: rawBodySaver }), razorpayWebhookRoutes);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.resolve(config.uploadDir)));

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'whatsapp-bsp-api' });
});

app.use('/api/auth', authRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/admin/wallet', adminWalletRoutes);
app.use('/api/whatsapp', whatsappRoutes);
app.use('/api/numbers', numbersRoutes);
app.use('/api/meta', metaRoutes);
app.use('/api/profile/business', profileRoutes);
app.use('/api/templates', templateRoutes);
app.use('/api/contacts', contactRoutes);
app.use('/api/campaigns', campaignRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/notifications', notificationRoutes);

app.use(errorHandler);

function rawBodySaver(req, res, buf) {
  req.rawBody = buf;
}

try {
  startCampaignWorker();
  console.log('Campaign worker started');
} catch (err) {
  console.warn('Campaign worker not started (is Redis running?):', err.message);
}

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err?.message || err);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `Port ${config.port} is already in use. Stop the other process first, e.g.\n` +
        `  netstat -ano | findstr :${config.port}\n` +
        `  taskkill /PID <pid> /F`
    );
    process.exit(1);
  }
  throw err;
});

// Bind 0.0.0.0 in production so cloud hosts (Render, etc.) can reach the process.
const listenHost = process.env.HOST || (config.nodeEnv === 'production' ? '0.0.0.0' : '127.0.0.1');
server.listen(config.port, listenHost, () => {
  console.log(`API listening on http://${listenHost}:${config.port}`);
});
