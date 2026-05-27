import { Server as HttpServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';

let wss: WebSocketServer | null = null;

export function initWebSocket(server: HttpServer) {
  wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws: WebSocket) => {
    console.log(`[WS] Client connected (total: ${wss!.clients.size})`);

    ws.send(JSON.stringify({ event: 'connected', payload: { ts: new Date().toISOString() } }));

    ws.on('close', () => {
      console.log(`[WS] Client disconnected (total: ${wss!.clients.size})`);
    });

    ws.on('error', (err) => {
      console.error('[WS] Client error:', err.message);
    });
  });

  // Ping keepalive every 30s
  const interval = setInterval(() => {
    if (!wss) return;
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.ping();
      }
    });
  }, 30_000);

  wss.on('close', () => clearInterval(interval));

  console.log('[WS] WebSocket server initialized at /ws');
}

export function broadcast(event: string, payload: unknown) {
  if (!wss) return;
  const msg = JSON.stringify({ event, payload, ts: new Date().toISOString() });
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}
