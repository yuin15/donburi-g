import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { AvatarAudioBuffer } from './pcm.js';

export class MediaServerLeg {
  private ws: WebSocket | null = null;
  private connected = false;
  private utteranceId: string | null = null;
  // LiveAvatar can split one GPT commentary into several agent.speak calls.
  // Only the last one, after GPT's output fence, can release the extension.
  private expectedSpeech: { speechId: string; utteranceId: string | null; fenceSeen: boolean; utteranceEnded: boolean } | null = null;
  private readonly audio = new AvatarAudioBuffer(audio => {
    this.utteranceId ??= randomUUID();
    if (this.expectedSpeech) {
      this.expectedSpeech.utteranceId = this.utteranceId;
      this.expectedSpeech.utteranceEnded = false;
    }
    this.send({ type: 'agent.speak', event_id: this.utteranceId, audio });
  }, () => {
    if (this.utteranceId) this.send({ type: 'agent.speak_end', event_id: this.utteranceId });
    this.utteranceId = null;
  });
  private closed = false;
  private readyResolve: ((value: boolean) => void) | null = null;
  private readyTimer: NodeJS.Timeout | null = null;
  private keepAlive: NodeJS.Timeout | null = null;
  private pendingInterrupt: {
    eventId: string;
    promise: Promise<boolean>;
    resolve: (confirmed: boolean) => void;
    timer: NodeJS.Timeout;
  } | null = null;

  constructor(private readonly url: string, private readonly onFailure: () => void = () => {}, private readonly onSpeechEnded: (speechId: string) => void = () => {}) {}

  async start(timeoutMs = 15_000): Promise<boolean> {
    if (this.closed) return false;
    return await new Promise<boolean>((resolve) => {
      this.readyResolve = resolve;
      this.readyTimer = setTimeout(() => this.finishReady(false), timeoutMs);
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.on('open', () => {
        if (this.closed) return;
        this.keepAlive = setInterval(() => {
          this.send({ type: 'session.keep_alive', event_id: randomUUID() });
        }, 120_000);
      });
      ws.on('message', (raw) => {
        if (this.closed) return;
        let event: { type?: string; state?: string; source_event_id?: string };
        try {
          event = JSON.parse(raw.toString()) as typeof event;
        } catch {
          return;
        }
        if (!event || typeof event !== 'object') return;
        if (event.type === 'session.state_updated' && event.state === 'connected') {
          this.connected = true;
          this.finishReady(true);
        } else if (event.type === 'agent.audio_buffer_cleared' && this.pendingInterrupt
          && event.source_event_id === this.pendingInterrupt.eventId) {
          this.finishInterrupt(true);
        } else if (event.type === 'agent.speak_ended' && this.expectedSpeech?.utteranceId === event.source_event_id) {
          const expected = this.expectedSpeech;
          if (!expected) return;
          expected.utteranceEnded = true;
          this.finishExpectedSpeech();
        } else if (event.type === 'error' || (event.type === 'session.state_updated' && event.state === 'disconnected')) {
          this.fail();
        }
      });
      ws.on('close', () => {
        this.connected = false;
        this.finishReady(false);
        if (this.keepAlive) clearInterval(this.keepAlive);
        this.fail();
      });
      ws.on('error', () => {
        this.fail();
      });
    });
  }

  speak(audio: string, speechId?: string): void {
    // Drop audio while the old utterance is being cleared; never replay it later.
    if (this.closed || !this.connected || this.pendingInterrupt) return;
    if (speechId && !this.expectedSpeech) this.expectedSpeech = { speechId, utteranceId: null, fenceSeen: false, utteranceEnded: false };
    this.audio.append(audio);
  }

  /** GPT's terminal PCM fence: an earlier Avatar utterance must not complete us. */
  completeSpeechInput(speechId: string): void {
    if (this.expectedSpeech?.speechId !== speechId) return;
    this.expectedSpeech.fenceSeen = true;
    this.finishExpectedSpeech();
  }

  interrupt(): void {
    if (this.pendingInterrupt || this.closed) return;
    void this.interruptAndWait().then(confirmed => {
      if (!confirmed && !this.closed) this.fail();
    });
  }

  interruptAndWait(timeoutMs = 2000): Promise<boolean> {
    this.audio.reset();
    this.utteranceId = null;
    this.expectedSpeech = null;
    if (this.pendingInterrupt) return this.pendingInterrupt.promise;
    if (this.closed || !this.connected || this.ws?.readyState !== WebSocket.OPEN) return Promise.resolve(false);
    const eventId = randomUUID();
    let resolve!: (confirmed: boolean) => void;
    const promise = new Promise<boolean>(done => { resolve = done; });
    const timer = setTimeout(() => this.finishInterrupt(false), timeoutMs);
    this.pendingInterrupt = { eventId, promise, resolve, timer };
    try {
      this.send({ type: 'agent.interrupt', event_id: eventId });
    } catch {
      this.fail();
    }
    return promise;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.connected = false;
    this.audio.reset();
    this.utteranceId = null;
    if (this.keepAlive) clearInterval(this.keepAlive);
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.finishReady(false);
    this.finishInterrupt(false);
    const ws = this.ws;
    this.ws = null;
    if (!ws || ws.readyState === WebSocket.CLOSED) return;
    if (ws.readyState !== WebSocket.OPEN) {
      ws.terminate();
      return;
    }
    const deadline = setTimeout(() => ws.terminate(), 1500);
    ws.once('close', () => clearTimeout(deadline));
    ws.close();
  }

  private fail(): void {
    if (this.closed) return;
    this.close();
    this.onFailure();
  }

  private finishReady(value: boolean): void {
    if (!this.readyResolve) return;
    const resolve = this.readyResolve;
    this.readyResolve = null;
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = null;
    resolve(value);
  }

  private finishInterrupt(confirmed: boolean): void {
    const pending = this.pendingInterrupt;
    if (!pending) return;
    this.pendingInterrupt = null;
    clearTimeout(pending.timer);
    pending.resolve(confirmed);
  }

  private finishExpectedSpeech(): void {
    const expected = this.expectedSpeech;
    if (!expected || !expected.fenceSeen || !expected.utteranceEnded) return;
    this.expectedSpeech = null;
    this.onSpeechEnded(expected.speechId);
  }

  private send(payload: Record<string, unknown>): void {
    if (!this.connected || this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(payload));
  }
}
