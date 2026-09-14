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
function setup(openingContext = '', language: 'ja' | 'en' = 'ja') {
  const events = { onReady: vi.fn(), onError: vi.fn(), onAudio: vi.fn(), onSpeechAudioEnded: vi.fn(), onTranscript: vi.fn(), onDelegation: vi.fn(), onUserSpeech: vi.fn(), onUserSpeechEnd: vi.fn(), onUsage: vi.fn() };
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
    expect(start.session.instructions).toContain('初回だけは短い2文まで許し');
    expect(start.session.instructions).toContain('自動の時間延長を誘わず');
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
    expect(events.onAudio).not.toHaveBeenCalled();
    socket.emit('message', JSON.stringify({ type: 'session.output_transcript.delta', delta: 'interrupted old reply' }));
    expect(events.onTranscript).not.toHaveBeenCalled();
    for (let i = 0; i < 3; i++) socket.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: quiet }));
    socket.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: voice }));
    await vi.advanceTimersByTimeAsync(900);
    expect(events.onAudio).toHaveBeenLastCalledWith(voice, expect.stringMatching(/^normal-/), 'normal');
    bridge.noteSpeechPlaybackDone(events.onAudio.mock.calls.at(-1)![1]);
    socket.emit('message', JSON.stringify({ type: 'session.output_transcript.delta', delta: 'new reply' }));
    expect(events.onTranscript).toHaveBeenCalledExactlyOnceWith('assistant', 'new reply', { startMs: null, endMs: null });
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
    await vi.advanceTimersByTimeAsync(900);
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
