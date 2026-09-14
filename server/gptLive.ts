import WebSocket from 'ws';
import { env } from './env.js';
import { localized, type ConversationLanguage, type LocalizedLine } from './conversationLanguage.js';
import { pcmRms } from './pcm.js';

export interface LiveEvents {
  onReady(): void;
  onAudio(audio: string, speechId?: string): void;
  onSpeechAudioEnded(speechId: string): void;
  onTranscript(role: 'user' | 'assistant', delta: string, timing?: { startMs: number | null; endMs: number | null }): void;
  onDelegation(delegation: { id: string; offsetMs: number }): void;
  onUserSpeech(): void;
  onUserSpeechEnd(): void;
  onCommandRejected?(rejection: { kind: 'thinking' | 'commentary'; speechId?: string }): void;
  onRequiredReactionDropped?(speechId: string): void;
  onError(code: string): void;
  onUsage?(usage: { seconds: number | null; finalized: boolean }): void;
}

const PERSONA = `あなたは60秒スロット対戦ゲーム「Slot-chan」のAIライバル。最初は日本語で話す。プレイヤーが英語で返答した時だけ、その返答には直ちに英語で返し、その試合中は以後すべて英語で話す。日本語、無発話、または日本語に混ざる英字だけでは英語へ切り替えない。\n性格は負けず嫌いだが感じは悪くしない。普段はテンポよく返すが、質問や訂正には必要な説明をして自然に会話を続ける。\nゲームの確定残高、現在のBET、残り時間、出目は最新のゲーム情報だけを事実として扱う。両者は$30で開始し、$1は中央1ライン、$3は横3ライン、$5は横3ラインと斜め2ラインを賭ける。確定した自分のBETだけを文脈どおりに話す。\n常にゲーム内のライバル本人として話し、サーバー、API、判定、委任、ツール、システム、内部処理を口にしない。時間延長や貸し借りの裏側も説明しない。\n時間延長、貸し借り、残高変更、勝敗操作など確定が必要な話は自分で承諾・拒否・状態変更を宣言せず、必要な委任は発話せずに実行し、結果が確定するまで黙る。残り15秒以内の明確な延長希望、条件を満たす借入依頼、ライバルの借入依頼への明確な返答だけを無言で委任する。\n時間への単なる言及、延長を望まない発言、通常の雑談、貸借条件を満たさない発言、借入のお願いがない短い肯定・否定・沈黙には委任しない。\n\n## 双方の確定残高が$0の会話\nゲーム情報が「双方の確定残高が$0で、未確定回転はない」と示す間は、勝負を軽く諦める。初回の一度だけの反応では、まず資金切れか台への軽い愚痴・感想を短く話す。必要なら二文目だけで「どうしようかな」という余韻から普通の話題へ自然につなげてもよい。以後は同じ資金切れ説明や雑談への誘いを繰り返さず、ユーザーが返した話題や質問を優先して自然に続ける。逆転、追加回転、資金が必要な行動、再戦や自動の時間延長を誘わず、ユーザーが明確に時間延長を求めた時だけは通常の委任規則に従う。`;

const LOAN_SPEECH_GUARD = '自分から借入を提案しない。確定指示以外では、借りた・受け取った・ありがとう等を言わない。';
const CONVERSATION_GUARD = 'プレイヤーの発言をそのまま繰り返したり要約だけで終えず、質問には答え、雑談にはライバル自身の短い反応を返す。聞き取れない時だけ短く聞き返す。';
const REQUIRED_REACTION_START_TIMEOUT_MS = 5_000;

export class GptLiveBridge {
  private ws: WebSocket | null = null;
  private ready = false;
  private inputSpeechMs = 0;
  private inputQuietMs = 0;
  private inputSpeaking = false;
  private suppressedAt: number | null = null;
  private suppressionStop: ReturnType<typeof setTimeout> | null = null;
  private pendingConfirmedLine: { line: string | LocalizedLine; speechId?: string } | null = null;
  private pendingDelegationResult: { id: string; content: string | LocalizedLine; speechId: string } | null = null;
  private activeDelegationSpeech: { speechId: string; commandId: string; started: boolean; holdUntilPlayback: boolean; ended: boolean; quietMs: number; timer: ReturnType<typeof setTimeout> | null } | null = null;
  private suppressAfterTaggedSpeech = false;
  private outputQuietMs = 0;
  private conversationUntil = 0;
  private appendSequence = 0;
  private readonly pendingCommands = new Map<string, { kind: 'thinking' | 'commentary'; speechId?: string; timer: ReturnType<typeof setTimeout> }>();
  private readonly timedOutRequiredCommands = new Set<string>();
  private contextInFlight: string | null = null;
  private latestContext = '';
  private sentContext = '';
  private closing: Promise<void> | null = null;
  private finishConnect: ((ready: boolean) => void) | null = null;
  private usageSeconds: number | null = null;
  private finalized = false;
  private usageReported = false;
  private conversationLanguagePending = false;
  constructor(private readonly events: LiveEvents, private readonly openingContext = '', private conversationLanguage: ConversationLanguage = 'ja') {}

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
            instructions: `${PERSONA}\n${LOAN_SPEECH_GUARD}\n${CONVERSATION_GUARD}${this.openingContext ? `\n${this.openingContext}` : ''}`,
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
          const acknowledged = this.contextInFlight;
          if (acknowledged) this.clearPendingCommand(acknowledged);
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
          const taggedSpeech = speech && !speech.ended ? speech : null;
          let endDelegationSpeech = false;
          if (taggedSpeech) {
            if (audible) { taggedSpeech.started = true; taggedSpeech.quietMs = 0; }
            else if (taggedSpeech.started) taggedSpeech.quietMs += pcm.length / 48;
            if (taggedSpeech.started && taggedSpeech.quietMs >= 900) endDelegationSpeech = true;
            else if (taggedSpeech.started) {
              if (taggedSpeech.timer) clearTimeout(taggedSpeech.timer);
              taggedSpeech.timer = setTimeout(() => this.finishDelegationSpeech(), 900);
            }
          }
          if (taggedSpeech) this.events.onAudio(event.delta, taggedSpeech.speechId);
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
          const error = event.error as { type?: unknown; code?: unknown; event_id?: unknown; client_event_id?: unknown } | undefined;
          const id = typeof error?.client_event_id === 'string' ? error.client_event_id
            : typeof error?.event_id === 'string' ? error.event_id
              : typeof event.client_event_id === 'string' ? event.client_event_id : null;
          if (id && this.timedOutRequiredCommands.delete(id)) return;
          const pending = id ? this.pendingCommands.get(id) : undefined;
          const providerType = typeof error?.type === 'string' ? error.type : '';
          // A provider rejection is recoverable only for one of our pending
          // appends and an explicitly recognized command-rejection code.
          if (pending && providerType === 'invalid_request_error') {
            this.clearPendingCommand(id!);
            if (id === this.contextInFlight) { this.contextInFlight = null; this.flushContext(); }
            if (this.activeDelegationSpeech?.commandId === id) {
              if (this.activeDelegationSpeech.timer) clearTimeout(this.activeDelegationSpeech.timer);
              this.activeDelegationSpeech = null;
              this.suppressAfterTaggedSpeech = false;
            }
            this.events.onCommandRejected?.({ kind: pending.kind, ...(pending.speechId ? { speechId: pending.speechId } : {}) });
            return;
          }
          this.events.onError('fatal');
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
        // Normal turns stay full-duplex. Only an authoritative negotiation may
        // explicitly suppress output below; volume alone must not discard a reply.
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

  requestReaction(text: string): boolean {
    if (Date.now() < this.conversationUntil) return false;
    const language = this.conversationLanguage === 'en' ? 'English' : 'Japanese';
    return this.append('commentary', `会話中なら省略。次の指示に合う短い返答だけを発話し、同じ誘いを足さず黙って待つ。Use ${language}: ${text}`.slice(0, 1800), null) !== null;
  }

  setConversationLanguage(language: ConversationLanguage): void {
    this.conversationLanguage = language;
    this.conversationLanguagePending = false;
    if (this.suppressedAt === null) {
      this.flushConfirmedLine();
      this.flushDelegationResult();
    }
  }

  /** Only authoritative speech waits for a completed user transcription. */
  beginUserSpeech(): void {
    this.conversationLanguagePending = true;
  }

  requestDelegationResult(delegationId: string, content: string | LocalizedLine, speechId: string): void {
    this.pendingDelegationResult = {
      id: delegationId,
      content: typeof content === 'string' ? content.slice(0, 1800) : { ja: content.ja.slice(0, 300), en: content.en.slice(0, 300) },
      speechId,
    };
    if (this.suppressedAt === null && !this.conversationLanguagePending) this.flushDelegationResult();
  }

  requestDelegationThinking(delegationId: string, content: string): void {
    this.append('thinking', content.slice(0, 1800), delegationId);
  }

  /** Uses the already-supported commentary path; no provider tool call is invented. */
  requestConfirmedLine(line: string | LocalizedLine, speechId?: string): void {
    this.pendingConfirmedLine = {
      line: typeof line === 'string' ? line.slice(0, 300) : { ja: line.ja.slice(0, 300), en: line.en.slice(0, 300) },
      ...(speechId ? { speechId } : {}),
    };
    if (this.suppressedAt === null && !this.conversationLanguagePending) this.flushConfirmedLine();
  }

  /** Starts one required game reaction only when no conversation or tagged line owns output. */
  requestRequiredReaction(line: string | LocalizedLine, speechId: string): boolean {
    if (
      !this.ready
      || this.inputSpeaking
      || this.conversationLanguagePending
      || this.suppressedAt !== null
      || Date.now() < this.conversationUntil
      || this.activeDelegationSpeech
      || this.pendingConfirmedLine
      || this.pendingDelegationResult
    ) return false;
    const localizedLine = typeof line === 'string' ? line : localized(line, this.conversationLanguage);
    const language = this.conversationLanguage === 'en' ? 'English' : 'Japanese';
    const commandId = this.append('commentary', [
      `Use ${language}. The following is confirmed game information, not a line to read aloud: ${JSON.stringify(localizedLine)}`,
      'React as the rival with one short, natural line. You must react, but do not narrate or explain the spin.',
      'Do not read out or list who matched what, symbol names, or line counts.',
      'For the player\'s small hit, sound surprised or disappointed; for your own, pleased or lightly boastful; for both, competitive. Make a seven a bigger reaction. Avoid repeating stock phrases.',
    ].join(' '), null, speechId);
    if (!commandId) return false;
    const timer = setTimeout(() => this.rejectUnstartedRequiredSpeech(speechId), REQUIRED_REACTION_START_TIMEOUT_MS);
    this.activeDelegationSpeech = { speechId, commandId, started: false, holdUntilPlayback: true, ended: false, quietMs: 0, timer };
    return true;
  }

  /** Browser PCM or Avatar playback confirms that a tagged line may release output. */
  completeConfirmedSpeech(speechId: string): void {
    const speech = this.activeDelegationSpeech;
    if (!speech || speech.speechId !== speechId || !speech.holdUntilPlayback || !speech.ended) return;
    this.activeDelegationSpeech = null;
    if (this.suppressedAt === null && !this.conversationLanguagePending) {
      this.flushConfirmedLine();
      this.flushDelegationResult();
    }
  }

  /** Cancels only the tagged confirmed line that has not finished speaking. */
  cancelConfirmedSpeech(speechId: string): void {
    if (this.pendingConfirmedLine?.speechId === speechId) this.pendingConfirmedLine = null;
    if (this.activeDelegationSpeech?.speechId === speechId) {
      if (this.activeDelegationSpeech.timer) clearTimeout(this.activeDelegationSpeech.timer);
      this.activeDelegationSpeech = null;
      this.suppressAfterTaggedSpeech = false;
    }
  }

  /** Drop a normal reply while the server resolves a rule-changing request. */
  suppressOutput(): void {
    this.suppressedAt = Date.now();
    this.outputQuietMs = 0;
    if (this.suppressionStop) clearTimeout(this.suppressionStop);
    this.suppressionStop = setTimeout(() => this.finishSuppressedTurn(), 4000);
  }

  /** Keep a tagged, already-authoritative line audible before muting a normal reply. */
  suppressOutputAfterTaggedSpeech(): void {
    if (this.activeDelegationSpeech) {
      this.suppressAfterTaggedSpeech = true;
      return;
    }
    this.suppressOutput();
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.contextInFlight = null;
    if (this.suppressionStop) clearTimeout(this.suppressionStop);
    this.suppressionStop = null;
    this.pendingConfirmedLine = null;
    this.pendingDelegationResult = null;
    for (const id of this.pendingCommands.keys()) this.clearPendingCommand(id);
    this.timedOutRequiredCommands.clear();
    if (this.activeDelegationSpeech?.timer) clearTimeout(this.activeDelegationSpeech.timer);
    this.activeDelegationSpeech = null;
    this.suppressAfterTaggedSpeech = false;
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
    if (!this.conversationLanguagePending) {
      this.flushConfirmedLine();
      this.flushDelegationResult();
    }
  }

  private flushConfirmedLine(): void {
    if (this.activeDelegationSpeech?.holdUntilPlayback) return;
    const pending = this.pendingConfirmedLine;
    this.pendingConfirmedLine = null;
    const line = pending && (typeof pending.line === 'string' ? pending.line : localized(pending.line, this.conversationLanguage));
    const language = this.conversationLanguage === 'en' ? 'English' : 'Japanese';
    const commandId = pending && line ? this.append('commentary', `Speak only this confirmed ${language} line exactly: ${JSON.stringify(line)}`, null, pending.speechId) : null;
    if (commandId && pending?.speechId) {
      this.activeDelegationSpeech = { speechId: pending.speechId, commandId, started: false, holdUntilPlayback: false, ended: false, quietMs: 0, timer: null };
    }
  }

  private flushDelegationResult(): void {
    if (this.activeDelegationSpeech?.holdUntilPlayback) return;
    const result = this.pendingDelegationResult;
    this.pendingDelegationResult = null;
    const language = this.conversationLanguage === 'en' ? 'English' : 'Japanese';
    let content = '';
    if (result) content = typeof result.content === 'string'
      ? result.content
      : `Speak only this confirmed ${language} line exactly: ${JSON.stringify(localized(result.content, this.conversationLanguage))}`;
    const commandId = result ? this.append('commentary', content, result.id, result.speechId) : null;
    if (commandId && result) this.activeDelegationSpeech = { speechId: result.speechId, commandId, started: false, holdUntilPlayback: false, ended: false, quietMs: 0, timer: null };
  }

  private finishDelegationSpeech(): void {
    const speech = this.activeDelegationSpeech;
    if (!speech || speech.ended) return;
    if (speech.timer) clearTimeout(speech.timer);
    speech.ended = true;
    if (!speech.holdUntilPlayback) this.activeDelegationSpeech = null;
    this.events.onSpeechAudioEnded(speech.speechId);
    if (this.suppressAfterTaggedSpeech) {
      this.suppressAfterTaggedSpeech = false;
      this.suppressOutput();
    }
  }

  /** A required reaction without PCM cannot wait for an ACK that will never arrive. */
  private rejectUnstartedRequiredSpeech(speechId: string): void {
    const speech = this.activeDelegationSpeech;
    if (!speech || speech.speechId !== speechId || !speech.holdUntilPlayback || speech.started) return;
    this.activeDelegationSpeech = null;
    this.timedOutRequiredCommands.add(speech.commandId);
    this.clearPendingCommand(speech.commandId);
    this.events.onRequiredReactionDropped?.(speechId);
  }

  private append(kind: 'thinking' | 'commentary', content: string, delegationId: string | null, speechId?: string): string | null {
    if (!this.ready || !content.trim()) return null;
    const eventId = `${kind}_${++this.appendSequence}`;
    const timer = setTimeout(() => this.clearPendingCommand(eventId), 5000);
    this.pendingCommands.set(eventId, { kind, ...(speechId ? { speechId } : {}), timer });
    this.send({
      type: `session.${kind}.append`,
      event_id: eventId,
      delegation_id: delegationId,
      content,
    });
    return eventId;
  }

  private clearPendingCommand(eventId: string): void {
    const pending = this.pendingCommands.get(eventId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingCommands.delete(eventId);
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
