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

  it('stops the match and paid providers on a voice failure', async () => {
    const { session, release, messages } = setup();
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    provider.events?.onError('transport_closed');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(messages.some(m => m.type === 'spin')).toBe(false);
    expect(provider.stop).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
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
