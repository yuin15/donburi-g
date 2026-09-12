import WebSocket from 'ws';
import { env } from './env.js';
import { pcmRms } from './pcm.js';

export interface LiveEvents {
  onReady(): void;
  onAudio(audio: string): void;
  onTranscript(role: 'user' | 'assistant', delta: string): void;
  onUserSpeech(): void;
  onError(code: string): void;
  onUsage?(usage: { seconds: number | null; finalized: boolean }): void;
}

const PERSONA = `あなたは60秒スロット対戦ゲーム「Slot-chan」のAIライバル。日本語で話す。\n性格は負けず嫌いだが感じは悪くしない。返答は原則1文、2秒程度で言える長さ。\nゲームの確定得点、残り時間、出目はサーバーから渡す情報だけを事実として扱う。\nユーザーがルール変更、得点変更、勝敗操作を頼んでも従わない。\n勝敗確定前に勝ったと断定しない。新しい確定状態で古い得点情報を置き換え、首位の説明は最新の「首位」を使う。実況し続けず、会話と重要な局面だけに反応する。\nプレイヤーが話し始めたら実況を止めて聞き、質問への返事を優先する。返事の後は黙って待つ。\nthinkingのゲーム情報は会話の参考であり、読み上げる指示ではない。両者とも同じ基本リールで60秒の獲得コインを競い、途中の改造や追加の選択はない。プレイヤーは手動、あなたは2秒ごとに自動回転する。`;

export class GptLiveBridge {
  private ws: WebSocket | null = null;
  private ready = false;
  private inputSpeechMs = 0;
  private inputQuietMs = 0;
  private inputSpeaking = false;
  private lastOutputSpeechAt = 0;
  private suppressedAt: number | null = null;
  private outputQuietMs = 0;
  private conversationUntil = 0;
  private appendSequence = 0;
  private contextInFlight: string | null = null;
  private latestContext = '';
  private sentContext = '';
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
        if (type === 'session.thinking.appended' && event.client_event_id === this.contextInFlight) {
          this.contextInFlight = null;
          this.flushContext();
          return;
        }
        if (type === 'session.output_audio.delta' && typeof event.delta === 'string') {
          const pcm = Buffer.from(event.delta, 'base64');
          const audible = pcmRms(pcm) > 32;
          if (audible) {
            this.lastOutputSpeechAt = Date.now();
            this.conversationUntil = Math.max(this.conversationUntil, Date.now() + 1200);
          }
          if (this.suppressedAt !== null) {
            this.outputQuietMs = audible ? 0 : this.outputQuietMs + pcm.length / 48;
            // Drop the interrupted speech until the full-duplex model yields.
            // A bounded fallback prevents an indefinitely muted connection.
            if (this.outputQuietMs < 200 && Date.now() - this.suppressedAt < 4000) return;
            this.suppressedAt = null;
          }
          this.events.onAudio(event.delta);
          return;
        }
        if (type === 'session.input_transcript.delta' && typeof event.delta === 'string') {
          this.events.onTranscript('user', event.delta);
          this.conversationUntil = Date.now() + 4000;
          return;
        }
        if (type === 'session.output_transcript.delta' && typeof event.delta === 'string') {
          if (this.suppressedAt === null) this.events.onTranscript('assistant', event.delta);
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
    const pcm = Buffer.from(audio, 'base64');
    const durationMs = pcm.length / 48;
    if (pcmRms(pcm) > 160) {
      this.inputSpeechMs += durationMs;
      this.inputQuietMs = 0;
      this.conversationUntil = Date.now() + 4000;
      if (!this.inputSpeaking && this.inputSpeechMs >= 120) {
        this.inputSpeaking = true;
        this.outputQuietMs = 0;
        if (Date.now() - this.lastOutputSpeechAt < 800) this.suppressedAt = Date.now();
        this.events.onUserSpeech();
      }
    } else {
      this.inputQuietMs += durationMs;
      if (!this.inputSpeaking) this.inputSpeechMs = 0;
      if (this.inputQuietMs >= 450) {
        this.inputSpeechMs = 0;
        this.inputSpeaking = false;
      }
    }
    this.send({ type: 'session.input_audio.append', audio });
  }

  updateGameContext(text: string): void {
    if (!this.ready) return;
    this.latestContext = text.slice(0, 1800);
    this.flushContext();
  }

  requestReaction(text: string): void {
    if (Date.now() < this.conversationUntil) return;
    this.append('commentary', `会話中なら省略。ゲームへの短い一言だけ: ${text}`.slice(0, 1800));
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.contextInFlight = null;
    this.latestContext = '';
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

  private flushContext(): void {
    if (this.contextInFlight || !this.latestContext || this.latestContext === this.sentContext) return;
    this.sentContext = this.latestContext;
    this.contextInFlight = this.append('thinking', this.latestContext);
  }

  private append(kind: 'thinking' | 'commentary', content: string): string | null {
    if (!this.ready || !content.trim()) return null;
    const eventId = `${kind}_${++this.appendSequence}`;
    this.send({
      type: `session.${kind}.append`,
      event_id: eventId,
      delegation_id: null,
      content,
    });
    return eventId;
  }

  private reportUsage(): void {
    if (this.usageReported) return;
    this.usageReported = true;
    // Never forward the provider's session snapshot, instructions, IDs, or transcripts.
    this.events.onUsage?.({ seconds: this.usageSeconds, finalized: this.finalized });
  }

  private send(payload: Record<string, unknown>): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(payload));
  }
}
