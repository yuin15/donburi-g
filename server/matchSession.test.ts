import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';
import type { LiveEvents } from './gptLive';
import type { ServerMessage } from '../shared/protocol';

const provider = vi.hoisted(() => ({
  start: vi.fn(), stop: vi.fn(), mediaStart: vi.fn(), mediaClose: vi.fn(),
  gptConnect: vi.fn(), gptClose: vi.fn(), events: null as LiveEvents | null,
}));
vi.mock('./liveavatar', () => ({ startAvatarSession: provider.start, stopAvatarSession: provider.stop }));
vi.mock('./mediaServer', () => ({ MediaServerLeg: class {
  start = provider.mediaStart;
  close = provider.mediaClose;
  speak = vi.fn();
  interrupt = vi.fn();
} }));
vi.mock('./gptLive', () => ({ GptLiveBridge: class {
  constructor(events: LiveEvents) { provider.events = events; }
  connect = provider.gptConnect;
  close = provider.gptClose;
  updateGameContext = vi.fn();
  requestReaction = vi.fn();
  sendMic = vi.fn();
} }));
vi.mock('./rivalBrain', () => ({ chooseRivalUpgrade: vi.fn(async () => ({ upgradeId: 'steady', source: 'fallback' })) }));
import { MatchSession } from './matchSession';
import { chooseRivalUpgrade } from './rivalBrain';

const avatar = { sessionId: 'test-session', livekitUrl: 'test-url', livekitToken: 'test-token', mediaWsUrl: 'test-media' };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function setup() {
  const messages: ServerMessage[] = [];
  const close = vi.fn();
  const socket = { readyState: 1, close, send: (data: string) => messages.push(JSON.parse(data)) } as unknown as WebSocket;
  const release = vi.fn(async () => undefined);
  return { session: new MatchSession(socket, 'test-match', release), messages, release, close };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network disabled in lifecycle tests'); }));
  provider.start.mockResolvedValue(avatar);
  provider.stop.mockResolvedValue(undefined);
  provider.mediaStart.mockResolvedValue(true);
  provider.gptConnect.mockImplementation(async () => { provider.events?.onReady(); return true; });
  provider.gptClose.mockResolvedValue(undefined);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('live match cleanup', () => {
  it('rejects upgrades arriving after the deadline while the interval tick is delayed', async () => {
    const { session, messages } = setup();
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    await vi.advanceTimersByTimeAsync(20_000);
    vi.setSystemTime(Date.now() + 4_100);
    session.handleRaw(JSON.stringify({ type: 'upgrade', commandId: crypto.randomUUID(), offerIndex: 0, upgradeId: 'jackpot' }));
    expect(messages.some(m => m.type === 'error' && m.code === 'upgrade_rejected')).toBe(true);
    expect(messages.find(m => m.type === 'upgrade_applied' && m.offerIndex === 0)).toMatchObject({ player: 'steady' });
    await session.shutdown('test_finished');
  });
  it('stops an avatar returned after the browser has disconnected', async () => {
    const late = deferred<typeof avatar>();
    provider.start.mockReturnValue(late.promise);
    const { session, release, messages, close } = setup();
    const initializing = session.initialize();
    const stopping = session.shutdown('socket_closed');
    late.resolve(avatar);
    await Promise.all([initializing, stopping]);
    expect(provider.stop).toHaveBeenCalledWith('test-session');
    expect(provider.mediaStart).not.toHaveBeenCalled();
    expect(provider.gptConnect).not.toHaveBeenCalled();
    expect(messages.some(m => m.type === 'avatar')).toBe(false);
    expect(release).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('does not open OpenAI after disconnecting during media setup', async () => {
    const late = deferred<boolean>();
    provider.mediaStart.mockReturnValue(late.promise);
    const { session, release } = setup();
    const initializing = session.initialize();
    await vi.waitFor(() => expect(provider.mediaStart).toHaveBeenCalled());
    const stopping = session.shutdown('socket_closed');
    late.resolve(true);
    await Promise.all([initializing, stopping]);
    expect(provider.gptConnect).not.toHaveBeenCalled();
    expect(provider.stop).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('ignores a late voice-ready callback after shutdown', async () => {
    const late = deferred<boolean>();
    provider.gptConnect.mockReturnValue(late.promise);
    const { session, messages } = setup();
    const initializing = session.initialize();
    await vi.waitFor(() => expect(provider.gptConnect).toHaveBeenCalled());
    const stopping = session.shutdown('socket_closed');
    provider.events?.onReady();
    late.resolve(true);
    await Promise.all([initializing, stopping]);
    expect(messages.some(m => m.type === 'voice_status' && m.status === 'ready')).toBe(false);
  });

  it('releases all resources once after the result reaction window', async () => {
    const { session, release, messages, close } = setup();
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(messages.filter(m => m.type === 'match_ended')).toHaveLength(1);
    expect(release).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(8_000);
    await Promise.all([session.shutdown('socket_closed'), session.shutdown('client_close')]);
    expect(provider.stop).toHaveBeenCalledTimes(1);
    expect(provider.gptClose).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['provider', 'browser'])('finishes the same 30-spin match after %s voice failure', async (source) => {
    const { session, release, messages, close } = setup();
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    await vi.advanceTimersByTimeAsync(25_000);
    const before = messages.filter(m => m.type === 'snapshot').at(-1);
    if (source === 'provider') provider.events?.onError('transport_closed');
    else session.handleRaw('{"type":"voice_close"}');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(provider.stop).toHaveBeenCalledTimes(1);
    expect(provider.gptClose).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(messages.some(m => m.type === 'error' && !m.recoverable)).toBe(false);
    await vi.advanceTimersByTimeAsync(14_000);
    session.handleRaw(JSON.stringify({ type: 'upgrade', commandId: 'after-voice-failure', offerIndex: 1, upgradeId: 'jackpot' }));
    await vi.advanceTimersByTimeAsync(20_000);
    const final = messages.find(m => m.type === 'match_ended');
    expect(final).toMatchObject({ snapshot: { matchId: 'test-match', status: 'result', elapsed: 60, round: 30, upgrades: { player: ['steady', 'jackpot'] } } });
    expect(messages.filter(m => m.type === 'spin')).toHaveLength(30);
    if (before?.type === 'snapshot' && final?.type === 'match_ended') {
      expect(final.snapshot.scores.player).toBeGreaterThanOrEqual(before.snapshot.scores.player);
      expect(final.snapshot.scores.rival).toBeGreaterThanOrEqual(before.snapshot.scores.rival);
    }
    expect(chooseRivalUpgrade).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(provider.stop).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('allows starting after optional media fails in the ready lobby', async () => {
    const { session, messages } = setup();
    await session.initialize();
    provider.events?.onError('transport_closed');
    provider.events?.onReady();
    session.handleRaw('{"type":"start"}');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(messages.filter(m => m.type === 'match_ended')).toHaveLength(1);
    expect(chooseRivalUpgrade).not.toHaveBeenCalled();
    expect(messages.filter(m => m.type === 'voice_status' && m.status === 'ready')).toHaveLength(1);
    await session.shutdown('test_finished');
  });

  it('cleans up an initialization failure and repeated initialize calls', async () => {
    provider.mediaStart.mockResolvedValue(false);
    const { session, release } = setup();
    await Promise.all([session.initialize(), session.initialize()]);
    await session.shutdown('test_finished');
    expect(provider.start).toHaveBeenCalledTimes(1);
    expect(provider.stop).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });
});
