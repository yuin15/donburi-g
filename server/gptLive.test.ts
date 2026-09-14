import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventEmitter } from 'node:events';
import { GptLiveBridge, type NormalSpeechCandidate } from './gptLive';
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
  const events = { onReady: vi.fn(), onError: vi.fn(), onAudio: vi.fn(), onSpeechAudioEnded: vi.fn(), onTranscript: vi.fn(), onDelegation: vi.fn(), onUserSpeech: vi.fn(), onUserSpeechEnd: vi.fn(), onNormalSpeechCandidate: vi.fn<(candidate: NormalSpeechCandidate) => Promise<boolean>>(async () => true), onCommandRejected: vi.fn(), onUsage: vi.fn() };
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
    expect(start.session.instructions).toContain('未確定の通常返答では了承を言わず');
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

  it('releases audited ordinary replies after their quiet and playback gaps', async () => {
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

  it('drops a gated normal tail before activating a tagged confirmed line', async () => {
    const { bridge, events } = setup();
    const connecting = bridge.connect();
    const socket = sockets[0];
    socket.readyState = 1;
    socket.emit('message', JSON.stringify({ type: 'session.started' }));
    await connecting;
    const oldVoice = Buffer.alloc(4800, 4).toString('base64');
    const confirmedVoice = Buffer.alloc(4800, 7).toString('base64');
    const quiet = Buffer.alloc(4800).toString('base64');

    bridge.beginUserSpeech();
    socket.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: oldVoice }));
    socket.emit('message', JSON.stringify({ type: 'session.output_transcript.delta', delta: '古い通常返答' }));
    expect(events.onAudio).not.toHaveBeenCalled();
    expect(events.onTranscript).not.toHaveBeenCalled();
    bridge.requestConfirmedLine('確定した延長台詞。', 'gated-confirmed');
    expect(socket.send).not.toHaveBeenCalled();

    bridge.setConversationLanguage('ja');
    bridge.finishUserTurnGate(true);
    socket.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: oldVoice }));
    socket.emit('message', JSON.stringify({ type: 'session.output_transcript.delta', delta: '遅延した通常了承' }));
    expect(events.onAudio).not.toHaveBeenCalled();
    expect(events.onTranscript).not.toHaveBeenCalled();
    socket.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: quiet }));
    socket.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: quiet }));
    expect(JSON.parse(socket.send.mock.calls.at(-1)![0])).toMatchObject({
      type: 'session.commentary.append', content: expect.stringContaining('確定した延長台詞。'),
    });
    socket.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: confirmedVoice }));
    expect(events.onAudio).toHaveBeenCalledExactlyOnceWith(confirmedVoice, 'gated-confirmed', 'confirmed');
    expect(events.onTranscript).not.toHaveBeenCalled();
    const closing = bridge.close();
    socket.emit('message', JSON.stringify({ type: 'session.closed', usage: { seconds: 1 } }));
    await closing;
  });

  it('drops normal PCM and subtitles through an unavailable gated decision', async () => {
    const { bridge, events } = setup();
    const connecting = bridge.connect();
    const socket = sockets[0];
    socket.readyState = 1;
    socket.emit('message', JSON.stringify({ type: 'session.started' }));
    await connecting;
    const oldVoice = Buffer.alloc(4800, 4).toString('base64');
    const quiet = Buffer.alloc(4800).toString('base64');

    bridge.beginUserSpeech();
    socket.emit('message', JSON.stringify({ type: 'session.output_transcript.delta', delta: '判定前の字幕' }));
    bridge.finishUserTurnGate(true);
    socket.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: oldVoice }));
    socket.emit('message', JSON.stringify({ type: 'session.output_transcript.delta', delta: '判定後に遅れた字幕' }));
    socket.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: quiet }));
    socket.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: quiet }));
    expect(events.onAudio).not.toHaveBeenCalled();
    expect(events.onTranscript).not.toHaveBeenCalled();
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
    bridge.finishUserTurnGate(true);
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

  it('releases approved normal PCM and its transcript together after the quiet boundary', async () => {
    const { bridge, events } = setup();
    const connecting = bridge.connect();
    const socket = sockets[0];
    socket.readyState = 1;
    socket.emit('message', JSON.stringify({ type: 'session.started' }));
    await connecting;
    const first = Buffer.alloc(4800, 4).toString('base64');
    const second = Buffer.alloc(4800, 5).toString('base64');
    socket.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: first }));
    socket.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: second }));
    socket.emit('message', JSON.stringify({ type: 'session.output_transcript.delta', delta: 'まとめて監査する字幕' }));
    expect(events.onAudio).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_020);
    expect(events.onAudio).toHaveBeenCalledWith(first, 'normal-1', 'normal');
    expect(events.onAudio).toHaveBeenLastCalledWith(second, 'normal-1', 'normal');
    expect(events.onSpeechAudioEnded).toHaveBeenCalledExactlyOnceWith('normal-1');
    const closing = bridge.close();
    socket.emit('message', JSON.stringify({ type: 'session.closed', usage: { seconds: 1 } }));
    await closing;
  });

  it('uses the final audible PCM timestamp instead of the provider silent tail for subtitle coverage', async () => {
    const { bridge, events } = setup();
    const connecting = bridge.connect();
    const socket = sockets[0];
    socket.readyState = 1;
    socket.emit('message', JSON.stringify({ type: 'session.started' }));
    await connecting;
    const voice = Buffer.alloc(4800, 4).toString('base64');
    const quiet = Buffer.alloc(4800).toString('base64');
    socket.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: voice, start_ms: 0, end_ms: 100 }));
    socket.emit('message', JSON.stringify({ type: 'session.output_transcript.delta', delta: '実際の台詞', start_ms: 0, end_ms: 100 }));
    for (let i = 1; i <= 9; i += 1) socket.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: quiet, start_ms: i * 100, end_ms: (i + 1) * 100 }));
    await vi.advanceTimersByTimeAsync(120);
    expect(events.onAudio).toHaveBeenCalledWith(voice, 'normal-1', 'normal');
    expect(events.onTranscript).toHaveBeenCalledWith('assistant', '実際の台詞', { startMs: 0, endMs: 100 });
    const closing = bridge.close();
    socket.emit('message', JSON.stringify({ type: 'session.closed', usage: { seconds: 1 } }));
    await closing;
  });

  it('releases a primary-WebSocket normal reply when only its transcript has timestamps', async () => {
    const { bridge, events } = setup();
    const connecting = bridge.connect();
    const socket = sockets[0];
    socket.readyState = 1;
    socket.emit('message', JSON.stringify({ type: 'session.started' }));
    await connecting;
    const voice = Buffer.alloc(4800, 4).toString('base64');
    // GPT-Live primary output audio has no start_ms/end_ms, while its
    // transcript delta remains session-timestamped.
    socket.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: voice }));
    socket.emit('message', JSON.stringify({ type: 'session.output_transcript.delta', delta: 'primary の返答', start_ms: 1_000, end_ms: 1_100 }));
    await vi.advanceTimersByTimeAsync(1_020);
    expect(events.onNormalSpeechCandidate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ speechId: 'normal-1', transcript: 'primary の返答' }));
    expect(events.onAudio).toHaveBeenCalledExactlyOnceWith(voice, 'normal-1', 'normal');
    const closing = bridge.close();
    socket.emit('message', JSON.stringify({ type: 'session.closed', usage: { seconds: 1 } }));
    await closing;
  });

  it('keeps a multi-chunk primary-WebSocket reply together through its inactivity boundary', async () => {
    const { bridge, events } = setup();
    const connecting = bridge.connect();
    const socket = sockets[0];
    socket.readyState = 1;
    socket.emit('message', JSON.stringify({ type: 'session.started' }));
    await connecting;
    const first = Buffer.alloc(4800, 4).toString('base64');
    const second = Buffer.alloc(4800, 5).toString('base64');
    socket.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: first }));
    socket.emit('message', JSON.stringify({ type: 'session.output_transcript.delta', delta: '少し長い', start_ms: 1_000, end_ms: 1_100 }));
    await vi.advanceTimersByTimeAsync(600);
    socket.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: second }));
    socket.emit('message', JSON.stringify({ type: 'session.output_transcript.delta', delta: '返答です', start_ms: 1_100, end_ms: 1_300 }));
    await vi.advanceTimersByTimeAsync(1_020);
    expect(events.onNormalSpeechCandidate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ speechId: 'normal-1', transcript: '少し長い返答です' }));
    expect(events.onAudio).toHaveBeenCalledWith(first, 'normal-1', 'normal');
    expect(events.onAudio).toHaveBeenLastCalledWith(second, 'normal-1', 'normal');
    const closing = bridge.close();
    socket.emit('message', JSON.stringify({ type: 'session.closed', usage: { seconds: 1 } }));
    await closing;
  });

  it('holds a primary timestamped subtitle that arrives before its untimestamped audio', async () => {
    const { bridge, events } = setup();
    const connecting = bridge.connect();
    const socket = sockets[0];
    socket.readyState = 1;
    socket.emit('message', JSON.stringify({ type: 'session.started' }));
    await connecting;
    const voice = Buffer.alloc(4800, 4).toString('base64');
    socket.emit('message', JSON.stringify({ type: 'session.output_transcript.delta', delta: '字幕先行 primary', start_ms: 1_000, end_ms: 1_100 }));
    socket.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: voice }));
    await vi.advanceTimersByTimeAsync(1_020);
    expect(events.onNormalSpeechCandidate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ speechId: 'normal-1', transcript: '字幕先行 primary' }));
    expect(events.onAudio).toHaveBeenCalledExactlyOnceWith(voice, 'normal-1', 'normal');
    const closing = bridge.close();
    socket.emit('message', JSON.stringify({ type: 'session.closed', usage: { seconds: 1 } }));
    await closing;
  });

  it('keeps a primary normal reply silent during a user gate and audits it after a non-agreement release', async () => {
    const { bridge, events } = setup();
    const connecting = bridge.connect();
    const socket = sockets[0];
    socket.readyState = 1;
    socket.emit('message', JSON.stringify({ type: 'session.started' }));
    await connecting;
    const voice = Buffer.alloc(4800, 4).toString('base64');
    bridge.beginUserSpeech();
    socket.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: voice }));
    socket.emit('message', JSON.stringify({ type: 'session.output_transcript.delta', delta: 'gate 後の普通の返答', start_ms: 1_000, end_ms: 1_200 }));
    await vi.advanceTimersByTimeAsync(1_020);
    expect(events.onNormalSpeechCandidate).not.toHaveBeenCalled();
    expect(events.onAudio).not.toHaveBeenCalled();
    bridge.finishUserTurnGate(false);
    await Promise.resolve();
    expect(events.onNormalSpeechCandidate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ speechId: 'normal-1', transcript: 'gate 後の普通の返答' }));
    expect(events.onAudio).toHaveBeenCalledExactlyOnceWith(voice, 'normal-1', 'normal');
    const closing = bridge.close();
    socket.emit('message', JSON.stringify({ type: 'session.closed', usage: { seconds: 1 } }));
    await closing;
  });

  it('emits metadata-only diagnostics for a gated normal candidate denied by audit', async () => {
    const diagnostic = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      const { bridge, events } = setup();
      events.onNormalSpeechCandidate.mockResolvedValueOnce(false);
      const connecting = bridge.connect();
      const socket = sockets[0];
      socket.readyState = 1;
      socket.emit('message', JSON.stringify({ type: 'session.started' }));
      await connecting;
      const voice = Buffer.alloc(4800, 4).toString('base64');
      bridge.beginUserSpeech();
      socket.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: voice }));
      socket.emit('message', JSON.stringify({ type: 'session.output_transcript.delta', delta: 'must never reach diagnostics', start_ms: 1_000, end_ms: 1_200 }));
      await vi.advanceTimersByTimeAsync(1_020);
      bridge.finishUserTurnGate(false);
      await Promise.resolve();
      const entries = diagnostic.mock.calls.map(([entry]) => JSON.parse(String(entry)) as Record<string, unknown>);
      expect(entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ event: 'voice_diagnostic', kind: 'user_gate_started' }),
        expect.objectContaining({ event: 'voice_diagnostic', kind: 'normal_collection_complete', chunks: 1, transcripts: 1, gated: true }),
        expect.objectContaining({ event: 'voice_diagnostic', kind: 'user_gate_released', dropNormal: false }),
        expect.objectContaining({ event: 'voice_diagnostic', kind: 'normal_candidate_started', chunks: 1, transcripts: 1 }),
        expect.objectContaining({ event: 'voice_diagnostic', kind: 'normal_candidate_rejected', reason: 'audit_denied' }),
      ]));
      expect(JSON.stringify(entries)).not.toContain('must never reach diagnostics');
      expect(events.onAudio).not.toHaveBeenCalled();
      const closing = bridge.close();
      socket.emit('message', JSON.stringify({ type: 'session.closed', usage: { seconds: 1 } }));
      await closing;
    } finally {
      diagnostic.mockRestore();
    }
  });

  it('holds a timestamped subtitle that arrives before its normal PCM until the matching audible range arrives', async () => {
    const { bridge, events } = setup();
    const connecting = bridge.connect();
    const socket = sockets[0];
    socket.readyState = 1;
    socket.emit('message', JSON.stringify({ type: 'session.started' }));
    await connecting;
    const voice = Buffer.alloc(4800, 4).toString('base64');
    const quiet = Buffer.alloc(4800).toString('base64');
    socket.emit('message', JSON.stringify({ type: 'session.output_transcript.delta', delta: '字幕が先', start_ms: 0, end_ms: 100 }));
    socket.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: voice, start_ms: 0, end_ms: 100 }));
    for (let i = 1; i <= 9; i += 1) socket.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: quiet, start_ms: i * 100, end_ms: (i + 1) * 100 }));
    await vi.advanceTimersByTimeAsync(120);
    expect(events.onNormalSpeechCandidate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ speechId: 'normal-1', transcript: '字幕が先' }));
    expect(events.onAudio).toHaveBeenCalledWith(voice, 'normal-1', 'normal');
    expect(events.onTranscript).toHaveBeenCalledWith('assistant', '字幕が先', { startMs: 0, endMs: 100 });
    const closing = bridge.close();
    socket.emit('message', JSON.stringify({ type: 'session.closed', usage: { seconds: 1 } }));
    await closing;
  });

  it('does not attach a late timed subtitle to the next normal speech', async () => {
    const { bridge, events } = setup();
    const connecting = bridge.connect();
    const socket = sockets[0];
    socket.readyState = 1;
    socket.emit('message', JSON.stringify({ type: 'session.started' }));
    await connecting;
    const safe = Buffer.alloc(4800, 4).toString('base64');
    const dangerous = Buffer.alloc(4800, 5).toString('base64');
    const quiet = Buffer.alloc(4800).toString('base64');
    socket.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: safe, start_ms: 0, end_ms: 100 }));
    for (let i = 1; i <= 9; i += 1) socket.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: quiet, start_ms: i * 100, end_ms: (i + 1) * 100 }));
    socket.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: dangerous, start_ms: 2_000, end_ms: 2_100 }));
    socket.emit('message', JSON.stringify({ type: 'session.output_transcript.delta', delta: '前の安全な字幕', start_ms: 0, end_ms: 100 }));
    await vi.advanceTimersByTimeAsync(120);
    expect(events.onAudio).toHaveBeenCalledWith(safe, 'normal-1', 'normal');
    for (let i = 22; i <= 30; i += 1) socket.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: quiet, start_ms: i * 100, end_ms: (i + 1) * 100 }));
    bridge.noteSpeechPlaybackDone('normal-1');
    await vi.advanceTimersByTimeAsync(5_120);
    expect(events.onAudio).not.toHaveBeenCalledWith(dangerous, 'normal-2', 'normal');
    const closing = bridge.close();
    socket.emit('message', JSON.stringify({ type: 'session.closed', usage: { seconds: 1 } }));
    await closing;
  });

  it('waits for the full subtitle settle interval before review after a user gate opens', async () => {
    const { bridge, events } = setup();
    const connecting = bridge.connect();
    const socket = sockets[0];
    socket.readyState = 1;
    socket.emit('message', JSON.stringify({ type: 'session.started' }));
    await connecting;
    const voice = Buffer.alloc(4800, 4).toString('base64');
    const quiet = Buffer.alloc(4800).toString('base64');
    bridge.beginUserSpeech();
    socket.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: voice }));
    socket.emit('message', JSON.stringify({ type: 'session.output_transcript.delta', delta: 'settle を待つ' }));
    for (let i = 0; i < 9; i += 1) socket.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: quiet }));
    bridge.finishUserTurnGate(false);
    await vi.advanceTimersByTimeAsync(119);
    expect(events.onNormalSpeechCandidate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(events.onNormalSpeechCandidate).toHaveBeenCalledOnce();
    const closing = bridge.close();
    socket.emit('message', JSON.stringify({ type: 'session.closed', usage: { seconds: 1 } }));
    await closing;
  });

  it('streams the current normal transcript after its first PCM instead of holding it for a later utterance', async () => {
    const { bridge, events } = setup();
    const connecting = bridge.connect();
    const socket = sockets[0];
    socket.readyState = 1;
    socket.emit('message', JSON.stringify({ type: 'session.started' }));
    await connecting;
    const first = Buffer.alloc(4800, 4).toString('base64');
    const second = Buffer.alloc(4800, 5).toString('base64');
    socket.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: first }));
    socket.emit('message', JSON.stringify({ type: 'session.output_transcript.delta', delta: '同時に見せる字幕' }));
    socket.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: second }));
    await vi.advanceTimersByTimeAsync(1_020);
    expect(events.onAudio).toHaveBeenLastCalledWith(second, 'normal-1', 'normal');
    expect(events.onTranscript).toHaveBeenCalledExactlyOnceWith('assistant', '同時に見せる字幕', { startMs: null, endMs: null });
    const closing = bridge.close();
    socket.emit('message', JSON.stringify({ type: 'session.closed', usage: { seconds: 1 } }));
    await closing;
  });

  it('keeps a new normal epoch through a non-authoritative user gate, then reviews it before release', async () => {
    const { bridge, events } = setup();
    const connecting = bridge.connect();
    const socket = sockets[0];
    socket.readyState = 1;
    socket.emit('message', JSON.stringify({ type: 'session.started' }));
    await connecting;
    const voice = Buffer.alloc(4800, 4).toString('base64');
    bridge.beginUserSpeech();
    socket.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: voice }));
    socket.emit('message', JSON.stringify({ type: 'session.output_transcript.delta', delta: '普通の返答' }));
    await vi.advanceTimersByTimeAsync(1_020);
    expect(events.onNormalSpeechCandidate).not.toHaveBeenCalled();
    expect(events.onAudio).not.toHaveBeenCalled();
    bridge.finishUserTurnGate(false);
    await vi.advanceTimersByTimeAsync(120);
    expect(events.onNormalSpeechCandidate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ speechId: 'normal-1', transcript: '普通の返答', signal: expect.any(AbortSignal) }));
    expect(events.onAudio).toHaveBeenCalledExactlyOnceWith(voice, 'normal-1', 'normal');
    const closing = bridge.close();
    socket.emit('message', JSON.stringify({ type: 'session.closed', usage: { seconds: 1 } }));
    await closing;
  });

  it('fails closed for rejected, failed, or subtitle-less normal candidates', async () => {
    const { bridge, events } = setup();
    const connecting = bridge.connect();
    const socket = sockets[0];
    socket.readyState = 1;
    socket.emit('message', JSON.stringify({ type: 'session.started' }));
    await connecting;
    const voice = Buffer.alloc(4800, 4).toString('base64');
    events.onNormalSpeechCandidate
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error('review unavailable'))
      .mockImplementationOnce(() => { throw new Error('review threw'); });
    for (const transcript of ['rejected', 'failed', 'threw']) {
      socket.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: voice }));
      socket.emit('message', JSON.stringify({ type: 'session.output_transcript.delta', delta: transcript }));
      await vi.advanceTimersByTimeAsync(1_020);
    }
    socket.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: voice }));
    await vi.advanceTimersByTimeAsync(1_020);
    expect(events.onNormalSpeechCandidate).toHaveBeenCalledTimes(3);
    expect(events.onAudio).not.toHaveBeenCalled();
    expect(events.onTranscript).not.toHaveBeenCalled();
    const closing = bridge.close();
    socket.emit('message', JSON.stringify({ type: 'session.closed', usage: { seconds: 1 } }));
    await closing;
  });

  it('re-reviews a normal candidate when a later subtitle delta changes its text', async () => {
    const { bridge, events } = setup();
    const connecting = bridge.connect();
    const socket = sockets[0];
    socket.readyState = 1;
    socket.emit('message', JSON.stringify({ type: 'session.started' }));
    await connecting;
    const voice = Buffer.alloc(4800, 4).toString('base64');
    let resolveFirst!: (allowed: boolean) => void;
    events.onNormalSpeechCandidate.mockImplementationOnce(() => new Promise<boolean>(resolve => { resolveFirst = resolve; }));
    events.onNormalSpeechCandidate.mockResolvedValueOnce(true);
    socket.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: voice }));
    socket.emit('message', JSON.stringify({ type: 'session.output_transcript.delta', delta: '最初の字幕' }));
    await vi.advanceTimersByTimeAsync(1_020);
    expect(events.onNormalSpeechCandidate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ speechId: 'normal-1', transcript: '最初の字幕', signal: expect.any(AbortSignal) }));
    socket.emit('message', JSON.stringify({ type: 'session.output_transcript.delta', delta: '遅延字幕' }));
    resolveFirst(true);
    await Promise.resolve();
    expect(events.onAudio).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(120);
    expect(events.onNormalSpeechCandidate).toHaveBeenLastCalledWith(expect.objectContaining({ speechId: 'normal-1', transcript: '最初の字幕遅延字幕', signal: expect.any(AbortSignal) }));
    expect(events.onAudio).toHaveBeenCalledExactlyOnceWith(voice, 'normal-1', 'normal');
    const closing = bridge.close();
    socket.emit('message', JSON.stringify({ type: 'session.closed', usage: { seconds: 1 } }));
    await closing;
  });

  it('aborts an in-flight normal candidate before a stale audit can commit', async () => {
    const diagnostic = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const { bridge, events } = setup();
    const connecting = bridge.connect();
    const socket = sockets[0];
    socket.readyState = 1;
    socket.emit('message', JSON.stringify({ type: 'session.started' }));
    await connecting;
    const voice = Buffer.alloc(4800, 4).toString('base64');
    let resolveAudit!: () => void;
    let candidateSignal!: AbortSignal;
    const commit = vi.fn();
    events.onNormalSpeechCandidate
      .mockImplementationOnce(async ({ signal }) => {
        candidateSignal = signal;
        await new Promise<void>(resolve => { resolveAudit = resolve; });
        if (signal.aborted) return false;
        commit();
        return true;
      })
      .mockResolvedValueOnce(false);
    socket.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: voice }));
    socket.emit('message', JSON.stringify({ type: 'session.output_transcript.delta', delta: '最初の字幕' }));
    await vi.advanceTimersByTimeAsync(1_020);
    socket.emit('message', JSON.stringify({ type: 'session.output_transcript.delta', delta: '変更された字幕' }));
    expect(candidateSignal.aborted).toBe(true);
    expect(diagnostic.mock.calls.map(([entry]) => JSON.parse(String(entry)))).toContainEqual(expect.objectContaining({
      event: 'voice_diagnostic', kind: 'normal_candidate_aborted', reason: 'transcript_changed',
    }));
    resolveAudit();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(120);
    expect(commit).not.toHaveBeenCalled();
    expect(events.onAudio).not.toHaveBeenCalled();
    const closing = bridge.close();
    socket.emit('message', JSON.stringify({ type: 'session.closed', usage: { seconds: 1 } }));
    await closing;
    diagnostic.mockRestore();
  });

  it('drops a candidate when its timed subtitle does not cover the end of its PCM', async () => {
    const { bridge, events } = setup();
    const connecting = bridge.connect();
    const socket = sockets[0];
    socket.readyState = 1;
    socket.emit('message', JSON.stringify({ type: 'session.started' }));
    await connecting;
    const voice = Buffer.alloc(4800, 4).toString('base64');
    socket.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: voice, start_ms: 100, end_ms: 200 }));
    socket.emit('message', JSON.stringify({ type: 'session.output_transcript.delta', delta: '途中まで', start_ms: 100, end_ms: 150 }));
    await vi.advanceTimersByTimeAsync(1_020);
    expect(events.onNormalSpeechCandidate).not.toHaveBeenCalled();
    expect(events.onAudio).not.toHaveBeenCalled();
    const closing = bridge.close();
    socket.emit('message', JSON.stringify({ type: 'session.closed', usage: { seconds: 1 } }));
    await closing;
  });

  it('never releases a resolved candidate from an older VAD epoch or a closed bridge', async () => {
    const first = setup();
    const firstConnecting = first.bridge.connect();
    const firstSocket = sockets[0];
    firstSocket.readyState = 1;
    firstSocket.emit('message', JSON.stringify({ type: 'session.started' }));
    await firstConnecting;
    const voice = Buffer.alloc(4800, 4).toString('base64');
    let resolveOld!: (allowed: boolean) => void;
    first.events.onNormalSpeechCandidate.mockImplementationOnce(() => new Promise<boolean>(resolve => { resolveOld = resolve; }));
    firstSocket.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: voice }));
    firstSocket.emit('message', JSON.stringify({ type: 'session.output_transcript.delta', delta: '古い候補' }));
    await vi.advanceTimersByTimeAsync(1_020);
    first.bridge.beginUserSpeech();
    resolveOld(true);
    await Promise.resolve();
    expect(first.events.onAudio).not.toHaveBeenCalled();
    const firstClosing = first.bridge.close();
    firstSocket.emit('message', JSON.stringify({ type: 'session.closed', usage: { seconds: 1 } }));
    await firstClosing;

    const second = setup();
    const secondConnecting = second.bridge.connect();
    const secondSocket = sockets[1];
    secondSocket.readyState = 1;
    secondSocket.emit('message', JSON.stringify({ type: 'session.started' }));
    await secondConnecting;
    let resolveClosed!: (allowed: boolean) => void;
    second.events.onNormalSpeechCandidate.mockImplementationOnce(() => new Promise<boolean>(resolve => { resolveClosed = resolve; }));
    secondSocket.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: voice }));
    secondSocket.emit('message', JSON.stringify({ type: 'session.output_transcript.delta', delta: '閉じる候補' }));
    await vi.advanceTimersByTimeAsync(1_020);
    const secondClosing = second.bridge.close();
    resolveClosed(true);
    await Promise.resolve();
    expect(second.events.onAudio).not.toHaveBeenCalled();
    secondSocket.emit('message', JSON.stringify({ type: 'session.closed', usage: { seconds: 1 } }));
    await secondClosing;
  });

  it('holds normal PCM and its transcript until the prior playback quiet gap has elapsed', async () => {
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
    expect(events.onTranscript).not.toHaveBeenCalled();
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
