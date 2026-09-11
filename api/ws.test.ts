import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';

const mocks = vi.hoisted(() => ({ claim: vi.fn(), initialize: vi.fn() }));
vi.mock('../server/auth', () => ({ isAllowedOrigin: () => true, verifyTicket: () => ({ sid: 'test-ticket' }) }));
vi.mock('../server/env', () => ({ assertLiveConfiguration: () => {} }));
vi.mock('../server/quota', () => ({ claimQuota: mocks.claim }));
vi.mock('../server/matchSession', () => ({ MatchSession: class { initialize = mocks.initialize; } }));
import server from './ws';

beforeAll(async () => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
});
afterAll(async () => {
  server.close();
  await once(server, 'close');
});
it('returns a quota lease without starting paid providers if the client closed while allocation was pending', async () => {
  const release = vi.fn(async () => undefined);
  let allocated!: (value: typeof release) => void;
  mocks.claim.mockReturnValue(new Promise<typeof release>((resolve) => { allocated = resolve; }));
  const client = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/ws?ticket=test`, {
    origin: 'https://game.example',
  });
  await once(client, 'open');
  const closed = once(client, 'close');
  client.close();
  await closed;
  allocated(release);
  await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
  expect(mocks.initialize).not.toHaveBeenCalled();
});
