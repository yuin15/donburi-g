import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import type { ClientMessage, ServerEnvelope } from '../shared/protocol';
import type { LiveEvents } from '../server/gptLive';
import { parseServerEnvelope } from '../shared/wire';
import { PAYOUT } from '../src/domain/game';

interface VoiceMock {
  events: LiveEvents;
  openingContext: string;
  close: ReturnType<typeof vi.fn>;
  updateGameContext: ReturnType<typeof vi.fn>;
  requestReaction: ReturnType<typeof vi.fn>;
  sendMic: ReturnType<typeof vi.fn>;
}

const provider = vi.hoisted(() => ({
  claim: vi.fn(), release: vi.fn(), start: vi.fn(), stop: vi.fn(),
  mediaStart: vi.fn(), mediaClose: vi.fn(), gptConnect: vi.fn(), gptClose: vi.fn(),
  mediaInterrupt: vi.fn(), mediaSpeak: vi.fn(),
  brain: vi.fn(), bridges: [] as VoiceMock[],
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
  speak = provider.mediaSpeak;
  interrupt = vi.fn();
  interruptAndWait = provider.mediaInterrupt;
} }));
vi.mock('../server/gptLive', () => ({ GptLiveBridge: class {
  constructor(readonly events: LiveEvents, readonly openingContext = '') { provider.bridges.push(this); }
  connect = (timeoutMs?: number) => provider.gptConnect(this.events, timeoutMs);
  close = vi.fn(() => provider.gptClose());
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
  provider.bridges.length = 0;
  now = START_TIME;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('External network disabled in WebSocket integration tests'); }));
  provider.release.mockResolvedValue(undefined);
  provider.claim.mockResolvedValue(provider.release);
  provider.start.mockResolvedValue({ sessionId: 'test-avatar', livekitUrl: 'test-url', livekitToken: 'test-token', mediaWsUrl: 'test-media' });
  provider.stop.mockResolvedValue(undefined);
  provider.mediaStart.mockResolvedValue(true);
  provider.mediaInterrupt.mockResolvedValue(true);
  provider.gptConnect.mockImplementation(async (events: LiveEvents) => { events.onReady(); return true; });
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
  const matchVoice = provider.bridges[0];
  wire.send({ type: 'mic', audio: 'AQIDBA==' });
  await wire.barrier();
  expect(matchVoice.sendMic).toHaveBeenCalledExactlyOnceWith('AQIDBA==');

  for (let second = 0; second < 60; second += 2) {
    now = START_TIME + second * 1000;
    if (second === 20 || second === 40) {
      const index = second === 20 ? 0 : 1;
      wire.send({ type: 'snapshot' });
      wire.send({ type: 'upgrade', matchId: 'ws-integration-match', commandId: `choice-${index}`, offerIndex: index, upgradeId: index === 0 ? 'jackpot' : 'steady' });
      await wire.barrier();
    }
    const commandId = `manual-${second}`;
    wire.send({ type: 'spin', matchId: 'ws-integration-match', commandId });
    await wire.waitFor(message => message.type === 'spin_status' && message.commandId === commandId && message.accepted);
    await wire.waitFor(message => message.type === 'side_spin' && message.spin.side === 'player' && message.spin.round === second / 2 + 1);
    if (second === 24 && voice === 'closed') {
      wire.send({ type: 'voice_close' });
      await wire.waitFor(message => message.type === 'voice_status' && message.status === 'closed');
      await wire.barrier();
      expect(wire.client.readyState).toBe(WebSocket.OPEN);
      expect(provider.release).not.toHaveBeenCalled();
    }
  }

  now = START_TIME + 60000;
  wire.send({ type: 'snapshot' });
  const ended = await wire.waitFor(message => message.type === 'match_ended');
  if (ended.type !== 'match_ended') throw new Error('missing_result');
  expect(ended.snapshot).toMatchObject({ status: 'result', rounds: { player: 30, rival: 30 }, elapsed: 60, remaining: 0, upgrades: { player: [], rival: [] } });
  expect(wire.messages.some(message => message.type === 'upgrade_offer' || message.type === 'upgrade_applied')).toBe(false);
  expect(provider.brain).not.toHaveBeenCalled();
  expect(provider.release).not.toHaveBeenCalled();

  await wire.barrier();
  if (voice === 'connected') {
    expect(provider.mediaInterrupt).toHaveBeenCalledOnce();
    expect(provider.gptConnect).toHaveBeenCalledTimes(2);
    expect(provider.bridges).toHaveLength(2);
    const resultVoice = provider.bridges[1];
    expect(matchVoice.close).toHaveBeenCalledOnce();
    expect(resultVoice.close).not.toHaveBeenCalled();
    expect(resultVoice.openingContext).toContain(`プレイヤー所持金$${ended.snapshot.scores.player}、あなた所持金$${ended.snapshot.scores.rival}`);
    expect(resultVoice.openingContext).toContain(`状態=result,勝者=${ended.snapshot.winner}`);
    expect(resultVoice.openingContext).toContain('プレイヤー30回目');
    expect(resultVoice.updateGameContext).toHaveBeenCalledOnce();
    expect(resultVoice.requestReaction).toHaveBeenCalledOnce();
    expect(resultVoice.updateGameContext.mock.invocationCallOrder[0]).toBeLessThan(resultVoice.requestReaction.mock.invocationCallOrder[0]);
    expect(resultVoice.requestReaction.mock.invocationCallOrder[0]).toBeLessThan(resultVoice.sendMic.mock.invocationCallOrder[0]);
    const silentChunksBefore = resultVoice.sendMic.mock.calls.length;
    expect(silentChunksBefore).toBeGreaterThan(0);
    wire.send({ type: 'mic', audio: 'BQYHCA==' });
    wire.send({ type: 'start' }); // A settled connection cannot create another game or voice.
    await wire.barrier();
    await new Promise(resolve => setTimeout(resolve, 220));
    expect(resultVoice.sendMic.mock.calls.length).toBeGreaterThan(silentChunksBefore);
    for (const [audio] of resultVoice.sendMic.mock.calls) {
      const pcm = Buffer.from(audio, 'base64');
      expect(pcm).toHaveLength(4800); // 100 ms at 24 kHz, 16-bit mono.
      expect(pcm.equals(Buffer.alloc(4800))).toBe(true);
    }
    expect(matchVoice.sendMic).toHaveBeenCalledExactlyOnceWith('AQIDBA==');
    matchVoice.events.onAudio('old-generation-audio');
    matchVoice.events.onTranscript('assistant', 'old-generation-caption');
    matchVoice.events.onError('old-generation-error');
    resultVoice.events.onAudio('result-generation-audio');
    resultVoice.events.onTranscript('assistant', 'result-generation-caption');
    await wire.waitFor(message => message.type === 'transcript' && message.delta === 'result-generation-caption');
    expect(provider.mediaSpeak).toHaveBeenCalledExactlyOnceWith('result-generation-audio');
    expect(wire.messages.some(message => message.type === 'transcript' && message.delta === 'old-generation-caption')).toBe(false);
    expect(resultVoice.close).not.toHaveBeenCalled();
    expect(provider.bridges).toHaveLength(2);
  } else {
    expect(provider.mediaInterrupt).not.toHaveBeenCalled();
    expect(provider.gptConnect).toHaveBeenCalledOnce();
    expect(provider.bridges).toHaveLength(1);
    wire.send({ type: 'mic', audio: 'BQYHCA==' });
    await wire.barrier();
    expect(matchVoice.sendMic).toHaveBeenCalledExactlyOnceWith('AQIDBA==');
  }

  const spins = wire.messages.filter(message => message.type === 'side_spin').map(message => message.spin);
  for (const side of ['player', 'rival'] as const) {
    const history = spins.filter(spin => spin.side === side);
    expect(history.map(spin => spin.round)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    let total = 30;
    for (const spin of history) {
      total += spin.payout - 1;
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
  expect(recovery).toMatchObject({ snapshot: ended.snapshot, lastSpins: { player: spins.filter(spin => spin.side === 'player').at(-1), rival: spins.filter(spin => spin.side === 'rival').at(-1) } });
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
  expect(provider.gptClose).toHaveBeenCalledTimes(voice === 'connected' ? 2 : 1);
  for (const bridge of provider.bridges) expect(bridge.close).toHaveBeenCalledOnce();
  const audioCountsAtClose = provider.bridges.map(bridge => bridge.sendMic.mock.calls.length);
  await new Promise(resolve => setTimeout(resolve, 120));
  expect(provider.bridges.map(bridge => bridge.sendMic.mock.calls.length)).toEqual(audioCountsAtClose);
  expect(fetch).not.toHaveBeenCalled();
}, 10000);
