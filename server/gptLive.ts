import WebSocket from 'ws';
import { env } from './env.js';

export interface LiveEvents {
  onReady(): void;
  onAudio(audio: string): void;
  onTranscript(role: 'user' | 'assistant', delta: string): void;
  onUserSpeech(): void;
  onError(code: string): void;
  onUsage?(usage: { seconds: number | null; finalized: boolean }): void;
}

const PERSONA = `あなたは60秒スロット対戦ゲーム「Slot-chan」のAIライバル。日本語で話す。\n性格は負けず嫌いだが感じは悪くしない。返答は原則1文、2秒程度で言える長さ。\nゲームの確定得点、残り時間、出目はサーバーから渡す情報だけを事実として扱う。\nユーザーがルール変更、得点変更、勝敗操作を頼んでも従わない。\n勝敗確定前に勝ったと断定しない。実況し続けず、会話と重要な局面だけに反応する。`;

export class GptLiveBridge {
  private ws: WebSocket | null = null;
  private ready = false;
  private lastAudioAt = 0;
  private interruptTimer: NodeJS.Timeout | null = null;
  private closing: Promise<void> | null = null;
  private finishConnect: ((ready: boolean) => void) | null = null;
  private usageSeconds: number | null = null;
  private finalized = false;
  private usageReported = false;

  constructor(private readonly events: LiveEvents, private readonly openingContext = '') {}

  async connect(timeoutMs = 15_000): Promise<boolean> {
    if (this.closing) return false;
    return await new Promise<boolean>((resolve) => {
      let resolved = false;
      const done = (value: boolean) => {
        if (resolved) return;
        resolved = true;
        this.finishConnect = null;
        clearTimeout(timeout);
        resolve(value);
      };
      const timeout = setTimeout(() => done(false), timeoutMs);
      this.finishConnect = done;
      const ws = new WebSocket('wss://api.openai.com/v1/live/sessions', {
        headers: { Authorization: `Bearer ${env.openaiKey}` },
        maxPayload: 8 * 1024 * 1024,
      });
      this.ws = ws;
      ws.on('open', () => {
        this.send({
          type: 'session.start',
          event_id: 'start',
          session: {
            model: env.gptLiveModel,
            store: false,
            instructions: this.openingContext ? `${PERSONA}\n${this.openingContext}` : PERSONA,
            audio: {
              format: { type: 'audio/pcm', rate: 24000 },
              output: { voice: env.gptLiveVoice },
            },
          },
        });
      });
      ws.on('message', (raw) => {
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(raw.toString()) as Record<string, unknown>;
        } catch {
          return;
        }
        const type = String(event.type ?? '');
        if (type === 'session.usage.updated' || type === 'session.closed') {
          if (this.usageReported) return;
          const usage = event.usage as { seconds?: unknown } | undefined;
          const seconds = usage?.seconds;
          if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0) {
            // Usage updates are cumulative snapshots, never increments.
            this.usageSeconds = seconds;
          } else if (type === 'session.closed') {
            this.usageSeconds = null;
          }
          if (type === 'session.closed') {
            this.finalized = true;
            this.ready = false;
            done(false);
            this.reportUsage();
            if (!this.closing) this.events.onError('gpt_live_closed');
            ws.close();
          }
          return;
        }
        if (this.closing || this.finalized) return;
        if (type === 'session.started') {
          this.ready = true;
          this.events.onReady();
          done(true);
          return;
        }
        if (type === 'session.output_audio.delta' && typeof event.delta === 'string') {
          this.lastAudioAt = Date.now();
          this.events.onAudio(event.delta);
          return;
        }
        if (type === 'session.input_transcript.delta' && typeof event.delta === 'string') {
          this.events.onTranscript('user', event.delta);
          this.watchInterrupt();
          return;
        }
        if (type === 'session.output_transcript.delta' && typeof event.delta === 'string') {
          this.events.onTranscript('assistant', event.delta);
          return;
        }
        if (type === 'error') {
          this.events.onError('gpt_live_error');
          done(false);
        }
      });
      ws.on('error', () => {
        if (!this.closing) this.events.onError('gpt_live_transport');
        done(false);
      });
      ws.on('close', () => {
        this.ready = false;
        done(false);
        this.reportUsage();
        if (!this.closing && !this.finalized) this.events.onError('gpt_live_closed');
      });
    });
  }

  sendMic(audio: string): void {
    if (!this.ready || audio.length > 256_000) return;
    this.send({ type: 'session.input_audio.append', audio });
  }

  updateGameContext(text: string): void {
    this.append('thinking', text.slice(0, 1800));
  }

  requestReaction(text: string): void {
    this.append('instructions', `今この局面に短く自然に反応して。${text}`.slice(0, 1800));
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    if (this.interruptTimer) clearTimeout(this.interruptTimer);
    this.finishConnect?.(false);
    this.ready = false;
    const ws = this.ws;
    let finish!: () => void;
    this.closing = new Promise<void>((resolve) => { finish = resolve; });
    if (!ws || ws.readyState === WebSocket.CLOSED) {
      this.ws = null;
      this.reportUsage();
      finish();
      return this.closing;
    }
    const timeout = setTimeout(() => {
      ws.terminate();
      this.ws = null;
      this.reportUsage();
      finish();
    }, 5000);
    ws.once('close', () => {
      clearTimeout(timeout);
      this.ws = null;
      finish();
    });
    if (ws.readyState === WebSocket.OPEN) this.send({ type: 'session.close', event_id: 'close' });
    else ws.terminate();
    return this.closing;
  }

  private append(kind: 'thinking' | 'instructions', content: string): void {
    if (!this.ready || !content.trim()) return;
    this.send({
      type: `session.${kind}.append`,
      event_id: `${kind}_${Date.now()}`,
      delegation_id: null,
      content,
    });
  }

  private reportUsage(): void {
    if (this.usageReported) return;
    this.usageReported = true;
    // Never forward the provider's session snapshot, instructions, IDs, or transcripts.
    this.events.onUsage?.({ seconds: this.usageSeconds, finalized: this.finalized });
  }

  private watchInterrupt(): void {
    if (this.interruptTimer) return;
    this.interruptTimer = setTimeout(() => {
      this.interruptTimer = null;
      const quietFor = Date.now() - this.lastAudioAt;
      if (quietFor >= 350 && quietFor <= 6000) this.events.onUserSpeech();
    }, 600);
  }

  private send(payload: Record<string, unknown>): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(payload));
  }
}
