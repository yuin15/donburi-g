import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import type { ClientMessage, ServerEnvelope } from '../shared/protocol';
import type { LiveEvents } from '../server/gptLive';
import { parseServerEnvelope } from '../shared/wire';
import { PAYOUT } from '../src/domain/game';

const provider = vi.hoisted(() => ({
  claim: vi.fn(), release: vi.fn(), start: vi.fn(), stop: vi.fn(),
  mediaStart: vi.fn(), mediaClose: vi.fn(), gptConnect: vi.fn(), gptClose: vi.fn(),
  brain: vi.fn(), events: null as LiveEvents | null,
}));
vi.mock('../server/auth', () => ({
  isAllowedOrigin: () => true,
  verifyTicket: () => ({ sid: 'ws-integration-match', exp: 1700000120 }),
}));
vi.mock('../server/env', () => ({ assertLiveConfiguration: () => {} }));
vi.mock('../server/quota', () => ({ claimQuota: provider.claim }));
vi.mock('../server/liveavatar', () => ({ startAvatarSession: provider.start, stopAvatarSession: provider.stop }));
vi.mock('../server/mediaServer', () => ({ MediaServerLeg: class {
  start = provider.mediaStart;
  close = provider.mediaClose;
  speak = vi.fn();
  interrupt = vi.fn();
} }));
vi.mock('../server/gptLive', () => ({ GptLiveBridge: class {
  constructor(events: LiveEvents) { provider.events = events; }
  connect = provider.gptConnect;
  close = provider.gptClose;
  updateGameContext = vi.fn();
  requestReaction = vi.fn();
  sendMic = vi.fn();
} }));
vi.mock('../server/rivalBrain', () => ({ chooseRivalUpgrade: provider.brain }));
// Both the HTTP/WebSocket handler and MatchSession are the production implementations.
import server from './ws';

const START_TIME = 1700000000000;
let now = START_TIME;
const clients: WebSocket[] = [];

beforeAll(async () => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening', { signal: AbortSignal.timeout(2000) });
});
beforeEach(() => {
  vi.resetAllMocks();
  now = START_TIME;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('External network disabled in WebSocket integration tests'); }));
  provider.release.mockResolvedValue(undefined);
  provider.claim.mockResolvedValue(provider.release);
  provider.start.mockResolvedValue({ sessionId: 'test-avatar', livekitUrl: 'test-url', livekitToken: 'test-token', mediaWsUrl: 'test-media' });
  provider.stop.mockResolvedValue(undefined);
  provider.mediaStart.mockResolvedValue(true);
  provider.gptConnect.mockImplementation(async () => { provider.events?.onReady(); return true; });
  provider.gptClose.mockResolvedValue(undefined);
  provider.brain.mockImplementation(async (_snapshot: unknown, index: number) => ({ upgradeId: index === 0 ? 'steady' : 'jackpot', source: 'ai' }));
});
afterEach(async () => {
  for (const client of clients.splice(0)) {
    if (client.readyState === WebSocket.CLOSED) continue;
    const closed = once(client, 'close', { signal: AbortSignal.timeout(2000) });
    client.terminate();
    await closed.catch(() => undefined);
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
afterAll(async () => {
  const closed = once(server, 'close', { signal: AbortSignal.timeout(2000) });
  server.close();
  await closed;
});

function connect() {
  const client = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/ws?ticket=test`, { origin: 'https://game.example' });
  clients.push(client);
  const raw: string[] = [];
  const messages: ServerEnvelope[] = [];
  const errors: Error[] = [];
  client.on('error', error => errors.push(error));
  client.on('message', data => {
    const value = data.toString();
    raw.push(value);
    const parsed = parseServerEnvelope(value);
    if (parsed) messages.push(parsed);
  });
  const send = (message: ClientMessage) => client.send(JSON.stringify(message));
  const waitFor = (predicate: (message: ServerEnvelope) => boolean, afterSequence = 0): Promise<ServerEnvelope> => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { cleanup(); reject(new Error('Expected WebSocket message did not arrive within 2 seconds')); }, 2000);
    const check = () => {
      const message = messages.find(item => item.streamSeq > afterSequence && predicate(item));
      if (message) { cleanup(); resolve(message); }
    };
    const cleanup = () => { clearTimeout(timeout); client.off('message', check); };
    client.on('message', check);
    check();
  });
  const barrier = async () => {
    const pong = once(client, 'pong', { signal: AbortSignal.timeout(2000) });
    client.ping('processed');
    await pong;
  };
  return { client, raw, messages, errors, send, waitFor, barrier };
}

it.each(['connected', 'closed'] as const)('completes a real socket match with optional voice %s and releases resources once', async voice => {
  const wire = connect();
  await once(wire.client, 'open', { signal: AbortSignal.timeout(2000) });
  await wire.waitFor(message => message.type === 'voice_status' && message.status === 'ready');
  expect(wire.messages[0]).toMatchObject({ type: 'hello', sessionId: 'ws-integration-match', streamSeq: 1 });
  expect(provider.claim).toHaveBeenCalledExactlyOnceWith('ws-integration-match', 1700000120);
  wire.send({ type: 'start' });
  await wire.waitFor(message => message.type === 'snapshot' && message.snapshot.status === 'playing' && message.snapshot.round === 0);

  for (const index of [0, 1] as const) {
    now = START_TIME + (index === 0 ? 20000 : 40000);
    wire.send({ type: 'snapshot' });
    await wire.waitFor(message => message.type === 'upgrade_offer' && message.offerIndex === index);
    const choice = index === 0 ? 'jackpot' : 'steady';
    wire.send({ type: 'upgrade', matchId: 'ws-integration-match', commandId: `choice-${index}`, offerIndex: index, upgradeId: choice });
    // Ping/pong crosses the real socket after the command; keep native timers and I/O running.
    await wire.barrier();
    now += 4000;
    wire.send({ type: 'snapshot' });
    const applied = await wire.waitFor(message => message.type === 'upgrade_applied' && message.offerIndex === index);
    expect(applied).toMatchObject({ player: choice });
    if (index === 0 && voice === 'closed') {
      wire.send({ type: 'voice_close' });
      await wire.waitFor(message => message.type === 'voice_status' && message.status === 'error');
      await wire.barrier();
      expect(wire.client.readyState).toBe(WebSocket.OPEN);
      expect(provider.release).not.toHaveBeenCalled();
    }
  }

  now = START_TIME + 60000;
  wire.send({ type: 'snapshot' });
  const ended = await wire.waitFor(message => message.type === 'match_ended');
  if (ended.type !== 'match_ended') throw new Error('missing_result');
  expect(ended.snapshot).toMatchObject({ status: 'result', round: 30, elapsed: 60, remaining: 0, upgrades: { player: ['jackpot', 'steady'] } });
  if (voice === 'connected') expect(ended.snapshot.upgrades.rival).toEqual(['steady', 'jackpot']);
  expect(provider.brain).toHaveBeenCalledTimes(voice === 'connected' ? 2 : 1);
  expect(provider.release).not.toHaveBeenCalled();

  const spins = wire.messages.filter(message => message.type === 'spin');
  expect(spins.map(message => message.player.round)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
  for (const side of ['player', 'rival'] as const) {
    const history = spins.map(message => message[side]);
    let total = 0;
    for (const spin of history) {
      total += spin.payout;
      expect(spin.total).toBe(total);
    }
    expect(ended.snapshot.scores[side]).toBe(total);
    for (const symbol of ['cherry', 'bell', 'seven'] as const) {
      expect(ended.snapshot.stats[side].wins[symbol]).toBe(history.filter(spin => spin.payout === PAYOUT[symbol]).length);
    }
    const highest = Math.max(...history.map(spin => spin.payout));
    const firstBest = history.find(spin => spin.payout === highest)!;
    expect(ended.snapshot.stats[side].bestSpin).toEqual(highest > 0 ? { round: firstBest.round, payout: highest } : null);
  }

  await wire.barrier();
  const beforeRequest = wire.messages.at(-1)!.streamSeq;
  wire.send({ type: 'snapshot' });
  const recovery = await wire.waitFor(message => message.type === 'snapshot', beforeRequest);
  expect(recovery).toMatchObject({ snapshot: ended.snapshot, lastSpin: { player: spins[29].player, rival: spins[29].rival } });
  const closed = once(wire.client, 'close', { signal: AbortSignal.timeout(2000) });
  wire.send({ type: 'close' });
  const [code] = await closed;
  expect(code).toBe(1000);
  expect(wire.messages.at(-1)).toMatchObject({ type: 'voice_status', status: 'closed' });
  expect(wire.messages.filter(message => message.type === 'match_ended')).toHaveLength(1);
  expect(wire.raw.map(value => parseServerEnvelope(value))).toEqual(wire.messages);
  expect(wire.messages.map(message => message.streamSeq)).toEqual(Array.from({ length: wire.messages.length }, (_, i) => i + 1));
  expect(wire.messages.every(message => message.sessionId === 'ws-integration-match')).toBe(true);
  expect(wire.errors).toEqual([]);
  expect(provider.release).toHaveBeenCalledOnce();
  expect(provider.start).toHaveBeenCalledOnce();
  expect(provider.stop).toHaveBeenCalledExactlyOnceWith('test-avatar');
  expect(provider.mediaClose).toHaveBeenCalledOnce();
  expect(provider.gptClose).toHaveBeenCalledOnce();
  expect(fetch).not.toHaveBeenCalled();
}, 10000);
