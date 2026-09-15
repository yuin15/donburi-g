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
  settlement.transcribe.mockImplementation(async (pcm: Buffer) => pcm.includes(5) ? 'わかった、10秒延長するね。' : 'synthetic intro');
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
    expect(settlement.transcribe.mock.calls.map(([pcm]) => pcm)).toEqual([intro, acceptance]);
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

    // Keep the previous tail, then start the waiting reply without an extra pause.
    await vi.advanceTimersByTimeAsync(900);
    expect(messages.filter(m => m.type === 'voice_speech_end')).toHaveLength(1);
    emit('session.output_audio.delta', voice);
    await vi.advanceTimersByTimeAsync(900);
    expect(sources).toHaveLength(10);
    const tail = sources.slice(8);
    audioTime = 11.04;
    for (const source of tail) source.onended?.();
    await Promise.resolve();
    expect(sources).toHaveLength(11);
    expect(sources[10].start.mock.calls[0][0]).toBeCloseTo(11.08, 5);
    expect(sources.every(source => source.stop.mock.calls.length === 0)).toBe(true);
  } finally {
    await session.shutdown('synthetic_playback_finished');
    await player.close();
  }
});
