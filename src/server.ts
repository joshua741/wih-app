import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import http from 'http';
import path from 'path';
import { smsRouter } from './routes/sms';
import { voiceRouter } from './routes/voice';
import { apiRouter } from './routes/api';
import { initWebSocket } from './websocket/server';
import { pool } from './db/pool';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
// Raw body for Twilio signature validation
app.use('/webhooks', express.urlencoded({ extended: false }));
app.use(express.json());

app.use('/webhooks/sms', smsRouter);
app.use('/webhooks/voice', voiceRouter);
app.use('/api', apiRouter);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

// Serve built React frontend in production
if (process.env.NODE_ENV === 'production') {
  const clientDist = path.join(__dirname, '..', 'client', 'dist');
  app.use(express.static(clientDist));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

const server = http.createServer(app);
initWebSocket(server);

server.listen(PORT, async () => {
  try {
    await pool.query('SELECT 1');
    console.log(`[DB] PostgreSQL connected`);
  } catch (err) {
    console.error('[DB] Connection failed:', err);
  }
  console.log(`[SERVER] WIH App running on port ${PORT}`);
});

export { server };
