import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventEmitter } from 'node:events';
import { MediaServerLeg } from './mediaServer';

// Framing is exercised with real PCM in pcm.test; these tests isolate provider ACKs.
vi.mock('./pcm', () => ({ AvatarAudioBuffer: class {
  constructor(private readonly send: (audio: string) => void) {}
  append(audio: string) { this.send(audio); }
  reset() {}
} }));

type FakeSocket = EventEmitter & { readyState: number; send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn> };
const sockets = vi.hoisted(() => [] as FakeSocket[]);
vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events');
  return { default: class extends EventEmitter {
    static OPEN = 1;
    static CLOSED = 3;
    readyState = 0;
    send = vi.fn();
    close = vi.fn(() => { this.readyState = 3; this.emit('close'); });
    terminate = vi.fn(() => { this.readyState = 3; this.emit('close'); });
    constructor() { super(); sockets.push(this); }
  } };
});
beforeEach(() => { sockets.length = 0; vi.useFakeTimers(); });
afterEach(() => vi.useRealTimers());

async function connectMedia() {
  const failure = vi.fn();
  const media = new MediaServerLeg('wss://test.invalid', failure);
  const connecting = media.start();
  const socket = sockets.at(-1)!;
  socket.readyState = 1;
  socket.emit('open');
  socket.emit('message', JSON.stringify({ type: 'session.state_updated', state: 'connected' }));
  expect(await connecting).toBe(true);
  return { media, socket, failure };
}

function lastCommand(socket: FakeSocket): { type: string; event_id?: string; audio?: string } {
  return JSON.parse(socket.send.mock.calls.at(-1)![0]);
}

describe('avatar interrupt acknowledgment', () => {
  it('returns false without sending before connection readiness or after close', async () => {
    const media = new MediaServerLeg('wss://test.invalid');
    expect(await media.interruptAndWait()).toBe(false);
    const connecting = media.start();
    sockets[0].readyState = 1;
    sockets[0].emit('open');
    expect(await media.interruptAndWait()).toBe(false);
    expect(sockets[0].send).not.toHaveBeenCalled();
    media.close();
    expect(await connecting).toBe(false);
    expect(await media.interruptAndWait()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('blocks speech until the matching clear acknowledgment, ignoring unrelated events', async () => {
    const { media, socket } = await connectMedia();
    media.speak('old-audio');
    const pending = media.interruptAndWait();
    const settled = vi.fn();
    void pending.then(settled);
    const interrupt = lastCommand(socket);
    expect(interrupt).toMatchObject({ type: 'agent.interrupt', event_id: expect.any(String) });
    expect(interrupt.event_id).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27}$/i);
    for (const event of [
      { type: 'agent.audio_buffer_cleared', source_event_id: 'another-interrupt' },
      { type: 'agent.audio_buffer_cleared' },
      { type: 'agent.speak_interrupted', source_event_id: interrupt.event_id },
      null,
    ]) socket.emit('message', JSON.stringify(event));
    socket.emit('message', 'invalid-json');
    media.speak('blocked-audio');
    await vi.advanceTimersByTimeAsync(100);
    expect(settled).not.toHaveBeenCalled();
    expect(socket.send).toHaveBeenCalledTimes(2);
    socket.emit('message', JSON.stringify({ type: 'agent.audio_buffer_cleared', source_event_id: interrupt.event_id }));
    expect(await pending).toBe(true);
    media.speak('result-audio');
    expect(socket.send.mock.calls.map(([value]) => JSON.parse(value))).toEqual([
      { type: 'agent.speak', event_id: expect.any(String), audio: 'old-audio' },
      interrupt,
      { type: 'agent.speak', event_id: expect.any(String), audio: 'result-audio' },
    ]);
    expect(vi.getTimerCount()).toBe(1); // Only the existing keep-alive remains.
    media.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shares one pending promise and suppresses overlapping ordinary interrupts', async () => {
    const { media, socket } = await connectMedia();
    const first = media.interruptAndWait(500);
    const second = media.interruptAndWait(1000);
    expect(second).toBe(first);
    media.interrupt();
    expect(socket.send).toHaveBeenCalledTimes(1);
    const id = lastCommand(socket).event_id;
    socket.emit('message', JSON.stringify({ type: 'agent.audio_buffer_cleared', source_event_id: id }));
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    media.interrupt();
    expect(lastCommand(socket)).toMatchObject({ type: 'agent.interrupt', event_id: expect.any(String) });
    expect(socket.send).toHaveBeenCalledTimes(2);
    media.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resolves false after the default two-second deadline and clears its timer', async () => {
    const { media } = await connectMedia();
    const pending = media.interruptAndWait();
    const settled = vi.fn();
    void pending.then(settled);
    await vi.advanceTimersByTimeAsync(1999);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
    media.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not let a late acknowledgment release a newer interrupt boundary', async () => {
    const { media, socket } = await connectMedia();
    const expired = media.interruptAndWait(100);
    const oldId = lastCommand(socket).event_id;
    await vi.advanceTimersByTimeAsync(100);
    expect(await expired).toBe(false);
    const current = media.interruptAndWait(500);
    const newId = lastCommand(socket).event_id;
    expect(newId).not.toBe(oldId);
    const settled = vi.fn();
    void current.then(settled);
    socket.emit('message', JSON.stringify({ type: 'agent.audio_buffer_cleared', source_event_id: oldId }));
    media.speak('still-blocked');
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).not.toHaveBeenCalled();
    expect(socket.send).toHaveBeenCalledTimes(2);
    socket.emit('message', JSON.stringify({ type: 'agent.audio_buffer_cleared', source_event_id: newId }));
    expect(await current).toBe(true);
    media.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['close', 'socket-close', 'socket-error', 'provider-error', 'provider-disconnected'] as const)(
    'resolves false and releases timers on %s during acknowledgment wait', async reason => {
      const { media, socket, failure } = await connectMedia();
      const pending = media.interruptAndWait();
      const id = lastCommand(socket).event_id;
      if (reason === 'close') media.close();
      else if (reason === 'socket-close') { socket.readyState = 3; socket.emit('close'); }
      else if (reason === 'socket-error') socket.emit('error', new Error('transport failed'));
      else if (reason === 'provider-error') socket.emit('message', JSON.stringify({ type: 'error' }));
      else socket.emit('message', JSON.stringify({ type: 'session.state_updated', state: 'disconnected' }));
      expect(await pending).toBe(false);
      socket.emit('message', JSON.stringify({ type: 'agent.audio_buffer_cleared', source_event_id: id }));
      media.speak('late-audio');
      expect(socket.send).toHaveBeenCalledTimes(1);
      expect(failure).toHaveBeenCalledTimes(reason === 'close' ? 0 : 1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('resolves false without throwing if the interrupt send fails synchronously', async () => {
    const { media, socket, failure } = await connectMedia();
    socket.send.mockImplementation(() => { throw new Error('send failed'); });
    await expect(media.interruptAndWait()).resolves.toBe(false);
    expect(failure).toHaveBeenCalledExactlyOnceWith();
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('avatar media lifecycle', () => {
  it('ignores late ready/open events after cancellation', async () => {
    const failure = vi.fn();
    const media = new MediaServerLeg('wss://test.invalid', failure);
    const connecting = media.start();
    media.close();
    sockets[0].readyState = 1;
    sockets[0].emit('open');
    sockets[0].emit('message', JSON.stringify({ type: 'session.state_updated', state: 'connected' }));
    media.speak('test-audio');
    expect(await connecting).toBe(false);
    expect(sockets[0].send).not.toHaveBeenCalled();
    expect(failure).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([
    { type: 'error', error: { type: 'server_error', message: 'private provider detail' } },
    { type: 'session.state_updated', state: 'disconnected' },
  ])('closes and reports a provider failure once: $type', async (event) => {
    const failure = vi.fn();
    const media = new MediaServerLeg('wss://test.invalid', failure);
    const connecting = media.start();
    sockets[0].readyState = 1;
    sockets[0].emit('open');
    sockets[0].emit('message', JSON.stringify({ type: 'session.state_updated', state: 'connected' }));
    expect(await connecting).toBe(true);
    sockets[0].emit('message', JSON.stringify(event));
    sockets[0].emit('error', new Error('transport also failed'));
    media.speak('late-audio');
    expect(failure).toHaveBeenCalledExactlyOnceWith();
    expect(sockets[0].close).toHaveBeenCalledTimes(1);
    expect(sockets[0].send).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('stops an unresponsive media connection after the shutdown deadline', async () => {
    const media = new MediaServerLeg('wss://test.invalid');
    const connecting = media.start();
    sockets[0].readyState = 1;
    sockets[0].emit('message', JSON.stringify({ type: 'session.state_updated', state: 'connected' }));
    await connecting;
    sockets[0].close.mockImplementation(() => undefined);
    media.close();
    media.close();
    await vi.advanceTimersByTimeAsync(1500);
    expect(sockets[0].close).toHaveBeenCalledTimes(1);
    expect(sockets[0].terminate).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
