import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import WebSocket from 'ws';

// Import emitted JavaScript directly: Vite/Vitest can hide invalid Node ESM imports.
process.env.LIVE_MODE_ENABLED = 'false';
process.env.ALLOWED_ORIGINS = 'https://slot-chan.vercel.app';
const { default: access } = await import('../.tmp/server-runtime/api/access.js');
const { default: sockets } = await import('../.tmp/server-runtime/api/ws.js');
const http = createServer(access);
const origin = process.env.ALLOWED_ORIGINS;

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `127.0.0.1:${server.address().port}`;
}

try {
  const address = await listen(http);
  const response = await fetch(`http://${address}/api/access`, {
    method: 'POST',
    headers: { Origin: origin, 'X-Invite-Code': 'invalid-test-invite' },
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'invalid_access' });
  const socketAddress = await listen(sockets);
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${socketAddress}/api/ws`, { headers: { Origin: origin } });
    let rejected = false;
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('WebSocket rejection timed out')); }, 5000);
    ws.on('message', (data) => {
      const message = JSON.parse(String(data));
      rejected = message.type === 'error' && message.code === 'session_rejected';
    });
    ws.on('error', reject);
    ws.on('close', (code) => {
      clearTimeout(timer);
      if (code === 1008 && rejected) resolve();
      else reject(new Error(`Unexpected rejection: ${code}`));
    });
  });
  console.log('Emitted Node ESM API startup and disabled-live HTTP/WebSocket rejection passed.');
} finally {
  await Promise.all([http, sockets].map((server) => new Promise((resolve) => server.close(resolve))));
}
