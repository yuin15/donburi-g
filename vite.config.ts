import type { IncomingMessage, ServerResponse } from 'node:http';
import { defineConfig, loadEnv, type ViteDevServer } from 'vite';

const serverEnvKeys = ['OPENAI_API_KEY', 'LIVEAVATAR_API_KEY', 'LIVEAVATAR_AVATAR_ID', 'LIVEAVATAR_API_URL', 'SESSION_SIGNING_KEY', 'MVP_INVITE_CODE', 'LIVE_MODE_ENABLED', 'ALLOWED_ORIGINS', 'RIVAL_REASONING_MODEL', 'GPT_LIVE_MODEL', 'GPT_LIVE_VOICE', 'MAX_DAILY_SESSIONS', 'MAX_CONCURRENT_SESSIONS'] as const;

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

export default defineConfig(async ({ mode }) => {
  // loadEnv is used only in this Node configuration process. No value is defined for browser code.
  const values = loadEnv(mode, process.cwd(), '');
  for (const key of serverEnvKeys) if (values[key] !== undefined) process.env[key] = values[key];
  // These modules read server-only process.env. Import only after Vite has loaded .env.local.
  const { default: access } = await import('./api/access.js');
  const { attachWsUpgrade, websocketRequired } = await import('./api/ws.js');
  const { getAiDebugStatus, probeResponses } = await import('./server/aiDebug.js');
  const { handleResponsesProbe } = await import('./server/devAiDebugRoute.js');
  const { addDevelopmentLoopbackOrigins } = await import('./server/env.js');
  return {
    plugins: [{
      name: 'local-api-routes',
      configureServer(server: ViteDevServer) {
        server.middlewares.use('/api/access', (req: IncomingMessage, res: ServerResponse) => access(req, res));
        server.middlewares.use('/api/ws', (req: IncomingMessage, res: ServerResponse) => websocketRequired(req, res));
        server.middlewares.use('/__dev/ai-debug/status', (_req: IncomingMessage, res: ServerResponse) => json(res, 200, getAiDebugStatus()));
        server.middlewares.use('/__dev/ai-debug/responses-probe', (req: IncomingMessage, res: ServerResponse) => {
          void handleResponsesProbe(req, res, probeResponses);
        });
        if (server.httpServer) {
          attachWsUpgrade(server.httpServer as unknown as import('node:http').Server);
          const registerLoopbackOrigin = () => {
            const address = server.httpServer?.address();
            if (!address || typeof address === 'string') return;
            addDevelopmentLoopbackOrigins(address.address, address.port);
          };
          if (server.httpServer.listening) registerLoopbackOrigin();
          else server.httpServer.once('listening', registerLoopbackOrigin);
        }
      },
    }],
  };
});
