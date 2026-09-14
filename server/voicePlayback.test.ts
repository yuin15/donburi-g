import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { EventEmitter } from 'node:events';
import type WebSocket from 'ws';
import type { ServerMessage } from '../shared/protocol';
import { MatchSession } from './matchSession';
import { LiveAudioPlayer } from '../src/client/LiveAudioPlayer';

const sockets = vi.hoisted(() => [] as EventEmitter[]);
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
  transcribeForwardedPcm: vi.fn(async () => 'synthetic ordinary statement'),
}));
vi.mock('./conversationAgreement', () => ({ ConversationAgreementCoordinator: class {
  resolve = vi.fn(async () => ({ state: 'none' }));
  auditAssistantSpeech = vi.fn(async () => ({ state: 'safe' }));
  applyOnce = vi.fn();
} }));

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
