import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';

const mocks = vi.hoisted(() => ({
  allowedOrigin: vi.fn(), verify: vi.fn(), configuration: vi.fn(), claim: vi.fn(),
  initialize: vi.fn(), shutdown: vi.fn(), handleRaw: vi.fn(),
}));
vi.mock('../server/auth', () => ({ isAllowedOrigin: mocks.allowedOrigin, verifyTicket: mocks.verify }));
vi.mock('../server/env', () => ({ assertLiveConfiguration: mocks.configuration }));
vi.mock('../server/quota', () => ({ claimQuota: mocks.claim }));
// Test the actual HTTP/WebSocket transport, with no upstream provider connections.
// This deliberately non-idempotent test session reveals duplicate cleanup by the route.
vi.mock('../server/matchSession', () => ({ MatchSession: class {
  constructor(private readonly socket: WebSocket, _id: string, private readonly release: () => Promise<void>) {}
  initialize = mocks.initialize;
  handleRaw = mocks.handleRaw;
  async shutdown(reason: string) {
    await mocks.shutdown(reason);
    await this.release();
    if (this.socket.readyState === 1) this.socket.close(1000, 'session_closed');
  }
} }));
import server from './ws';

const clients = new Set<WebSocket>();
function connect(): WebSocket {
  const client = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/ws?ticket=test`, { origin: 'https://game.example' });
  client.on('error', () => {});
  clients.add(client);
  return client;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
beforeAll(async () => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
});
beforeEach(() => {
  vi.resetAllMocks();
  mocks.allowedOrigin.mockReturnValue(true);
  mocks.verify.mockReturnValue({ sid: 'test-ticket', exp: Date.now() + 60000 });
  mocks.claim.mockResolvedValue(vi.fn(async () => undefined));
  mocks.initialize.mockResolvedValue(undefined);
  mocks.shutdown.mockResolvedValue(undefined);
});
afterEach(async () => {
  await Promise.all([...clients].map(async client => {
    if (client.readyState === WebSocket.CLOSED) return;
    const closed = new Promise<void>(resolve => client.once('close', () => resolve()));
    client.terminate();
    await closed;
  }));
  clients.clear();
});
afterAll(async () => {
  server.close();
  await once(server, 'close');
});
describe('WebSocket connection lifecycle', () => {
  it.each(['origin', 'ticket', 'configuration'] as const)('handles an oversized frame even while rejecting %s', async rejection => {
    if (rejection === 'origin') mocks.allowedOrigin.mockReturnValue(false);
    if (rejection === 'ticket') mocks.verify.mockImplementation(() => { throw new Error('invalid_ticket'); });
    if (rejection === 'configuration') mocks.configuration.mockImplementation(() => { throw new Error('live_mode_disabled'); });
    const client = connect();
    const closed = once(client, 'close');
    // Send before processing the server's close frame, while its receiver is still active.
    client.on('open', () => client.send('x'.repeat(320001)));
    await closed;
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.initialize).not.toHaveBeenCalled();
    expect(mocks.shutdown).not.toHaveBeenCalled();
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ws`);
    expect(response.status).toBe(426);
    await response.text();
  });

  it.each(['close', 'invalid-frame'] as const)('returns a quota lease once after %s during allocation without starting providers', async failure => {
    const release = vi.fn(async () => undefined);
    const allocation = deferred<typeof release>();
    mocks.claim.mockReturnValue(allocation.promise);
    const client = connect();
    const closed = once(client, 'close');
    await once(client, 'open');
    if (failure === 'close') client.close();
    else client.send('x'.repeat(320001));
    await closed;
    allocation.resolve(release);
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
    expect(mocks.initialize).not.toHaveBeenCalled();
    expect(mocks.shutdown).not.toHaveBeenCalled();
  });

  it.each(['close', 'invalid-frame'] as const)('shuts down and releases an authenticated session once after %s', async failure => {
    const release = vi.fn(async () => undefined);
    mocks.claim.mockResolvedValue(release);
    const client = connect();
    const closed = once(client, 'close');
    await once(client, 'open');
    await vi.waitFor(() => expect(mocks.initialize).toHaveBeenCalledTimes(1));
    client.send('{"type":"snapshot"}');
    await vi.waitFor(() => expect(mocks.handleRaw).toHaveBeenCalledWith('{"type":"snapshot"}'));
    if (failure === 'close') client.close();
    else client.send('x'.repeat(320001));
    await closed;
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
    expect(mocks.shutdown).toHaveBeenCalledExactlyOnceWith(failure === 'close' ? 'socket_closed' : 'socket_error');
  });

  it('does not repeat cleanup when initialization rejects after a socket error', async () => {
    const release = vi.fn(async () => undefined);
    const initializing = deferred<void>();
    mocks.claim.mockResolvedValue(release);
    mocks.initialize.mockImplementation(async () => { await initializing.promise; throw new Error('startup_failed'); });
    const client = connect();
    const closed = once(client, 'close');
    await once(client, 'open');
    await vi.waitFor(() => expect(mocks.initialize).toHaveBeenCalledTimes(1));
    client.send('x'.repeat(320001));
    await closed;
    initializing.resolve();
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
    expect(mocks.shutdown).toHaveBeenCalledExactlyOnceWith('socket_error');
  });

  it('closes a socket if cleanup rejects, without an unhandled rejection or a second cleanup', async () => {
    const release = vi.fn(async () => undefined);
    mocks.claim.mockResolvedValue(release);
    mocks.initialize.mockRejectedValue(new Error('startup_failed'));
    mocks.shutdown.mockRejectedValue(new Error('cleanup_failed'));
    const client = connect();
    await once(client, 'close');
    expect(mocks.shutdown).toHaveBeenCalledExactlyOnceWith('session_rejected');
    expect(release).not.toHaveBeenCalled();
  });
});
