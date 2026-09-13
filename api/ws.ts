import { createServer, type Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { isAllowedOrigin, verifyTicket } from '../server/auth.js';
import { assertLiveConfiguration } from '../server/env.js';
import { MatchSession } from '../server/matchSession.js';
import { claimQuota } from '../server/quota.js';

export function websocketRequired(_req: unknown, res: { statusCode: number; setHeader(name: string, value: string): void; end(value: string): void }): void {
  res.statusCode = 426;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end('WebSocket upgrade required');
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 320_000 });

function safeClose(ws: WebSocket, code: number, reason: string): void {
  if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(code, reason.slice(0, 100));
}

wss.on('connection', (ws, request) => {
  let session: MatchSession | null = null;
  let socketEnded = false;
  let stopping: Promise<void> | null = null;
  const stopSession = (reason: string): Promise<void> => {
    socketEnded = true;
    if (!session) return Promise.resolve();
    // An error is normally followed by close; cleanup belongs to this connection once.
    stopping ??= Promise.resolve().then(() => session?.shutdown(reason)).catch(() => {
      safeClose(ws, 1011, 'session_cleanup_failed');
    });
    return stopping;
  };
  // Rejected and still-authenticating sockets can receive invalid frames too.
  // Register before any early return or quota await, otherwise ws emits an uncaught error.
  ws.on('close', () => void stopSession('socket_closed'));
  ws.on('error', () => {
    void stopSession('socket_error');
    safeClose(ws, 1011, 'socket_error');
  });
  void (async () => {
    const origin = request.headers.origin;
    if (!origin || !isAllowedOrigin(origin, request.headers.host)) {
      safeClose(ws, 1008, 'origin_not_allowed');
      return;
    }
    try {
      const url = new URL(request.url ?? '/', `https://${request.headers.host ?? 'localhost'}`);
      const ticket = url.searchParams.get('ticket') ?? '';
      const payload = verifyTicket(ticket, origin);
      assertLiveConfiguration(payload.voiceMode ?? 'avatar');
      const releaseQuota = await claimQuota(payload.sid, payload.exp);
      // A socket may close while its quota lease is being allocated.
      if (socketEnded || ws.readyState !== WebSocket.OPEN) {
        await releaseQuota();
        return;
      }
      session = new MatchSession(ws, payload.sid, releaseQuota, { voiceMode: payload.voiceMode ?? 'avatar' });
      ws.on('message', (raw) => session?.handleRaw(raw.toString()));
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
      await stopSession('session_rejected');
      safeClose(ws, 1008, 'session_rejected');
    }
  })();
});

const attachedServers = new WeakSet<Server>();

/** Attach only the API path to an existing HTTP server (Vite in development). */
export function attachWsUpgrade(server: Server): void {
  if (attachedServers.has(server)) return;
  attachedServers.add(server);
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    if (url.pathname !== '/api/ws') return;
    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request));
  });
}

const server = createServer(websocketRequired);
attachWsUpgrade(server);

export default server;
