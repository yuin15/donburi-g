import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventEmitter } from 'node:events';
import { GptLiveBridge } from './gptLive';
import { MediaServerLeg } from './mediaServer';
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
function setup(openingContext = '', language: 'ja' | 'en' = 'ja') {
  const events = { onReady: vi.fn(), onError: vi.fn(), onAudio: vi.fn(), onSpeechAudioEnded: vi.fn(), onTranscript: vi.fn(), onDelegation: vi.fn(), onUserSpeech: vi.fn(), onUserSpeechEnd: vi.fn(), onNormalSpeechStarted: vi.fn(), onCommandRejected: vi.fn(), onUsage: vi.fn() };
  return { bridge: new GptLiveBridge(events, openingContext, language), events };
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
        delegation: { type: 'client' },
        instructions: expect.stringContaining(resultContext),
        audio: { format: { type: 'audio/pcm', rate: 24000 }, output: { voice: 'test-voice' } },
      },
    });
    expect(start.session.instructions).toContain('日本語で話す');
    expect(start.session.instructions).toContain('両者は$30で開始');
    expect(start.session.instructions).toContain('$1は中央1ライン');
    expect(start.session.instructions).toContain('確定した自分のBETだけ');
    expect(start.session.instructions).toContain('双方の確定残高が$0の会話');
    expect(start.session.instructions).toContain('まず資金切れか台への軽い愚痴・感想');
    expect(start.session.instructions).toContain('質問や訂正には必要な説明');
    expect(start.session.instructions).toContain('自動の時間延長を誘わず');
    expect(start.session.instructions).toContain('合意ごとに扱う');
    expect(start.session.instructions).toContain('貸し借りと時間延長の合意には自然に返答する');
    expect(start.session.instructions).not.toContain('時間延長が未使用なら');
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

  it('forwards only a well-formed client delegation with its opaque ID and offset', async () => {
    const { bridge, events } = setup();
    const connecting = bridge.connect();
    const socket = sockets[0];
    socket.readyState = 1;
    socket.emit('message', JSON.stringify({ type: 'session.started' }));
    await connecting;
    socket.emit('message', JSON.stringify({ type: 'session.delegation.created', offset_ms: 800, delegation: { id: 'item_opaque', target: 'client' } }));
    socket.emit('message', JSON.stringify({ type: 'session.delegation.created', offset_ms: 801, delegation: { id: 'ignored', target: 'responses' } }));
    expect(events.onDelegation).toHaveBeenCalledExactlyOnceWith({ id: 'item_opaque', offsetMs: 800 });
    const closing = bridge.close();
    socket.emit('close');
    await closing;
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
  it.each(['normal', 'confirmed'] as const)('interrupts actual Avatar %s playback before releasing subsequent normal and confirmed replies', async kind => {
    const { bridge, events } = setup();
    const connecting = bridge.connect();
    const socket = sockets[0]; socket.readyState = 1;
    socket.emit('message', JSON.stringify({ type: 'session.started' })); await connecting;
    const playbackDone = vi.fn((id: string) => bridge.noteSpeechPlaybackDone(id));
    const media = new MediaServerLeg('wss://test.invalid', vi.fn(), playbackDone);
    const starting = media.start();
    const avatar = sockets[1]; avatar.readyState = 1; avatar.emit('open');
    avatar.emit('message', JSON.stringify({ type: 'session.state_updated', state: 'connected' })); await starting;
    events.onAudio.mockImplementation((audio: string, id: string) => media.speak(audio, id));
    events.onSpeechAudioEnded.mockImplementation((id: string) => media.completeSpeechInput(id));
    const pcm = Buffer.alloc(19_200, 4).toString('base64');
    const audio = () => socket.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: pcm }));
    const commands = () => avatar.send.mock.calls.map(([raw]) => JSON.parse(raw));
    const ack = (type: string, id: string) => avatar.emit('message', JSON.stringify({ type, source_event_id: id }));
    if (kind === 'confirmed') bridge.requestConfirmedLine('synthetic confirmed line', 'confirmed-old');
    audio();
    const oldSpeech = events.onAudio.mock.calls[0][1];
    const oldUtterance = commands().at(-1).event_id;
    const interrupt = bridge.beginUserSpeech();
    expect(interrupt).not.toBeNull();
    const clearing = media.interruptAndWait(2000).then(cleared => { if (cleared) bridge.finishPlaybackInterrupt(interrupt!); });
    const interruptId = commands().at(-1).event_id;
    expect(commands().at(-1).type).toBe('agent.interrupt');
    // Already-forwarded audio still gets its settlement fence exactly once.
    expect(events.onSpeechAudioEnded).toHaveBeenCalledExactlyOnceWith(oldSpeech);
    audio();
    ack('agent.speak_ended', oldUtterance);
    ack('agent.audio_buffer_cleared', 'stale-interrupt');
    bridge.noteSpeechPlaybackDone(oldSpeech);
    await vi.advanceTimersByTimeAsync(1000);
    expect(events.onAudio).toHaveBeenCalledTimes(1);
    expect(commands().filter(event => event.type === 'agent.speak')).toHaveLength(1);
    ack('agent.audio_buffer_cleared', interruptId);
    await clearing;
    expect(events.onAudio).toHaveBeenCalledTimes(2);
    const nextSpeech = events.onAudio.mock.calls[1][1];
    expect(events.onAudio.mock.calls[1]).toEqual([pcm, nextSpeech, 'normal']);
    const nextUtterance = commands().at(-1).event_id;
    expect(nextUtterance).not.toBe(oldUtterance);
    await vi.advanceTimersByTimeAsync(500);
    ack('agent.speak_ended', oldUtterance);
    expect(playbackDone).not.toHaveBeenCalled();
    ack('agent.speak_ended', nextUtterance);
    expect(playbackDone).toHaveBeenCalledExactlyOnceWith(nextSpeech);
    bridge.setConversationLanguage('ja');
    bridge.requestConfirmedLine('synthetic next confirmation', 'confirmed-next');
    const commentaryCount = () => socket.send.mock.calls.filter(([raw]) => JSON.parse(raw).type === 'session.commentary.append').length;
    const before = commentaryCount();
    await vi.advanceTimersByTimeAsync(4999);
    expect(commentaryCount()).toBe(before);
    await vi.advanceTimersByTimeAsync(1);
    expect(commentaryCount()).toBe(before + 1);
    audio();
    expect(events.onAudio).toHaveBeenLastCalledWith(pcm, 'confirmed-next', 'confirmed');
    const confirmedUtterance = commands().at(-1).event_id;
    await vi.advanceTimersByTimeAsync(900);
    ack('agent.speak_ended', confirmedUtterance);
    expect(playbackDone).toHaveBeenLastCalledWith('confirmed-next');
    audio();
    expect(events.onAudio).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(5000);
    expect(events.onAudio).toHaveBeenCalledTimes(4);
    expect(events.onAudio.mock.calls.at(-1)![2]).toBe('normal');
    media.close();
    const closing = bridge.close(); socket.emit('close'); await closing;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores an older interrupt completion, retains new PCM through fallback, and invalidates completion on close', async () => {
    const { bridge, events } = setup();
    const connecting = bridge.connect();
    const socket = sockets[0]; socket.readyState = 1;
    socket.emit('message', JSON.stringify({ type: 'session.started' })); await connecting;
    const pcm = Buffer.alloc(4800, 4).toString('base64');
    const audio = () => socket.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: pcm }));
    audio();
    const first = bridge.beginUserSpeech()!;
    audio(); // Still unplayed when a second interruption supersedes it.
    const second = bridge.beginUserSpeech()!;
    expect(second).not.toBe(first);
    audio();
    bridge.finishPlaybackInterrupt(first);
    bridge.interruptPlayback(); // Avatar fallback must not discard the new queued reply.
    bridge.noteSpeechPlaybackDone('normal-1');
    await vi.advanceTimersByTimeAsync(900);
    expect(events.onAudio).toHaveBeenCalledTimes(1);
    bridge.finishPlaybackInterrupt(second);
    expect(events.onAudio).toHaveBeenLastCalledWith(pcm, 'normal-3', 'normal');
    expect(events.onAudio).toHaveBeenCalledTimes(2);
    bridge.finishPlaybackInterrupt(first);
    audio();
    await vi.advanceTimersByTimeAsync(900);
    expect(events.onAudio).toHaveBeenCalledTimes(2); // Stale completion cannot clear normal-3.
    bridge.noteSpeechPlaybackDone('normal-3');
    await vi.advanceTimersByTimeAsync(5000);
    expect(events.onAudio).toHaveBeenLastCalledWith(pcm, 'normal-4', 'normal');
    const third = bridge.beginUserSpeech()!;
    audio();
    const closing = bridge.close();
    bridge.finishPlaybackInterrupt(third);
    socket.emit('close'); await closing;
    expect(events.onAudio).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('streams the first PCM before any transcript and never waits for agreement classification', async () => {
    const { bridge, events } = setup();
    const connecting = bridge.connect();
    const socket = sockets[0];
    socket.readyState = 1;
    socket.emit('message', JSON.stringify({ type: 'session.started' }));
    await connecting;
    bridge.beginUserSpeech();
    bridge.endUserSpeech();
    const pcm = Buffer.alloc(4800, 4).toString('base64');
    socket.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: pcm }));
    expect(events.onNormalSpeechStarted).toHaveBeenCalledExactlyOnceWith('normal-1');
    expect(events.onAudio).toHaveBeenCalledExactlyOnceWith(pcm, 'normal-1', 'normal');
    expect(events.onSpeechAudioEnded).not.toHaveBeenCalled();
    socket.emit('message', JSON.stringify({ type: 'session.output_transcript.delta', delta: 'synthetic delayed subtitle', start_ms: 10, end_ms: 100 }));
    expect(events.onTranscript).toHaveBeenCalledExactlyOnceWith('assistant', 'synthetic delayed subtitle', { startMs: 10, endMs: 100 });
    const closing = bridge.close(); socket.emit('close'); await closing;
  });

  it('plays repeated untimed replies and preserves captions with active and queued PCM or missing captions', async () => {
    const { bridge, events } = setup();
    const connecting = bridge.connect();
    const socket = sockets[0]; socket.readyState = 1;
    socket.emit('message', JSON.stringify({ type: 'session.started' })); await connecting;
    const pcm = Buffer.alloc(4800, 4).toString('base64');
    const audio = () => socket.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: pcm }));
    audio(); await vi.advanceTimersByTimeAsync(900);
    audio(); await vi.advanceTimersByTimeAsync(900); // queued, no captions
    audio(); // active + queued, neither has timing
    socket.emit('message', JSON.stringify({ type: 'session.output_transcript.delta', delta: 'synthetic late caption', start_ms: 50, end_ms: 200 }));
    expect(events.onTranscript).toHaveBeenCalledExactlyOnceWith('assistant', 'synthetic late caption', { startMs: 50, endMs: 200 });
    expect(events.onAudio).toHaveBeenCalledTimes(1);
    bridge.noteSpeechPlaybackDone('normal-1');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(events.onAudio).toHaveBeenCalledTimes(2);
    bridge.noteSpeechPlaybackDone('normal-2');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(events.onAudio).toHaveBeenCalledTimes(3);
    const closing = bridge.close(); socket.emit('close'); await closing;
  });

  it('accepts one proactive invitation only when the commentary path is currently safe', async () => {
    const { bridge } = setup();
    const connecting = bridge.connect();
    const socket = sockets[0];
    socket.readyState = 1;
    socket.emit('message', JSON.stringify({ type: 'session.started' }));
    await connecting;
    expect(bridge.requestConversationInvitation()).toBe(true);
    expect(JSON.parse(socket.send.mock.calls.at(-1)![0])).toMatchObject({ type: 'session.commentary.append', delegation_id: null });
    expect(bridge.requestConversationInvitation()).toBe(false);
    const voice = Buffer.alloc(4800, 4).toString('base64');
    bridge.sendMic(voice);
    bridge.sendMic(voice);
    expect(bridge.requestConversationInvitation()).toBe(false);
    const closing = bridge.close();
    socket.emit('message', JSON.stringify({ type: 'session.closed', usage: { seconds: 1 } }));
    await closing;
  });

  it('interrupts on microphone speech despite continuous silent output, then preserves the new reply', async () => {
    const { bridge, events } = setup();
    const connecting = bridge.connect();
    const socket = sockets[0];
    socket.readyState = 1;
    socket.emit('open');
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
    socket.emit('message', JSON.stringify({ type: 'session.output_transcript.delta', delta: 'interrupted old reply' }));
    for (let i = 0; i < 3; i++) socket.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: quiet }));
    socket.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: voice }));
    socket.emit('message', JSON.stringify({ type: 'session.output_transcript.delta', delta: 'new reply' }));
    await vi.advanceTimersByTimeAsync(1_020);
    expect(events.onAudio).toHaveBeenLastCalledWith(voice, expect.stringMatching(/^normal-/), 'normal');
    expect(events.onTranscript).toHaveBeenLastCalledWith('assistant', 'new reply', { startMs: null, endMs: null });
    bridge.noteSpeechPlaybackDone(events.onAudio.mock.calls.at(-1)![1]);
    const count = socket.send.mock.calls.length;
    bridge.requestReaction('stale game commentary');
    expect(socket.send).toHaveBeenCalledTimes(count);
    const closing = bridge.close();
    socket.emit('message', JSON.stringify({ type: 'session.closed', usage: { seconds: 1 } }));
    await closing;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports bridge input timeline ranges for user VAD boundaries', async () => {
    const { bridge, events } = setup();
    const connecting = bridge.connect();
    const socket = sockets[0];
    socket.readyState = 1;
    socket.emit('message', JSON.stringify({ type: 'session.started' }));
    await connecting;
    const voice = Buffer.alloc(4800, 4).toString('base64');
    const quiet = Buffer.alloc(4800).toString('base64');
    bridge.sendMic(voice);
    bridge.sendMic(voice);
    for (let i = 0; i < 5; i += 1) bridge.sendMic(quiet);
    expect(events.onUserSpeech).toHaveBeenCalledExactlyOnceWith({ startMs: 0, endMs: 200 });
    expect(events.onUserSpeechEnd).toHaveBeenCalledExactlyOnceWith({ startMs: 0, endMs: 700 });
    expect(socket.send.mock.calls.filter(([raw]) => JSON.parse(raw).type === 'session.input_audio.append')).toHaveLength(7);
    const closing = bridge.close();
    socket.emit('message', JSON.stringify({ type: 'session.closed', usage: { seconds: 1 } }));
    await closing;
  });

  it('releases ordinary replies after their playback gaps', async () => {
    const { bridge, events } = setup();
    const connecting = bridge.connect();
    const socket = sockets[0];
    socket.readyState = 1;
    socket.emit('message', JSON.stringify({ type: 'session.started' }));
    await connecting;
    const voice = Buffer.alloc(4800, 4).toString('base64');
    bridge.sendMic(voice);
    bridge.sendMic(voice);
    socket.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: voice }));
    socket.emit('message', JSON.stringify({ type: 'session.output_transcript.delta', delta: 'first ordinary reply' }));
    await vi.advanceTimersByTimeAsync(1_020);
    expect(events.onAudio).toHaveBeenLastCalledWith(voice, expect.stringMatching(/^normal-/), 'normal');
    bridge.noteSpeechPlaybackDone(events.onAudio.mock.calls.at(-1)![1]);
    await vi.advanceTimersByTimeAsync(5_001);
    socket.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: voice }));
    socket.emit('message', JSON.stringify({ type: 'session.output_transcript.delta', delta: 'second ordinary reply' }));
    await vi.advanceTimersByTimeAsync(1_020);
    expect(events.onAudio).toHaveBeenCalledTimes(2);
    const closing = bridge.close();
    socket.emit('message', JSON.stringify({ type: 'session.closed' }));
    await closing;
  });

  it('releases only a sent invalid request and treats unknown provider errors as fatal', async () => {
    const { bridge, events } = setup();
    const connecting = bridge.connect();
    const socket = sockets[0];
    socket.readyState = 1;
    socket.emit('message', JSON.stringify({ type: 'session.started' }));
    await connecting;
    bridge.requestConfirmedLine('確定台詞', 'confirmed-id');
    const request = JSON.parse(socket.send.mock.calls.at(-1)![0]);
    socket.emit('message', JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', client_event_id: request.event_id } }));
    expect(events.onCommandRejected).toHaveBeenCalledExactlyOnceWith({ kind: 'commentary', speechId: 'confirmed-id' });
    expect(events.onError).not.toHaveBeenCalled();
    socket.emit('message', JSON.stringify({ type: 'error', error: { type: 'server_error', client_event_id: request.event_id } }));
    expect(events.onError).toHaveBeenCalledExactlyOnceWith('fatal');
    const closing = bridge.close();
    socket.emit('close');
    await closing;
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

  it('accepts a $0 transition reaction as a short response and tells the model to wait afterward', async () => {
    const { bridge } = setup();
    const connecting = bridge.connect();
    const socket = sockets[0];
    socket.readyState = 1;
    socket.emit('message', JSON.stringify({ type: 'session.started' }));
    await connecting;
    expect(bridge.requestReaction('雑談へ一度だけ誘う。')).toBe(true);
    const reaction = JSON.parse(socket.send.mock.calls.at(-1)![0]);
    expect(reaction).toMatchObject({ type: 'session.commentary.append' });
    expect(reaction.content).toContain('短い返答だけを発話');
    expect(reaction.content).toContain('同じ誘いを足さず黙って待つ');
    const closing = bridge.close();
    socket.emit('message', JSON.stringify({ type: 'session.closed', usage: { seconds: 1 } }));
    await closing;
  });

  it('drops a normal reply until its quiet boundary, then queues the confirmed line on the supported commentary path', async () => {
    const { bridge, events } = setup();
    const connecting = bridge.connect();
    const socket = sockets[0];
    socket.readyState = 1;
    socket.emit('open');
    socket.emit('message', JSON.stringify({ type: 'session.started' }));
    await connecting;
    const oldVoice = Buffer.alloc(4800, 4).toString('base64');
    const quiet = Buffer.alloc(4800).toString('base64');
    bridge.suppressOutput();
    socket.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: oldVoice }));
    socket.emit('message', JSON.stringify({ type: 'session.output_transcript.delta', delta: 'I accept before the result is ready' }));
    expect(events.onAudio).not.toHaveBeenCalled();
    expect(events.onTranscript).not.toHaveBeenCalled();
    bridge.requestConfirmedLine('いいよ。あと10秒、見せてみな。');
    bridge.requestDelegationResult('item_opaque', 'いいよ。あと10秒、見せてみな。', 'speech-opaque');
    expect(JSON.parse(socket.send.mock.calls.at(-1)![0]).type).not.toBe('session.commentary.append');
    socket.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: quiet }));
    socket.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: quiet }));
    const confirmed = JSON.parse(socket.send.mock.calls.at(-1)![0]);
    expect(confirmed).toMatchObject({ type: 'session.commentary.append' });
    expect(confirmed).toMatchObject({ delegation_id: 'item_opaque', content: 'いいよ。あと10秒、見せてみな。' });
    socket.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: oldVoice }));
    expect(events.onAudio).toHaveBeenLastCalledWith(oldVoice, 'speech-opaque', 'confirmed');
    expect(events.onSpeechAudioEnded).not.toHaveBeenCalled();
    for (let i = 0; i < 9; i++) socket.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: quiet }));
    expect(events.onSpeechAudioEnded).toHaveBeenCalledExactlyOnceWith('speech-opaque');
    const closing = bridge.close();
    socket.emit('message', JSON.stringify({ type: 'session.closed', usage: { seconds: 1 } }));
    await closing;
  });

  it('serializes simultaneous tagged confirmed lines instead of replacing the first pending line', async () => {
    const { bridge, events } = setup();
    const connecting = bridge.connect();
    const socket = sockets[0];
    socket.readyState = 1;
    socket.emit('message', JSON.stringify({ type: 'session.started' }));
    await connecting;
    const voice = Buffer.alloc(4800, 4).toString('base64');
    const quiet = Buffer.alloc(4800).toString('base64');

    bridge.beginUserSpeech();
    bridge.requestConfirmedLine('最初の確定台詞。', 'first-confirmed');
    bridge.requestConfirmedLine('次の確定台詞。', 'second-confirmed');
    bridge.setConversationLanguage('ja');
    socket.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: quiet }));
    socket.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: quiet }));
    expect(JSON.parse(socket.send.mock.calls.at(-1)![0])).toMatchObject({ content: expect.stringContaining('最初の確定台詞。') });
    socket.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: voice }));
    for (let index = 0; index < 9; index += 1) socket.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: quiet }));
    expect(events.onSpeechAudioEnded).toHaveBeenCalledExactlyOnceWith('first-confirmed');
    bridge.noteSpeechPlaybackDone('first-confirmed');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(JSON.parse(socket.send.mock.calls.at(-1)![0])).toMatchObject({ content: expect.stringContaining('次の確定台詞。') });
    const closing = bridge.close();
    socket.emit('message', JSON.stringify({ type: 'session.closed', usage: { seconds: 1 } }));
    await closing;
  });

  it('tags a confirmed line with its supplied speech ID through audio and playback completion', async () => {
    const { bridge, events } = setup();
    const connecting = bridge.connect();
    const socket = sockets[0];
    socket.readyState = 1;
    socket.emit('message', JSON.stringify({ type: 'session.started' }));
    await connecting;
    bridge.requestConfirmedLine('お金がなくなっちゃった。5ドル貸してくれない？', 'loan-offer-speech');
    const request = JSON.parse(socket.send.mock.calls.at(-1)![0]);
    expect(request).toMatchObject({ type: 'session.commentary.append', delegation_id: null });
    const voice = Buffer.alloc(4800, 4).toString('base64');
    const quiet = Buffer.alloc(4800).toString('base64');
    socket.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: voice }));
    expect(events.onAudio).toHaveBeenLastCalledWith(voice, 'loan-offer-speech', 'confirmed');
    for (let i = 0; i < 9; i += 1) socket.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: quiet }));
    expect(events.onSpeechAudioEnded).toHaveBeenCalledExactlyOnceWith('loan-offer-speech');
    const closing = bridge.close();
    socket.emit('message', JSON.stringify({ type: 'session.closed', usage: { seconds: 1 } }));
    await closing;
  });

  it('waits for actual normal playback completion, then prefers a confirmed result over a buffered normal reply', async () => {
    const { bridge, events } = setup();
    const connecting = bridge.connect();
    const socket = sockets[0];
    socket.readyState = 1;
    socket.emit('message', JSON.stringify({ type: 'session.started' }));
    await connecting;
    const voice = Buffer.alloc(4800, 4).toString('base64');
    socket.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: voice }));
    socket.emit('message', JSON.stringify({ type: 'session.output_transcript.delta', delta: 'old reply' }));
    await vi.advanceTimersByTimeAsync(1_020);
    expect(events.onAudio).toHaveBeenLastCalledWith(voice, 'normal-1', 'normal');
    bridge.noteSpeechPlaybackDone('normal-1');
    const sent = socket.send.mock.calls.length;
    bridge.requestConfirmedLine('結果はあとで伝える。', 'result-line');
    expect(socket.send).toHaveBeenCalledTimes(sent);
    socket.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: voice }));
    await vi.advanceTimersByTimeAsync(900);
    expect(events.onAudio).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4_099);
    expect(events.onAudio).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(JSON.parse(socket.send.mock.calls.at(-1)![0])).toMatchObject({ type: 'session.commentary.append', content: expect.stringContaining('結果はあとで伝える。') });
    const closing = bridge.close();
    socket.emit('message', JSON.stringify({ type: 'session.closed', usage: { seconds: 1 } }));
    await closing;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('paces normal PCM by playback ACK while forwarding provider captions independently', async () => {
    const { bridge, events } = setup();
    const connecting = bridge.connect();
    const socket = sockets[0];
    socket.readyState = 1;
    socket.emit('message', JSON.stringify({ type: 'session.started' }));
    await connecting;
    const voice = Buffer.alloc(4800, 4).toString('base64');
    socket.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: voice }));
    socket.emit('message', JSON.stringify({ type: 'session.output_transcript.delta', delta: '最初の返事' }));
    await vi.advanceTimersByTimeAsync(1_020);
    bridge.noteSpeechPlaybackDone('normal-1');
    events.onAudio.mockClear();
    events.onTranscript.mockClear();
    socket.emit('message', JSON.stringify({ type: 'session.output_transcript.delta', delta: '次の返事' }));
    socket.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: voice }));
    expect(events.onTranscript).toHaveBeenCalledExactlyOnceWith('assistant', '次の返事', { startMs: null, endMs: null });
    expect(events.onAudio).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(events.onAudio).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(events.onAudio).toHaveBeenLastCalledWith(voice, 'normal-2', 'normal');
    expect(events.onTranscript).toHaveBeenCalledExactlyOnceWith('assistant', '次の返事', { startMs: null, endMs: null });
    const closing = bridge.close();
    socket.emit('message', JSON.stringify({ type: 'session.closed', usage: { seconds: 1 } }));
    await closing;
  });

  it('releases a normal utterance that the session never handed to an audio player', async () => {
    const { bridge, events } = setup();
    const connecting = bridge.connect();
    const socket = sockets[0];
    socket.readyState = 1;
    socket.emit('message', JSON.stringify({ type: 'session.started' }));
    await connecting;
    const voice = Buffer.alloc(4800, 4).toString('base64');
    socket.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: voice }));
    socket.emit('message', JSON.stringify({ type: 'session.output_transcript.delta', delta: '普通の返事' }));
    await vi.advanceTimersByTimeAsync(1_020);
    expect(events.onAudio).toHaveBeenLastCalledWith(voice, 'normal-1', 'normal');
    bridge.discardNormalPlayback('normal-1');
    bridge.requestConfirmedLine('抑止後の確定台詞。', 'confirmed-after-suppression');
    expect(JSON.parse(socket.send.mock.calls.at(-1)![0])).toMatchObject({
      type: 'session.commentary.append',
      content: expect.stringContaining('抑止後の確定台詞。'),
    });
    const closing = bridge.close();
    socket.emit('message', JSON.stringify({ type: 'session.closed', usage: { seconds: 1 } }));
    await closing;
  });

  it('does not recurse when a suppressed normal playback is released while the next utterance is collecting', async () => {
    const { bridge, events } = setup();
    const connecting = bridge.connect();
    const socket = sockets[0];
    socket.readyState = 1;
    socket.emit('message', JSON.stringify({ type: 'session.started' }));
    await connecting;
    const voice = Buffer.alloc(4800, 4).toString('base64');
    socket.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: voice }));
    socket.emit('message', JSON.stringify({ type: 'session.output_transcript.delta', delta: '最初の返事' }));
    await vi.advanceTimersByTimeAsync(1_020);
    expect(events.onAudio).toHaveBeenLastCalledWith(voice, 'normal-1', 'normal');
    socket.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: voice }));
    socket.emit('message', JSON.stringify({ type: 'session.output_transcript.delta', delta: '次の返事' }));
    expect(() => bridge.discardNormalPlayback('normal-1')).not.toThrow();
    await vi.advanceTimersByTimeAsync(1_020);
    expect(events.onAudio).toHaveBeenLastCalledWith(voice, 'normal-2', 'normal');
    const closing = bridge.close();
    socket.emit('message', JSON.stringify({ type: 'session.closed', usage: { seconds: 1 } }));
    await closing;
  });

  it('holds a confirmed line until a queued normal utterance reaches its quiet boundary', async () => {
    const { bridge, events } = setup();
    const connecting = bridge.connect();
    const socket = sockets[0];
    socket.readyState = 1;
    socket.emit('message', JSON.stringify({ type: 'session.started' }));
    await connecting;
    const voice = Buffer.alloc(4800, 4).toString('base64');
    socket.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: voice }));
    socket.emit('message', JSON.stringify({ type: 'session.output_transcript.delta', delta: '最初の返事' }));
    await vi.advanceTimersByTimeAsync(1_020);
    bridge.noteSpeechPlaybackDone('normal-1');
    socket.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: voice }));
    socket.emit('message', JSON.stringify({ type: 'session.output_transcript.delta', delta: 'キューされた返事' }));
    expect(() => bridge.requestConfirmedLine('確定した延長台詞。', 'confirmed-during-normal')).not.toThrow();
    expect(socket.send).not.toHaveBeenCalledWith(expect.stringContaining('確定した延長台詞。'));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(JSON.parse(socket.send.mock.calls.at(-1)![0])).toMatchObject({
      type: 'session.commentary.append',
      content: expect.stringContaining('確定した延長台詞。'),
    });
    expect(events.onAudio).toHaveBeenCalledExactlyOnceWith(voice, 'normal-1', 'normal');
    const closing = bridge.close();
    socket.emit('message', JSON.stringify({ type: 'session.closed', usage: { seconds: 1 } }));
    await closing;
  });

  it('holds a delegated result until a queued normal utterance reaches its quiet boundary', async () => {
    const { bridge, events } = setup();
    const connecting = bridge.connect();
    const socket = sockets[0];
    socket.readyState = 1;
    socket.emit('message', JSON.stringify({ type: 'session.started' }));
    await connecting;
    const voice = Buffer.alloc(4800, 4).toString('base64');
    socket.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: voice }));
    socket.emit('message', JSON.stringify({ type: 'session.output_transcript.delta', delta: '最初の返事' }));
    await vi.advanceTimersByTimeAsync(1_020);
    bridge.noteSpeechPlaybackDone('normal-1');
    socket.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: voice }));
    socket.emit('message', JSON.stringify({ type: 'session.output_transcript.delta', delta: 'キューされた返事' }));
    expect(() => bridge.requestDelegationResult('extension-delegation', '確定した委任結果。', 'delegated-during-normal')).not.toThrow();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(JSON.parse(socket.send.mock.calls.at(-1)![0])).toMatchObject({
      type: 'session.commentary.append',
      delegation_id: 'extension-delegation',
      content: expect.stringContaining('確定した委任結果。'),
    });
    expect(events.onAudio).toHaveBeenCalledExactlyOnceWith(voice, 'normal-1', 'normal');
    const closing = bridge.close();
    socket.emit('message', JSON.stringify({ type: 'session.closed', usage: { seconds: 1 } }));
    await closing;
  });

  it('uses the settled English state for confirmed and delegated fixed lines', async () => {
    const { bridge } = setup('', 'en');
    const connecting = bridge.connect();
    const socket = sockets[0];
    socket.readyState = 1;
    socket.emit('message', JSON.stringify({ type: 'session.started' }));
    await connecting;
    bridge.requestConfirmedLine({ ja: '日本語の確定台詞', en: 'Confirmed English line.' });
    expect(JSON.parse(socket.send.mock.calls.at(-1)![0]).content).toContain('Confirmed English line.');
    bridge.requestDelegationResult('english-turn', { ja: '日本語の委任台詞', en: 'Delegated English line.' }, 'english-speech');
    expect(JSON.parse(socket.send.mock.calls.at(-1)![0])).toMatchObject({ delegation_id: 'english-turn', content: expect.stringContaining('Delegated English line.') });
    const closing = bridge.close();
    socket.emit('message', JSON.stringify({ type: 'session.closed', usage: { seconds: 1 } }));
    await closing;
  });
  it('cancels only a matching queued or active confirmed speech', async () => {
    const { bridge, events } = setup();
    const connecting = bridge.connect();
    const socket = sockets[0];
    socket.readyState = 1;
    socket.emit('message', JSON.stringify({ type: 'session.started' }));
    await connecting;
    bridge.suppressOutput();
    bridge.requestConfirmedLine('取り消す延長台詞', 'cancelled-extension');
    bridge.cancelConfirmedSpeech('other-speech');
    bridge.cancelConfirmedSpeech('cancelled-extension');
    await vi.advanceTimersByTimeAsync(4_000);
    expect(socket.send.mock.calls.map(([raw]) => JSON.parse(raw).content)).not.toContain(expect.stringContaining('取り消す延長台詞'));
    bridge.requestConfirmedLine('残す確認台詞', 'kept-speech');
    const voice = Buffer.alloc(4800, 4).toString('base64');
    socket.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: voice }));
    bridge.cancelConfirmedSpeech('kept-speech');
    await vi.advanceTimersByTimeAsync(900);
    expect(events.onSpeechAudioEnded).not.toHaveBeenCalled();
    const closing = bridge.close();
    socket.emit('message', JSON.stringify({ type: 'session.closed', usage: { seconds: 1 } }));
    await closing;
  });
});
