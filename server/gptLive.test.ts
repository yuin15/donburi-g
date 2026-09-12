import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventEmitter } from 'node:events';
import { GptLiveBridge } from './gptLive';
type FakeSocket = EventEmitter & { readyState: number; send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn> };
const sockets = vi.hoisted(() => [] as FakeSocket[]);
vi.mock('./env', () => ({ env: { openaiKey: 'test-only-key', gptLiveModel: 'test-model', gptLiveVoice: 'test-voice' } }));
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
function setup() {
  const events = { onReady: vi.fn(), onError: vi.fn(), onAudio: vi.fn(), onTranscript: vi.fn(), onUserSpeech: vi.fn(), onUsage: vi.fn() };
  return { bridge: new GptLiveBridge(events), events };
}
beforeEach(() => { sockets.length = 0; vi.useFakeTimers(); });
afterEach(() => vi.useRealTimers());

describe('voice transport teardown', () => {
  it('drains final usage during close without forwarding late audio or private fields', async () => {
    const { bridge, events } = setup();
    const connecting = bridge.connect();
    sockets[0].readyState = 1;
    sockets[0].emit('message', JSON.stringify({ type: 'session.started' }));
    await connecting;
    sockets[0].emit('message', JSON.stringify({ type: 'session.usage.updated', usage: { seconds: 10 } }));
    sockets[0].emit('message', JSON.stringify({ type: 'session.usage.updated', usage: { seconds: 20 } }));
    const closing = bridge.close();
    await vi.advanceTimersByTimeAsync(2000);
    expect(sockets[0].terminate).not.toHaveBeenCalled();
    sockets[0].emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: 'late-audio' }));
    sockets[0].emit('message', JSON.stringify({ type: 'session.closed', usage: { seconds: 21.5 }, session: { instructions: 'private-content' } }));
    await closing;
    expect(events.onUsage).toHaveBeenCalledExactlyOnceWith({ seconds: 21.5, finalized: true });
    expect(events.onAudio).not.toHaveBeenCalled();
    expect(events.onError).not.toHaveBeenCalled();
    expect(sockets[0].close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('reports the latest cumulative usage as unconfirmed after transport loss', async () => {
    const { bridge, events } = setup();
    const connecting = bridge.connect();
    sockets[0].readyState = 1;
    sockets[0].emit('message', JSON.stringify({ type: 'session.started' }));
    await connecting;
    for (const seconds of [10, 20, -5, 'private-content']) {
      sockets[0].emit('message', JSON.stringify({ type: 'session.usage.updated', usage: { seconds } }));
    }
    sockets[0].readyState = 3;
    sockets[0].emit('close');
    await bridge.close();
    expect(events.onUsage).toHaveBeenCalledExactlyOnceWith({ seconds: 20, finalized: false });
  });
  it('reports an unexpected close after startup', async () => {
    const { bridge, events } = setup();
    const connecting = bridge.connect();
    sockets[0].readyState = 1;
    sockets[0].emit('open');
    sockets[0].emit('message', JSON.stringify({ type: 'session.started' }));
    expect(await connecting).toBe(true);
    sockets[0].readyState = 3;
    sockets[0].emit('close');
    expect(events.onError).toHaveBeenCalledWith('gpt_live_closed');
    await bridge.close();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('cancels an in-flight connection without waiting for the startup timeout', async () => {
    const { bridge, events } = setup();
    const connecting = bridge.connect();
    await bridge.close();
    expect(await connecting).toBe(false);
    expect(events.onError).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('terminates an unresponsive provider once and ignores late ready events', async () => {
    const { bridge, events } = setup();
    const connecting = bridge.connect();
    sockets[0].readyState = 1;
    const closing = bridge.close();
    expect(bridge.close()).toBe(closing);
    sockets[0].emit('message', JSON.stringify({ type: 'session.started' }));
    await vi.advanceTimersByTimeAsync(5000);
    await closing;
    expect(await connecting).toBe(false);
    expect(events.onReady).not.toHaveBeenCalled();
    expect(events.onError).not.toHaveBeenCalled();
    expect(sockets[0].terminate).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
