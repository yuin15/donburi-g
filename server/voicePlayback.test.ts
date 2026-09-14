import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { EventEmitter } from 'node:events';
import type WebSocket from 'ws';
import type { ServerMessage } from '../shared/protocol';
import { MatchSession } from './matchSession';
import { LiveAudioPlayer } from '../src/client/LiveAudioPlayer';
import type { AgreementTurn } from './conversationAgreement';

const sockets = vi.hoisted(() => [] as EventEmitter[]);
const settlement = vi.hoisted(() => ({ transcribe: vi.fn(), resolve: vi.fn(), audit: vi.fn() }));
vi.mock('./env', () => ({ env: { openaiKey: 'synthetic', gptLiveModel: 'synthetic', gptLiveVoice: 'synthetic' } }));
vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events');
  return { default: class extends EventEmitter {
    static OPEN = 1;
    static CLOSED = 3;
    readyState = 1;
    constructor() { super(); sockets.push(this); }
    send(raw: string) {
      if (JSON.parse(raw).type === 'session.close') queueMicrotask(() => this.emit('message', JSON.stringify({ type: 'session.closed' })));
    }
    close() { this.readyState = 3; this.emit('close'); }
    terminate() { this.close(); }
  } };
});
vi.mock('./speechSettlement', async importOriginal => ({
  ...(await importOriginal<typeof import('./speechSettlement')>()),
  transcribeForwardedPcm: settlement.transcribe,
}));
vi.mock('./conversationAgreement', async importOriginal => {
  const original = await importOriginal<typeof import('./conversationAgreement')>();
  return { ...original, ConversationAgreementCoordinator: class extends original.ConversationAgreementCoordinator {
    resolve = settlement.resolve;
    auditAssistantSpeech = settlement.audit;
  } };
});

type Source = {
  buffer: { duration: number } | null;
  onended: (() => void) | null;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
};
let audioTime = 10;
const sources: Source[] = [];
beforeEach(() => {
  sockets.length = 0; sources.length = 0; audioTime = 10;
  vi.resetAllMocks();
  settlement.transcribe.mockResolvedValue('synthetic ordinary statement');
  settlement.resolve.mockImplementation(async (turn: AgreementTurn) => ({ state: 'none', id: turn.id }));
  settlement.audit.mockResolvedValue({ state: 'safe' });
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('External network disabled in playback tests'); }));
  vi.stubGlobal('AudioContext', class {
    get currentTime() { return audioTime; }
    state = 'running';
    resume = vi.fn(async () => undefined);
    close = vi.fn(async () => undefined);
    createGain() { return { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }; }
    createBuffer(_channels: number, length: number, rate: number) {
      return { duration: length / rate, getChannelData: () => new Float32Array(length) };
    }
    createBufferSource() {
      const source: Source = { buffer: null, onended: null, connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn() };
      sources.push(source); return source;
    }
  });
});

it('settles a ten-second request inside continuous speech without interrupting playback', async () => {
  const player = new LiveAudioPlayer(); await player.prepare();
  const messages: ServerMessage[] = [];
  const frontend = { readyState: 1, close: vi.fn(), send(raw: string) {
    const message = JSON.parse(raw) as ServerMessage;
    messages.push(message);
    if (message.type === 'voice_audio') player.play(message.audio, message.speechId);
    if (message.type === 'voice_interrupt') player.interrupt();
  } } as unknown as WebSocket;
  const session = new MatchSession(frontend, 'continuous-extension', async () => undefined, { voiceMode: 'audio', spinMode: 'manual' });
  const intro = Buffer.alloc(4800, 4);
  const acceptance = Buffer.alloc(4800, 5);
  settlement.transcribe.mockImplementation(async (pcm: Buffer) => pcm.length > 9600 ? '10秒延長して' : pcm.includes(5) ? 'わかった、10秒延長するね。' : 'synthetic intro');
  settlement.resolve.mockImplementation(async (turn: AgreementTurn) => ({
    state: 'accepted', id: turn.id, agreements: [{ action: 'time_extension', offerId: null }],
  }));
  settlement.audit.mockImplementation(async (_snapshot, transcript: string) => transcript === 'synthetic intro'
    ? { state: 'safe' } : { state: 'commit', agreements: [{ action: 'time_extension', offerId: null }] });
  try {
    const initializing = session.initialize();
    const upstream = sockets[0];
    const emit = (type: string, data = {}) => upstream.emit('message', JSON.stringify({ type, ...data }));
    upstream.emit('open'); emit('session.started'); await initializing;
    session.handleRaw('{"type":"start"}');
    // The introduction starts before any player request, so its cause is null.
    emit('session.output_audio.delta', { delta: intro.toString('base64') });
    for (let i = 0; i < 2; i++) session.handleRaw(JSON.stringify({ type: 'mic', audio: intro.toString('base64') }));
    emit('session.input_transcript.delta', { delta: '10秒延長して', start_ms: 0, end_ms: 200 });
    for (let i = 0; i < 5; i++) session.handleRaw(JSON.stringify({ type: 'mic', audio: Buffer.alloc(4800).toString('base64') }));
    await vi.advanceTimersByTimeAsync(350);
    expect(messages.filter(message => message.type === 'time_extension')).toHaveLength(0);
    // The acceptance arrives before the 900 ms collection boundary.
    emit('session.output_audio.delta', { delta: acceptance.toString('base64') });
    await vi.advanceTimersByTimeAsync(1000);
    expect(messages.filter(message => message.type === 'time_extension')).toHaveLength(1);
    expect(messages.filter(message => message.type === 'voice_audio').map(message => message.speechId)).toEqual(['normal-1', 'normal-1']);
    expect(settlement.transcribe.mock.calls.map(([pcm]) => pcm)).toEqual([Buffer.concat([intro, acceptance]), Buffer.concat([intro, intro, Buffer.alloc(24000)])]);
    expect(settlement.audit.mock.calls.at(-1)![2]).toContain('P:10秒延長して');
    expect(messages.some(message => message.type === 'error' && message.code === 'settlement_unavailable')).toBe(false);
    expect(messages.filter(message => message.type === 'voice_interrupt')).toHaveLength(0);
    expect(sources).toHaveLength(2);
    expect(sources.every(source => source.stop.mock.calls.length === 0)).toBe(true);
  } finally {
    await session.shutdown('synthetic_extension_finished');
    await player.close();
  }
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it.each([
  ['rival_to_player', true, false], ['player_to_rival', true, false],
  ['rival_to_player', false, false], ['player_to_rival', false, false],
  ['rival_to_player', true, true], ['player_to_rival', true, true],
] as const)('settles %s across VAD turns (early reply: %s, previous loan: %s)', async (action, earlyReply, previousLoan) => {
  const messages: ServerMessage[] = [];
  const frontend = { readyState: 1, close: vi.fn(), send(raw: string) { messages.push(JSON.parse(raw)); } } as unknown as WebSocket;
  const session = new MatchSession(frontend, 'queued-conversation', async () => undefined, { voiceMode: 'audio', spinMode: 'manual' });
  const intro = Buffer.alloc(4800, 4), prefix = Buffer.alloc(4800, 5), acceptance = Buffer.alloc(4800, 6);
  const request = action === 'rival_to_player' ? 'ところで5ドル貸して' : '今度は5ドル貸してあげる';
  const previousAction = action === 'rival_to_player' ? 'player_to_rival' : 'rival_to_player';
  const inputTranscripts = ['さっきのスロット惜しかったね', request, 'お願いね'];
  if (previousLoan) inputTranscripts.unshift('synthetic previous request');
  settlement.transcribe.mockImplementation(async (pcm: Buffer) => pcm.length > 9600 ? inputTranscripts.shift()
    : pcm.includes(6) ? 'synthetic loan acceptance' : previousLoan && pcm.includes(4) ? 'synthetic previous acceptance' : 'synthetic chat');
  settlement.resolve.mockImplementation(async (turn: AgreementTurn) => turn.transcript === request
    ? { state: 'accepted', id: turn.id, agreements: [{ action, offerId: null }] }
    : turn.transcript === 'synthetic previous request' ? { state: 'accepted', id: turn.id, agreements: [{ action: previousAction, offerId: null }] }
    : { state: 'none', id: turn.id });
  settlement.audit.mockImplementation(async (_snapshot, transcript, _conversation, _offers, _signal, direction) => {
    if (transcript === 'synthetic previous acceptance') return { state: 'commit', agreements: [{ action: previousAction, offerId: null }] };
    if (transcript !== 'synthetic loan acceptance') return { state: 'safe' };
    expect(direction).toBe(action);
    return { state: 'commit', agreements: [{ action, offerId: null }] };
  });
  try {
    const initializing = session.initialize(); const upstream = sockets[0];
    const emit = (type: string, data = {}) => upstream.emit('message', JSON.stringify({ type, ...data }));
    upstream.emit('open'); emit('session.started'); await initializing;
    session.handleRaw('{"type":"start"}');
    let inputOffset = 0;
    const userTurn = (text: string) => {
      const start = inputOffset;
      for (let i = 0; i < 2; i++) session.handleRaw(JSON.stringify({ type: 'mic', audio: intro.toString('base64') }));
      emit('session.input_transcript.delta', { delta: text, start_ms: start, end_ms: start + 200 });
      for (let i = 0; i < 5; i++) session.handleRaw(JSON.stringify({ type: 'mic', audio: Buffer.alloc(4800).toString('base64') }));
      inputOffset += 700;
    };
    if (previousLoan) { userTurn('synthetic previous request'); await vi.advanceTimersByTimeAsync(350); }
    emit('session.output_audio.delta', { delta: intro.toString('base64') });
    await vi.advanceTimersByTimeAsync(900);
    session.handleRaw('{"type":"voice_speech_done","speechId":"normal-1"}');
    // A queued reply can start with the already settled request as its cause.
    if (previousLoan && earlyReply) emit('session.output_audio.delta', { delta: prefix.toString('base64') });
    userTurn('さっきのスロット惜しかったね');
    await vi.advanceTimersByTimeAsync(350);
    // This ordinary reply is generated while the five-second playback gap runs.
    if (earlyReply && !previousLoan) emit('session.output_audio.delta', { delta: prefix.toString('base64') });
    userTurn(request);
    await vi.advanceTimersByTimeAsync(350);
    userTurn('お願いね');
    if (!earlyReply) emit('session.output_audio.delta', { delta: prefix.toString('base64') });
    emit('session.output_audio.delta', { delta: acceptance.toString('base64') });
    await vi.advanceTimersByTimeAsync(5500);
    const transfers = messages.filter(message => message.type === 'loan_transfer');
    expect(transfers).toHaveLength(previousLoan ? 2 : 1);
    expect(transfers.at(-1)).toMatchObject({ direction: action, amount: 5 });
    expect(settlement.audit.mock.calls.at(-1)![2]).toContain(`P:${request}`);
    expect(settlement.audit.mock.calls.at(-1)![2]).toContain('P:お願いね');
    const outcomes = session as unknown as { finishedAgreementTurns: Map<number, { id: string }>; agreements: { applyOnce: (id: string, item: { action: typeof action; offerId: null }, apply: () => boolean) => boolean } };
    const requestId = outcomes.finishedAgreementTurns.get(previousLoan ? 3 : 2)!.id;
    expect(outcomes.agreements.applyOnce(requestId, { action, offerId: null }, () => true)).toBe(false);
    expect(messages.filter(message => message.type === 'voice_audio')).toHaveLength(3);
    expect(messages.filter(message => message.type === 'voice_interrupt')).toHaveLength(0);
    expect(messages.some(message => message.type === 'error' && message.code === 'settlement_unavailable')).toBe(false);
  } finally { await session.shutdown('synthetic_conversation_finished'); }
});

it.each([[0, 3], [160, 3], [161, 2], [161, 3]])('preserves the last PCM and the next reply with microphone RMS %i over %i chunks', async (amplitude, chunkCount) => {
  const player = new LiveAudioPlayer(); await player.prepare();
  const messages: ServerMessage[] = [];
  const frontend = { readyState: 1, close: vi.fn(), send(raw: string) {
    const message = JSON.parse(raw) as ServerMessage;
    messages.push(message);
    if (message.type === 'voice_audio') player.play(message.audio, message.speechId);
    if (message.type === 'voice_interrupt') player.interrupt();
    if (message.type === 'voice_speech_end') {
      void player.speechEnded(message.speechId).then(() => session.handleRaw(JSON.stringify({ type: 'voice_speech_done', speechId: message.speechId })));
    }
  } } as unknown as WebSocket;
  const session = new MatchSession(frontend, 'synthetic-playback', async () => undefined, { voiceMode: 'audio', spinMode: 'manual' });
  try {
    const initializing = session.initialize();
    const upstream = sockets[0];
    const emit = (type: string, delta?: string) => upstream.emit('message', JSON.stringify({ type, delta }));
    upstream.emit('open');
    emit('session.started');
    await initializing;
    const voice = Buffer.alloc(4800, 4).toString('base64');
    const caption = 'synthetic complete sentence ending';
    emit('session.output_transcript.delta', caption);
    for (let i = 0; i < 10; i++) emit('session.output_audio.delta', voice);
    expect(sources).toHaveLength(10);
    // The last 200 ms is still playing/queued when a microphone burst arrives.
    for (const source of sources.slice(0, 8)) source.onended?.();
    audioTime = 10.84;
    const noise = Buffer.alloc(2048);
    for (let i = 0; i < 1024; i++) noise.writeInt16LE(i % 2 ? amplitude : -amplitude, i * 2);
    for (let i = 0; i < chunkCount; i++) session.handleRaw(JSON.stringify({ type: 'mic', audio: noise.toString('base64') }));
    await Promise.resolve();
    expect(messages.some(m => m.type === 'transcript' && m.delta === caption)).toBe(true);
    expect(messages.filter(m => m.type === 'voice_interrupt')).toHaveLength(0);
    expect(sources.every(source => source.stop.mock.calls.length === 0)).toBe(true);

    // Generation completion does not release the next reply before actual playback.
    await vi.advanceTimersByTimeAsync(900);
    expect(messages.filter(m => m.type === 'voice_speech_end')).toHaveLength(1);
    emit('session.output_audio.delta', voice);
    await vi.advanceTimersByTimeAsync(900);
    expect(sources).toHaveLength(10);
    for (const source of sources.slice(8)) source.onended?.();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(4999);
    expect(sources).toHaveLength(10);
    await vi.advanceTimersByTimeAsync(1);
    expect(sources).toHaveLength(11);
  } finally {
    await session.shutdown('synthetic_playback_finished');
    await player.close();
  }
});
