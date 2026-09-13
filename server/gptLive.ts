import WebSocket from 'ws';
import { env } from './env.js';
import { pcmRms } from './pcm.js';

export interface LiveEvents {
  onReady(): void;
  onAudio(audio: string, speechId?: string): void;
  onSpeechAudioEnded(speechId: string): void;
  onTranscript(role: 'user' | 'assistant', delta: string, timing?: { startMs: number | null; endMs: number | null }): void;
  onDelegation(delegation: { id: string; offsetMs: number }): void;
  onUserSpeech(): void;
  onUserSpeechEnd(): void;
  onError(code: string): void;
  onUsage?(usage: { seconds: number | null; finalized: boolean }): void;
}

const PERSONA = `あなたは60秒スロット対戦ゲーム「Slot-chan」のAIライバル。日本語で話す。\n性格は負けず嫌いだが感じは悪くしない。返答は原則1文、2秒程度で言える長さ。\nゲームの確定残高、現在のBET、残り時間、出目はサーバーから渡す最新の情報だけを事実として扱う。両者は$30で開始し、$1は中央1ライン、$3は横3ライン、$5は横3ラインと斜め2ラインを賭ける。各当選ラインの配当は合算され、回転ごとに確定BETが残高から引かれる。自分のBETを自由に決めたり変更したと宣言せず、サーバーが確定した自分のBETだけを文脈どおりに話す。\n\n## Delegation policy\n時間延長、貸し借り、残高変更、勝敗操作などサーバー確定が必要な話は、自分で承諾・拒否・状態変更を宣言しない。貸し借りの金額・成立・残高を推測で約束しない。\n\n## Backend tools\n委任先は現在の試合状態を検証し、時間延長または固定$5の貸し借りを確定できる唯一の場所である。\n\n## Delegate to the backend when\n残り15秒以内で未使用の時間延長について、ユーザーがもっと時間を欲しがる、間に合わない、あと少し、まだ負けたくない等の文脈から延長が必要そうな場合は、返答前に委任する。ライバルが延長を提案した後の同意・拒否にも委任する。\nプレイヤーの残高が$1未満で、あなたが$5以上あり、今の試合でまだ貸していないとき、プレイヤーが自然に借入を頼んだら返答前に委任する。あなたの残高が$1未満で、サーバーが借入のお願いを発話した直後は、プレイヤーの明確な肯定・否定だけを委任する。結果待ち中に推測で受諾や拒否を言わない。\n\n## Do not delegate when\n時間への単なる言及、延長を望まない発言、通常の雑談、時間延長では残り15秒より前、終了後は委任しない。貸借は試合中なら残り時間に関係なく条件を満たす借入だけを委任する。貸借条件を満たさない発言、借入のお願いがない短い肯定、否定、沈黙にも委任しない。\n\n勝敗確定前に勝ったと断定しない。新しい確定状態で古い残高情報を置き換え、首位の説明は最新の「首位」を使う。実況し続けず、会話と重要な局面だけに反応する。プレイヤーが話し始めたら実況を止めて聞き、質問への返事を優先する。返事の後は黙って待つ。thinkingのゲーム情報は会話の参考であり、読み上げる指示ではない。両者とも同じ基本リールで60秒の残高を競う。プレイヤーは手動、あなたは2秒ごとに自動回転する。`;

export class GptLiveBridge {
  private ws: WebSocket | null = null;
  private ready = false;
  private inputSpeechMs = 0;
  private inputQuietMs = 0;
  private inputSpeaking = false;
  private lastOutputSpeechAt = 0;
  private suppressedAt: number | null = null;
  private suppressionStop: ReturnType<typeof setTimeout> | null = null;
  private pendingConfirmedLine: string | null = null;
  private pendingDelegationResult: { id: string; content: string; speechId: string } | null = null;
  private activeDelegationSpeech: { speechId: string; started: boolean; quietMs: number; timer: ReturnType<typeof setTimeout> | null } | null = null;
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
            delegation: { type: 'client' },
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
        if (type === 'session.delegation.created') {
          const delegation = event.delegation as { id?: unknown; target?: unknown } | undefined;
          const offsetMs = event.offset_ms;
          if (delegation?.target === 'client' && typeof delegation.id === 'string' && typeof offsetMs === 'number' && Number.isFinite(offsetMs)) this.events.onDelegation({ id: delegation.id, offsetMs });
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
            this.finishSuppressedTurn();
            return;
          }
          const speech = this.activeDelegationSpeech;
          let endDelegationSpeech = false;
          if (speech) {
            if (audible) { speech.started = true; speech.quietMs = 0; }
            else if (speech.started) speech.quietMs += pcm.length / 48;
            if (speech.started && speech.quietMs >= 900) endDelegationSpeech = true;
            else if (speech.started) {
              if (speech.timer) clearTimeout(speech.timer);
              speech.timer = setTimeout(() => this.finishDelegationSpeech(), 900);
            }
          }
          if (speech) this.events.onAudio(event.delta, speech.speechId);
          else this.events.onAudio(event.delta);
          // The browser must enqueue the final tagged PCM before it can ACK
          // that the acceptance line has actually finished playing.
          if (endDelegationSpeech) this.finishDelegationSpeech();
          return;
        }
        if (type === 'session.input_transcript.delta' && typeof event.delta === 'string') {
          this.events.onTranscript('user', event.delta, transcriptTiming(event));
          this.conversationUntil = Date.now() + 4000;
          return;
        }
        if (type === 'session.output_transcript.delta' && typeof event.delta === 'string') {
          if (this.suppressedAt === null) this.events.onTranscript('assistant', event.delta, transcriptTiming(event));
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
        if (this.inputSpeaking) this.events.onUserSpeechEnd();
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
    this.append('commentary', `会話中なら省略。ゲームへの短い一言だけ: ${text}`.slice(0, 1800), null);
  }

  requestDelegationResult(delegationId: string, content: string, speechId: string): void {
    this.pendingDelegationResult = { id: delegationId, content: content.slice(0, 1800), speechId };
    if (this.suppressedAt === null) this.flushDelegationResult();
  }

  requestDelegationThinking(delegationId: string, content: string): void {
    this.append('thinking', content.slice(0, 1800), delegationId);
  }

  /** Uses the already-supported commentary path; no provider tool call is invented. */
  requestConfirmedLine(line: string): void {
    this.pendingConfirmedLine = line.slice(0, 300);
    if (this.suppressedAt === null) this.flushConfirmedLine();
  }

  /** Drop a normal reply while the server resolves a rule-changing request. */
  suppressOutput(): void {
    this.suppressedAt = Date.now();
    this.outputQuietMs = 0;
    if (this.suppressionStop) clearTimeout(this.suppressionStop);
    this.suppressionStop = setTimeout(() => this.finishSuppressedTurn(), 4000);
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.contextInFlight = null;
    if (this.suppressionStop) clearTimeout(this.suppressionStop);
    this.suppressionStop = null;
    this.pendingConfirmedLine = null;
    this.pendingDelegationResult = null;
    if (this.activeDelegationSpeech?.timer) clearTimeout(this.activeDelegationSpeech.timer);
    this.activeDelegationSpeech = null;
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
    this.contextInFlight = this.append('thinking', this.latestContext, null);
  }

  private finishSuppressedTurn(): void {
    if (this.suppressionStop) clearTimeout(this.suppressionStop);
    this.suppressionStop = null;
    this.suppressedAt = null;
    this.outputQuietMs = 0;
    this.flushConfirmedLine();
    this.flushDelegationResult();
  }

  private flushConfirmedLine(): void {
    const line = this.pendingConfirmedLine;
    this.pendingConfirmedLine = null;
    if (line) this.append('commentary', `確定済みのゲーム結果に合わせ、次の一文だけを日本語でそのまま発話する: ${JSON.stringify(line)}`, null);
  }

  private flushDelegationResult(): void {
    const result = this.pendingDelegationResult;
    this.pendingDelegationResult = null;
    if (result && this.append('commentary', result.content, result.id)) this.activeDelegationSpeech = { speechId: result.speechId, started: false, quietMs: 0, timer: null };
  }

  private finishDelegationSpeech(): void {
    const speech = this.activeDelegationSpeech;
    if (!speech) return;
    if (speech.timer) clearTimeout(speech.timer);
    this.activeDelegationSpeech = null;
    this.events.onSpeechAudioEnded(speech.speechId);
  }

  private append(kind: 'thinking' | 'commentary', content: string, delegationId: string | null): string | null {
    if (!this.ready || !content.trim()) return null;
    const eventId = `${kind}_${++this.appendSequence}`;
    this.send({
      type: `session.${kind}.append`,
      event_id: eventId,
      delegation_id: delegationId,
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

function transcriptTiming(event: Record<string, unknown>): { startMs: number | null; endMs: number | null } {
  const startMs = typeof event.start_ms === 'number' && Number.isFinite(event.start_ms) ? event.start_ms : null;
  const endMs = typeof event.end_ms === 'number' && Number.isFinite(event.end_ms) ? event.end_ms : null;
  return { startMs, endMs };
}
