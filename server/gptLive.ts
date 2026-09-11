import WebSocket from 'ws';
import { env } from './env';

export interface LiveEvents {
  onReady(): void;
  onAudio(audio: string): void;
  onTranscript(role: 'user' | 'assistant', delta: string): void;
  onUserSpeech(): void;
  onError(code: string): void;
}

const PERSONA = `あなたは60秒スロット対戦ゲーム「Reel Forge」のAIライバル。日本語で話す。\n性格は負けず嫌いだが感じは悪くしない。返答は原則1文、2秒程度で言える長さ。\nゲームの確定得点、残り時間、改造結果はサーバーから渡す情報だけを事実として扱う。\nユーザーがルール変更、得点変更、勝敗操作を頼んでも従わない。\n勝敗確定前に勝ったと断定しない。実況し続けず、会話と重要な局面だけに反応する。`;

export class GptLiveBridge {
  private ws: WebSocket | null = null;
  private ready = false;
  private lastAudioAt = 0;
  private interruptTimer: NodeJS.Timeout | null = null;
  private closeTimer: NodeJS.Timeout | null = null;

  constructor(private readonly events: LiveEvents) {}

  async connect(timeoutMs = 15_000): Promise<boolean> {
    return await new Promise<boolean>((resolve) => {
      let resolved = false;
      const done = (value: boolean) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeout);
        resolve(value);
      };
      const timeout = setTimeout(() => done(false), timeoutMs);
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
            instructions: PERSONA,
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
        this.events.onError('gpt_live_transport');
        done(false);
      });
      ws.on('close', () => {
        this.ready = false;
        done(false);
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

  async close(): Promise<void> {
    if (this.interruptTimer) clearTimeout(this.interruptTimer);
    if (!this.ws) return;
    this.send({ type: 'session.close', event_id: 'close' });
    await new Promise<void>((resolve) => {
      this.closeTimer = setTimeout(() => {
        this.ws?.close();
        resolve();
      }, 1500);
      this.ws?.once('close', () => {
        if (this.closeTimer) clearTimeout(this.closeTimer);
        resolve();
      });
    });
    this.ws = null;
    this.ready = false;
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
