import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const media = vi.hoisted(() => ({ connect: vi.fn(), disconnect: vi.fn(), rooms: [] as Array<{
  handlers: Map<string, (...args: unknown[]) => void>;
}> }));
vi.mock('livekit-client', () => ({
  RoomEvent: { TrackSubscribed: 'track', Disconnected: 'disconnected' },
  Room: class {
    handlers = new Map();
    constructor() { media.rooms.push(this); }
    on(event: string, callback: (...args: unknown[]) => void) { this.handlers.set(event, callback); }
    connect = media.connect;
    disconnect = media.disconnect;
  },
}));
import { LiveClient } from './live';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 0;
  sequence = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  send = vi.fn();
  close = vi.fn(() => { this.readyState = 3; this.onclose?.(); });
  constructor() { Socket.instances.push(this); }
  open() { this.readyState = 1; this.onopen?.(); this.message({ type: 'hello', live: true }); }
  message(data: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify({ ...data, sessionId: 'test-match', streamSeq: ++this.sequence, serverTime: Date.now() }) }); }
}
const stopTrack = vi.fn();
const getUserMedia = vi.fn();
const resume = vi.fn();
const closeAudio = vi.fn();
const request = vi.fn();
const clients: LiveClient[] = [];
function client() {
  const instance = new LiveClient({ srcObject: null } as HTMLVideoElement);
  clients.push(instance);
  return instance;
}
beforeEach(() => {
  vi.resetAllMocks();
  Socket.instances = [];
  media.rooms = [];
  media.connect.mockResolvedValue(undefined);
  media.disconnect.mockResolvedValue(undefined);
  getUserMedia.mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] });
  resume.mockResolvedValue(undefined);
  closeAudio.mockResolvedValue(undefined);
  request.mockResolvedValue(Response.json({ ticket: 'test-ticket' }));
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  vi.stubGlobal('document', { createElement: () => ({ autoplay: false, muted: false, srcObject: null }) });
  vi.stubGlobal('location', { protocol: 'http:', host: 'localhost' });
  vi.stubGlobal('WebSocket', Socket);
  vi.stubGlobal('fetch', request);
  vi.stubGlobal('AudioContext', class {
    resume = resume;
    close = closeAudio;
    createMediaStreamSource = () => ({ connect: vi.fn(), disconnect: vi.fn() });
    createScriptProcessor = () => ({ connect: vi.fn(), disconnect: vi.fn(), onaudioprocess: null });
    createGain = () => ({ connect: vi.fn(), disconnect: vi.fn(), gain: { value: 0 } });
  });
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((instance) => instance.disconnect()));
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function socket() {
  await vi.waitFor(() => expect(Socket.instances).toHaveLength(1));
  return Socket.instances[0];
}

describe('browser live connection lifecycle', () => {
  it('recovers a missing final spin from one authoritative snapshot request', async () => {
    const instance = client(); const received: unknown[] = [];
    instance.addEventListener('message', e => received.push((e as CustomEvent).detail));
    const connection = instance.connect('test'); const ws = await socket();
    ws.open(); ws.message({ type: 'avatar', livekitUrl: 'test-url', livekitToken: 'test-token' }); ws.message({ type: 'voice_status', status: 'ready' });
    await connection;
    const snapshot = { matchId: 'test-match', status: 'result', round: 30, elapsed: 60, remaining: 0, scores: { player: 1200, rival: 0 }, stats: { player: { wins: { cherry: 0, bell: 0, seven: 1 }, bestSpin: { round: 30, payout: 1200 } }, rival: { wins: { cherry: 0, bell: 0, seven: 0 }, bestSpin: null } }, upgrades: { player: [], rival: [] }, eventSeq: 40, winner: 'player' };
    const lastSpin = { player: { side: 'player', round: 30, symbols: ['seven', 'seven', 'seven'], payout: 1200, total: 1200 }, rival: { side: 'rival', round: 30, symbols: ['cherry', 'bell', 'seven'], payout: 0, total: 0 } };
    ws.sequence += 1; // The last spin was lost before it reached the listener.
    ws.message({ type: 'match_ended', snapshot });
    expect(ws.send).toHaveBeenLastCalledWith(JSON.stringify({ type: 'snapshot' }));
    expect(received.some(m => (m as { type: string }).type === 'match_ended')).toBe(false);
    ws.message({ type: 'snapshot', snapshot, lastSpin });
    expect(received).toContainEqual({ type: 'snapshot', snapshot, lastSpin });
    const count = received.length;
    ws.sequence -= 1; ws.message({ type: 'snapshot', snapshot, lastSpin });
    expect(received).toHaveLength(count);
    expect(ws.close).not.toHaveBeenCalled();
  });
  it('ends a stalled game transport when recovery does not arrive, releasing optional media', async () => {
    const instance = client(); const disconnected = vi.fn();
    instance.addEventListener('disconnect', disconnected);
    const connection = instance.connect('test'); const ws = await socket();
    ws.open(); ws.message({ type: 'avatar', livekitUrl: 'test-url', livekitToken: 'test-token' }); ws.message({ type: 'voice_status', status: 'ready' });
    await connection;
    vi.useFakeTimers();
    ws.sequence += 1; ws.message({ type: 'rival_line', text: 'late', reason: 'test' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(disconnected).toHaveBeenCalledOnce();
    expect(stopTrack).toHaveBeenCalledOnce(); expect(media.disconnect).toHaveBeenCalledOnce();
    expect(ws.close).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it('does not request a ticket or open a socket after microphone denial', async () => {
    getUserMedia.mockRejectedValue(new Error('permission_denied'));
    await expect(client().connect('test')).rejects.toThrow('permission_denied');
    expect(request).not.toHaveBeenCalled();
    expect(Socket.instances).toHaveLength(0);
  });

  it.each(['avatar', 'server'])('keeps game messages and upgrades working after %s voice failure', async (source) => {
    const instance = client();
    const disconnected = vi.fn();
    const received: unknown[] = [];
    instance.addEventListener('disconnect', disconnected);
    instance.addEventListener('message', event => received.push((event as CustomEvent).detail));
    const connection = instance.connect('test');
    const ws = await socket();
    ws.open();
    ws.message({ type: 'avatar', livekitUrl: 'test-url', livekitToken: 'test-token' });
    ws.message({ type: 'voice_status', status: 'ready' });
    await connection;
    if (source === 'avatar') media.rooms[0].handlers.get('disconnected')?.();
    else ws.message({ type: 'voice_status', status: 'error' });
    await vi.waitFor(() => expect(stopTrack).toHaveBeenCalledOnce());
    expect(closeAudio).toHaveBeenCalledOnce();
    expect(media.disconnect).toHaveBeenCalledOnce();
    expect(disconnected).not.toHaveBeenCalled();
    expect(ws.close).not.toHaveBeenCalled();
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'voice_close' }));
    instance.send({ type: 'upgrade', commandId: 'test-upgrade', offerIndex: 1, upgradeId: 'jackpot' });
    expect(ws.send).toHaveBeenLastCalledWith(JSON.stringify({ type: 'upgrade', commandId: 'test-upgrade', offerIndex: 1, upgradeId: 'jackpot', matchId: 'test-match' }));
    const snapshot = { matchId: 'test-match', status: 'result', round: 30, elapsed: 60, remaining: 0, scores: { player: 0, rival: 0 }, stats: { player: { wins: { cherry: 0, bell: 0, seven: 0 }, bestSpin: null }, rival: { wins: { cherry: 0, bell: 0, seven: 0 }, bestSpin: null } }, upgrades: { player: [], rival: [] }, eventSeq: 30, winner: 'draw' };
    ws.message({ type: 'match_ended', snapshot });
    expect(received).toContainEqual({ type: 'match_ended', snapshot });
    await instance.disconnect();
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(media.disconnect).toHaveBeenCalledOnce();
  });

  it('rejects startup promptly when the avatar disconnects before readiness', async () => {
    const avatar = deferred<void>();
    media.connect.mockReturnValue(avatar.promise);
    const instance = client();
    const connection = instance.connect('test').catch((error: Error) => error.message);
    const ws = await socket();
    ws.open();
    ws.message({ type: 'avatar', livekitUrl: 'test-url', livekitToken: 'test-token' });
    await vi.waitFor(() => expect(media.rooms).toHaveLength(1));
    media.rooms[0].handlers.get('disconnected')?.();
    expect(await connection).toBe('avatar_connect_failed');
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(ws.close).toHaveBeenCalled();
    avatar.resolve();
  });

  it('stops a microphone permission result arriving after cancellation', async () => {
    const permission = deferred<MediaStream>();
    getUserMedia.mockReturnValue(permission.promise);
    const instance = client();
    const connection = instance.connect('test').catch((error: Error) => error.message);
    await instance.disconnect();
    permission.resolve({ getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream);
    expect(await connection).toBe('connection_cancelled');
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(request).not.toHaveBeenCalled();
    expect(Socket.instances).toHaveLength(0);
  });
  it('releases the microphone when access is refused', async () => {
    request.mockResolvedValue(new Response('', { status: 403 }));
    await expect(client().connect('test')).rejects.toThrow('access_denied');
    expect(stopTrack).toHaveBeenCalledOnce();
  });
  it('settles promptly when a socket closes before opening', async () => {
    const instance = client();
    const connection = instance.connect('test').catch((error: Error) => error.message);
    (await socket()).close();
    expect(await connection).toBe('socket_closed');
    expect(stopTrack).toHaveBeenCalledOnce();
  });
  it('waits for avatar, audio capture, and voice readiness before allowing play', async () => {
    const avatar = deferred<void>();
    media.connect.mockReturnValue(avatar.promise);
    const instance = client();
    const ready = vi.fn();
    const connected = vi.fn();
    instance.addEventListener('message', (event) => {
      if ((event as CustomEvent).detail.status === 'ready') ready();
    });
    const connection = instance.connect('test').then(connected);
    const ws = await socket();
    ws.open();
    ws.message({ type: 'avatar', livekitUrl: 'test-url', livekitToken: 'test-token' });
    ws.message({ type: 'voice_status', status: 'ready' });
    await vi.waitFor(() => expect(media.connect).toHaveBeenCalledOnce());
    expect(ready).not.toHaveBeenCalled();
    expect(connected).not.toHaveBeenCalled();
    avatar.resolve();
    await connection;
    expect(ready).toHaveBeenCalledOnce();
    await instance.disconnect();
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(closeAudio).toHaveBeenCalledOnce();
    expect(media.disconnect).toHaveBeenCalledOnce();
  });
  it('detaches late avatar connections and ignores their tracks after cancellation', async () => {
    const avatar = deferred<void>();
    media.connect.mockReturnValue(avatar.promise);
    const instance = client();
    const connection = instance.connect('test').catch((error: Error) => error.message);
    const ws = await socket();
    ws.open();
    ws.message({ type: 'avatar', livekitUrl: 'test-url', livekitToken: 'test-token' });
    await vi.waitFor(() => expect(media.rooms).toHaveLength(1));
    await instance.disconnect();
    avatar.resolve();
    expect(await connection).toBe('connection_cancelled');
    await vi.waitFor(() => expect(media.disconnect).toHaveBeenCalledTimes(2));
    const attach = vi.fn();
    media.rooms[0].handlers.get('track')?.({ kind: 'video', attach });
    expect(attach).not.toHaveBeenCalled();
  });
  it('closes the socket if audio capture cannot start', async () => {
    resume.mockRejectedValue(new Error('audio unavailable'));
    const connection = client().connect('test').catch((error: Error) => error.message);
    const ws = await socket();
    ws.open();
    expect(await connection).toBe('microphone_start_failed');
    expect(ws.close).toHaveBeenCalled();
    expect(stopTrack).toHaveBeenCalledOnce();
  });
});
