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
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  send = vi.fn();
  close = vi.fn(() => { this.readyState = 3; this.onclose?.(); });
  constructor() { Socket.instances.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
  message(data: unknown) { this.onmessage?.({ data: JSON.stringify(data) }); }
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
  vi.unstubAllGlobals();
});
async function socket() {
  await vi.waitFor(() => expect(Socket.instances).toHaveLength(1));
  return Socket.instances[0];
}

describe('browser live connection lifecycle', () => {
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
    expect(ws.send).toHaveBeenLastCalledWith(JSON.stringify({ type: 'upgrade', commandId: 'test-upgrade', offerIndex: 1, upgradeId: 'jackpot' }));
    ws.message({ type: 'match_ended', snapshot: { status: 'result', round: 30 } });
    expect(received).toContainEqual({ type: 'match_ended', snapshot: { status: 'result', round: 30 } });
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
