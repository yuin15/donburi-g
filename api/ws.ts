import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { isAllowedOrigin, verifyTicket } from '../server/auth';
import { assertLiveConfiguration } from '../server/env';
import { MatchSession } from '../server/matchSession';
import { claimQuota } from '../server/quota';

const server = createServer((_req, res) => {
  res.statusCode = 426;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end('WebSocket upgrade required');
});

const wss = new WebSocketServer({ server, maxPayload: 320_000 });

function safeClose(ws: WebSocket, code: number, reason: string): void {
  if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(code, reason.slice(0, 100));
}

wss.on('connection', (ws, request) => {
  void (async () => {
    const origin = request.headers.origin;
    if (!origin || !isAllowedOrigin(origin, request.headers.host)) {
      safeClose(ws, 1008, 'origin_not_allowed');
      return;
    }
    let session: MatchSession | null = null;
    try {
      assertLiveConfiguration();
      const url = new URL(request.url ?? '/', `https://${request.headers.host ?? 'localhost'}`);
      const ticket = url.searchParams.get('ticket') ?? '';
      const payload = verifyTicket(ticket, origin);
      const releaseQuota = await claimQuota(payload.sid);
      // A socket may close while the shared store is allocating its lease.
      if (ws.readyState !== WebSocket.OPEN) {
        await releaseQuota();
        return;
      }
      session = new MatchSession(ws, payload.sid, releaseQuota);
      ws.on('message', (raw) => session?.handleRaw(raw.toString()));
      ws.on('close', () => void session?.shutdown('socket_closed'));
      ws.on('error', () => void session?.shutdown('socket_error'));
      await session.initialize();
    } catch {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'error',
          code: 'session_rejected',
          message: 'ライブ対戦を開始できませんでした。',
          recoverable: false,
        }));
      }
      await session?.shutdown('session_rejected');
      safeClose(ws, 1008, 'session_rejected');
    }
  })();
});

export default server;
