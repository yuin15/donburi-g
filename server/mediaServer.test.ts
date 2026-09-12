import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventEmitter } from 'node:events';
import { MediaServerLeg } from './mediaServer';

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
