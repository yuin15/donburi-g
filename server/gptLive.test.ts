import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventEmitter } from 'node:events';
import { GptLiveBridge } from './gptLive';
type FakeSocket = EventEmitter & { readyState: number; send: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn> };
const sockets = vi.hoisted(() => [] as FakeSocket[]);
vi.mock('./env', () => ({ env: { openaiKey: 'test-only-key', gptLiveModel: 'test-model', gptLiveVoice: 'test-voice' } }));
vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events');
  return { default: class extends EventEmitter {
    static OPEN = 1;
    static CLOSED = 3;
    readyState = 0;
    send = vi.fn();
    terminate = vi.fn(() => { this.readyState = 3; this.emit('close'); });
    constructor() { super(); sockets.push(this); }
  } };
});
function setup() {
  const events = { onReady: vi.fn(), onError: vi.fn(), onAudio: vi.fn(), onTranscript: vi.fn(), onUserSpeech: vi.fn() };
  return { bridge: new GptLiveBridge(events), events };
}
beforeEach(() => { sockets.length = 0; vi.useFakeTimers(); });
afterEach(() => vi.useRealTimers());

describe('voice transport teardown', () => {
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
    await vi.advanceTimersByTimeAsync(1500);
    await closing;
    expect(await connecting).toBe(false);
    expect(events.onReady).not.toHaveBeenCalled();
    expect(events.onError).not.toHaveBeenCalled();
    expect(sockets[0].terminate).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
