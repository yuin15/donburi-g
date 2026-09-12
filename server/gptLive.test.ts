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
function setup(openingContext = '') {
  const events = { onReady: vi.fn(), onError: vi.fn(), onAudio: vi.fn(), onTranscript: vi.fn(), onUserSpeech: vi.fn(), onUsage: vi.fn() };
  return { bridge: new GptLiveBridge(events, openingContext), events };
}
beforeEach(() => { sockets.length = 0; vi.useFakeTimers(); });
afterEach(() => vi.useRealTimers());

describe('voice transport teardown', () => {
  it('includes confirmed result context in session.start before the new voice is ready', async () => {
    const resultContext = '試合は終了済み。残り0秒、プレイヤー3640点、あなた3200点、状態=result,勝者=player。確定結果への短い一言だけを話す。';
    const { bridge, events } = setup(resultContext);
    const connecting = bridge.connect();
    sockets[0].readyState = 1;
    sockets[0].emit('open');
    expect(events.onReady).not.toHaveBeenCalled();
    expect(sockets[0].send).toHaveBeenCalledTimes(1);
    const start = JSON.parse(sockets[0].send.mock.calls[0][0]);
    expect(start).toMatchObject({
      type: 'session.start',
      session: {
        model: 'test-model', store: false,
        instructions: expect.stringContaining(resultContext),
        audio: { format: { type: 'audio/pcm', rate: 24000 }, output: { voice: 'test-voice' } },
      },
    });
    expect(start.session.instructions).toContain('日本語で話す');
    bridge.updateGameContext('not-ready context');
    expect(sockets[0].send).toHaveBeenCalledTimes(1);
    sockets[0].emit('message', JSON.stringify({ type: 'session.started' }));
    expect(await connecting).toBe(true);
    expect(events.onReady).toHaveBeenCalledOnce();
    const closing = bridge.close();
    sockets[0].emit('message', JSON.stringify({ type: 'session.closed', usage: { seconds: 0 } }));
    await closing;
    expect(vi.getTimerCount()).toBe(0);
  });

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
describe('live conversation pacing', () => {
  it('interrupts on microphone speech despite continuous silent output, then preserves the new reply', async () => {
    const { bridge, events } = setup();
    const connecting = bridge.connect();
    const socket = sockets[0];
    socket.readyState = 1;
    socket.emit('message', JSON.stringify({ type: 'session.started' }));
    await connecting;
    const quiet = Buffer.alloc(4800).toString('base64');
    const voice = Buffer.alloc(4800, 4).toString('base64');
    for (let i = 0; i < 10; i++) {
      socket.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: quiet }));
      await vi.advanceTimersByTimeAsync(100);
    }
    socket.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: voice }));
    events.onAudio.mockClear();
    bridge.sendMic(voice);
    expect(events.onUserSpeech).not.toHaveBeenCalled();
    bridge.sendMic(voice);
    expect(events.onUserSpeech).toHaveBeenCalledOnce();
    bridge.sendMic(voice);
    expect(events.onUserSpeech).toHaveBeenCalledOnce();
    socket.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: voice }));
    expect(events.onAudio).not.toHaveBeenCalled();
    for (let i = 0; i < 3; i++) socket.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: quiet }));
    socket.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: voice }));
    expect(events.onAudio).toHaveBeenLastCalledWith(voice);
    const count = socket.send.mock.calls.length;
    bridge.requestReaction('stale game commentary');
    expect(socket.send).toHaveBeenCalledTimes(count);
    const closing = bridge.close();
    socket.emit('message', JSON.stringify({ type: 'session.closed', usage: { seconds: 1 } }));
    await closing;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('replaces pending game updates with the latest one instead of queuing every clock tick', async () => {
    const { bridge } = setup();
    const connecting = bridge.connect();
    const socket = sockets[0];
    socket.readyState = 1;
    socket.emit('message', JSON.stringify({ type: 'session.started' }));
    await connecting;
    bridge.updateGameContext('first score');
    const first = JSON.parse(socket.send.mock.calls[0][0]);
    for (let i = 0; i < 30; i++) bridge.updateGameContext('score ' + i);
    expect(socket.send).toHaveBeenCalledTimes(1);
    socket.emit('message', JSON.stringify({ type: 'session.thinking.appended', client_event_id: 'unrelated' }));
    expect(socket.send).toHaveBeenCalledTimes(1);
    socket.emit('message', JSON.stringify({ type: 'session.thinking.appended', client_event_id: first.event_id }));
    expect(socket.send).toHaveBeenCalledTimes(2);
    const latest = JSON.parse(socket.send.mock.calls[1][0]);
    expect(latest.content).toBe('score 29');
    expect(latest.event_id).not.toBe(first.event_id);
    bridge.updateGameContext('score 29');
    socket.emit('message', JSON.stringify({ type: 'session.thinking.appended', client_event_id: latest.event_id }));
    expect(socket.send).toHaveBeenCalledTimes(2);
    const closing = bridge.close();
    socket.emit('message', JSON.stringify({ type: 'session.closed', usage: { seconds: 1 } }));
    await closing;
  });
});
