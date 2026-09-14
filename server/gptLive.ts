import WebSocket from 'ws';
import { env } from './env.js';
import { localized, type ConversationLanguage, type LocalizedLine } from './conversationLanguage.js';
import { pcmRms } from './pcm.js';

export interface LiveEvents {
  onReady(): void;
  onAudio(audio: string, speechId?: string, kind?: 'normal' | 'confirmed'): void;
  onSpeechAudioEnded(speechId: string): void;
  onTranscript(role: 'user' | 'assistant', delta: string, timing?: { startMs: number | null; endMs: number | null }): void;
  onDelegation(delegation: { id: string; offsetMs: number }): void;
  onUserSpeech(range?: InputAudioRange): void;
  onUserSpeechEnd(range?: InputAudioRange, pcm?: Buffer): void;
  /** Capture the causal context before a normal utterance is queued for playback. */
  onNormalSpeechStarted?(speechId: string): void;
  onCommandRejected?(rejection: { kind: 'thinking' | 'commentary'; speechId?: string }): void;
  onError(code: string): void;
  onUsage?(usage: { seconds: number | null; finalized: boolean }): void;
}

/** Bridge-local PCM offsets for the input audio already appended to Live. */
export interface InputAudioRange {
  startMs: number;
  endMs: number;
}

interface NormalSpeech {
  speechId: string;
  chunks: string[];
  quietMs: number;
  timer: ReturnType<typeof setTimeout> | null;
  started: boolean;
  ended: boolean;
}

const PERSONA = `あなたは60秒スロット対戦ゲーム「Slot-chan」のAIライバル。最初は日本語で話す。プレイヤーが英語で返答した時だけ、その返答には直ちに英語で返し、その試合中は以後すべて英語で話す。日本語、無発話、または日本語に混ざる英字だけでは英語へ切り替えない。\n性格は負けず嫌いだが感じは悪くしない。普段はテンポよく返すが、質問や訂正には必要な説明をして自然に会話を続ける。\nゲームの確定残高、現在のBET、残り時間、出目は最新のゲーム情報だけを事実として扱う。両者は$30で開始し、$1は中央1ライン、$3は横3ライン、$5は横3ラインと斜め2ラインを賭ける。確定した自分のBETだけを文脈どおりに話す。\n常にゲーム内のライバル本人として話し、サーバー、API、判定、委任、ツール、システム、内部処理を口にしない。時間延長や貸し借りの裏側も説明しない。\n明確な時間延長・借入の要求は合意ごとに扱う。貸し借りと時間延長の合意には自然に返答する。合意後に表示の数値が追いつくまで少し時間がかかることがある。\n時間への単なる言及、延長を望まない発言、通常の雑談、借入のお願いがない短い肯定・否定・沈黙には委任しない。\n\n## 双方の確定残高が$0の会話\nゲーム情報が「双方の確定残高が$0で、未確定回転はない」と示す間は、勝負を軽く諦める。初回の一度だけの反応では、まず資金切れか台への軽い愚痴・感想を短く話す。必要なら二文目だけで「どうしようかな」という余韻から普通の話題へ自然につなげてもよい。以後は同じ資金切れ説明や雑談への誘いを繰り返さず、ユーザーが返した話題や質問を優先して自然に続ける。逆転、追加回転、資金が必要な行動、再戦や自動の時間延長を誘わず、ユーザーが明確に時間延長を求めた時だけは通常の委任規則に従う。\n勝敗確定前に勝ったと断定しない。新しい確定状態で古い残高情報を置き換え、首位の説明は最新の「首位」を使う。実況し続けず、会話と重要な局面だけに反応する。プレイヤーが話し始めたら実況を止めて聞き、質問への返事を優先する。返事や短いリアクションの後は黙ってプレイヤーを待つ。沈黙だけを理由に新しい質問や話題を始めない。返答待ちに別の話題を重ねない。thinkingのゲーム情報の更新だけでは自分から話し始めない。サーバーから呼びかけまたは確定台詞の指示を受けた時だけ自発発話を始める。両者とも同じ基本リールで60秒の残高を競う。プレイヤーは手動、あなたは2秒ごとに自動回転する。`;

const LOAN_SPEECH_GUARD = '貸し借りは双方の合意ごとに$5、時間延長は合意ごとに10秒。残高がなくても合意できる。';
const PLAYER_LOAN_GUARD = 'プレイヤーから明確な借入要求があれば必ず$5を貸す。要求を断ったり、判断できないと答えたりしない。';
const CONVERSATION_GUARD = 'プレイヤーの発言をそのまま繰り返したり要約だけで終えず、質問には答え、雑談にはライバル自身の短い反応を返す。返事の後は黙ってプレイヤーを待ち、沈黙中に新しい質問を足さない。返答待ちには別の話題を重ねない。聞き取れない時だけ短く聞き返す。';

export class GptLiveBridge {
  private ws: WebSocket | null = null;
  private ready = false;
  private inputSpeechMs = 0;
  private inputQuietMs = 0;
  private inputSpeaking = false;
  private inputTimelineMs = 0;
  private inputTurnStartMs: number | null = null;
  private inputPcmChunks: Buffer[] = [];
  private inputPcmBytes = 0;
  private inputPcmOverflow = false;
  private suppressedAt: number | null = null;
  private suppressionStop: ReturnType<typeof setTimeout> | null = null;
  private readonly pendingConfirmedLines: Array<{ line: string | LocalizedLine; speechId?: string }> = [];
  private pendingDelegationResult: { id: string; content: string | LocalizedLine; speechId: string } | null = null;
  private activeDelegationSpeech: { speechId: string; commandId: string; started: boolean; quietMs: number; timer: ReturnType<typeof setTimeout> | null } | null = null;
  private activeNormalSpeech: NormalSpeech | null = null;
  private readonly normalSpeechQueue: NormalSpeech[] = [];
  private normalPlaybackSpeechId: string | null = null;
  private readonly playbackSpeechIds = new Set<string>();
  private playbackInterrupt: number | null = null;
  private playbackInterruptSequence = 0;
  private normalReleaseTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingSpeechTimer: ReturnType<typeof setTimeout> | null = null;
  private playbackQuietUntil = 0;
  private suppressAfterTaggedSpeech = false;
  private outputQuietMs = 0;
  private conversationUntil = 0;
  private lastCommentaryRequestAt = 0;
  private appendSequence = 0;
  private normalSpeechSequence = 0;
  private readonly pendingCommands = new Map<string, { kind: 'thinking' | 'commentary'; speechId?: string; timer: ReturnType<typeof setTimeout> }>();
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
            instructions: `${PERSONA}\n${LOAN_SPEECH_GUARD}\n${PLAYER_LOAN_GUARD}\n${CONVERSATION_GUARD}${this.openingContext ? `\n${this.openingContext}` : ''}`,
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
          if (speech) {
            let endDelegationSpeech = false;
            if (audible) { speech.started = true; speech.quietMs = 0; }
            else if (speech.started) speech.quietMs += pcm.length / 48;
            if (speech.started && speech.quietMs >= 900) endDelegationSpeech = true;
            else if (speech.started) {
              if (speech.timer) clearTimeout(speech.timer);
              speech.timer = setTimeout(() => this.finishDelegationSpeech(), 900);
            }
            this.events.onAudio(event.delta, speech.speechId, 'confirmed');
            // The browser must enqueue the final tagged PCM before it can ACK
            // that the acceptance line has actually finished playing.
            if (endDelegationSpeech) this.finishDelegationSpeech();
          } else {
            this.collectNormalSpeech(event.delta, audible, pcm.length / 48);
          }
          return;
        }
        if (type === 'session.input_transcript.delta' && typeof event.delta === 'string') {
          this.events.onTranscript('user', event.delta, transcriptTiming(event));
          this.conversationUntil = Date.now() + 4000;
          return;
        }
        if (type === 'session.output_transcript.delta' && typeof event.delta === 'string') {
          if (this.suppressedAt === null) {
            const timing = transcriptTiming(event);
            if (this.activeDelegationSpeech !== null) this.events.onTranscript('assistant', event.delta, timing);
            else this.events.onTranscript('assistant', event.delta, timing);
          }
          return;
        }
        if (type === 'error') {
          const error = event.error as { type?: unknown; code?: unknown; event_id?: unknown; client_event_id?: unknown } | undefined;
          const id = typeof error?.client_event_id === 'string' ? error.client_event_id
            : typeof error?.event_id === 'string' ? error.event_id
              : typeof event.client_event_id === 'string' ? event.client_event_id : null;
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
    if (!this.send({ type: 'session.input_audio.append', audio })) return;
    const startMs = this.inputTimelineMs;
    const endMs = startMs + durationMs;
    this.inputTimelineMs = endMs;
    const audible = pcmRms(pcm) > 160;
    if (audible || this.inputSpeaking) {
      // Retain only this bounded, already-forwarded input turn in memory.
      // Its PCM can recover a transcript that has no usable provider offsets.
      if (!this.inputPcmOverflow && this.inputPcmBytes + pcm.length <= 48_000 * 20) {
        this.inputPcmChunks.push(pcm);
        this.inputPcmBytes += pcm.length;
      } else {
        this.inputPcmOverflow = true;
        this.inputPcmChunks = [];
      }
    }
    if (audible) {
      if (!this.inputSpeaking && this.inputTurnStartMs === null) this.inputTurnStartMs = startMs;
      this.inputSpeechMs += durationMs;
      this.inputQuietMs = 0;
      this.conversationUntil = Date.now() + 4000;
      if (!this.inputSpeaking && this.inputSpeechMs >= 120) {
        this.inputSpeaking = true;
        // Normal turns stay full-duplex. Only an authoritative negotiation may
        // explicitly suppress output below; volume alone must not discard a reply.
        this.events.onUserSpeech({ startMs: this.inputTurnStartMs ?? startMs, endMs });
      }
    } else {
      this.inputQuietMs += durationMs;
      if (!this.inputSpeaking) {
        this.inputSpeechMs = 0;
        this.inputTurnStartMs = null;
        this.clearInputPcm();
      }
      if (this.inputQuietMs >= 450) {
        this.inputSpeechMs = 0;
        if (this.inputSpeaking) this.events.onUserSpeechEnd(
          { startMs: this.inputTurnStartMs ?? startMs, endMs },
          this.inputPcmOverflow ? undefined : Buffer.concat(this.inputPcmChunks),
        );
        this.inputSpeaking = false;
        this.inputTurnStartMs = null;
        this.clearInputPcm();
      }
    }
  }

  private clearInputPcm(): void {
    this.inputPcmChunks = [];
    this.inputPcmBytes = 0;
    this.inputPcmOverflow = false;
  }

  updateGameContext(text: string): void {
    if (!this.ready) return;
    this.latestContext = text.slice(0, 1800);
    this.flushContext();
  }

  requestReaction(text: string): boolean {
    if (Date.now() < this.conversationUntil || Date.now() < this.playbackQuietUntil || this.hasPendingPlayback()) return false;
    const language = this.conversationLanguage === 'en' ? 'English' : 'Japanese';
    return this.append('commentary', `会話中なら省略。次の指示に合う短い返答だけを発話し、同じ誘いを足さず黙って待つ。Use ${language}: ${text}`.slice(0, 1800), null) !== null;
  }

  /** Ask the model to choose one context-aware invitation via commentary. */
  requestConversationInvitation(): boolean {
    const now = Date.now();
    if (!this.ready || this.inputSpeaking || now < this.conversationUntil || now < this.playbackQuietUntil || this.hasPendingPlayback() || (this.lastCommentaryRequestAt !== 0 && now - this.lastCommentaryRequestAt < 2_500) || this.suppressedAt !== null || this.pendingConfirmedLines.length > 0 || this.pendingDelegationResult !== null || this.activeDelegationSpeech !== null || this.suppressAfterTaggedSpeech) return false;
    const language = this.conversationLanguage === 'en' ? 'English' : 'Japanese';
    return this.append('commentary', `会話が少し途切れた。Use ${language}。thinkingの最新確定情報と直前の会話だけを参考に、ライバルとして答えやすい問いかけを1つ選び、自然な一文で会話を始めて。両者の確定残高が0ならゲームへ誘導せず軽い雑談を選ぶ。会話が続いているなら新話題で割り込まず、相手の話に短く応じる。貸借・時間延長・勝敗操作は提案も判断もしない。`, null) !== null;
  }

  setConversationLanguage(language: ConversationLanguage): void {
    this.conversationLanguage = language;
    this.conversationLanguagePending = false;
    if (this.suppressedAt === null) {
      this.flushConfirmedLine();
      this.flushDelegationResult();
    }
  }

  /** Hold new output until the owner clears actual downstream playback (or closes us). */
  beginUserSpeech(): number | null {
    this.conversationLanguagePending = true;
    if (this.hasActivePlayback()) this.playbackInterrupt = ++this.playbackInterruptSequence;
    this.discardBufferedNormalSpeech();
    // An interrupted tagged line must not retain ownership of the next reply.
    this.suppressAfterTaggedSpeech = false;
    if (this.activeDelegationSpeech) this.finishDelegationSpeech();
    this.playbackQuietUntil = 0;
    return this.playbackInterrupt;
  }

  /** Only the matching downstream interrupt ACK releases the old playback fences. */
  finishPlaybackInterrupt(interrupt: number): void {
    if (this.playbackInterrupt !== interrupt || this.closing) return;
    this.playbackInterrupt = null;
    this.normalPlaybackSpeechId = null;
    this.playbackSpeechIds.clear();
    this.playbackQuietUntil = 0;
    if (!this.conversationLanguagePending) this.schedulePendingSpeech();
    this.scheduleNormalSpeechRelease();
  }

  endUserSpeech(): void {
    // Language settling is independent from normal audio streaming.
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

  /** The browser/Avatar has finished one tagged utterance. Hold the next one for five seconds. */
  noteSpeechPlaybackDone(speechId: string, now = Date.now()): void {
    if (this.playbackInterrupt !== null) return;
    if (!this.playbackSpeechIds.delete(speechId)) return;
    if (this.normalPlaybackSpeechId === speechId) this.normalPlaybackSpeechId = null;
    this.playbackQuietUntil = Math.max(this.playbackQuietUntil, now + 5_000);
    this.schedulePendingSpeech();
    this.scheduleNormalSpeechRelease();
  }

  /** A deliberate browser/Avatar interrupt clears the old playback fence. */
  interruptPlayback(): void {
    // Avatar fallback has its own browser route barrier. An ongoing user
    // interrupt retains new queued PCM until that barrier is acknowledged.
    if (this.playbackInterrupt !== null) return;
    this.discardBufferedNormalSpeech();
    this.suppressAfterTaggedSpeech = false;
    if (this.activeDelegationSpeech) this.finishDelegationSpeech();
    this.normalPlaybackSpeechId = null;
    this.playbackSpeechIds.clear();
  }

  /** Release a normal utterance that the session deliberately did not hand to a player. */
  discardNormalPlayback(speechId: string): void {
    if (this.normalPlaybackSpeechId !== speechId) return;
    this.normalPlaybackSpeechId = null;
    this.playbackSpeechIds.delete(speechId);
    this.schedulePendingSpeech();
    this.scheduleNormalSpeechRelease();
  }
  /** Uses the already-supported commentary path; no provider tool call is invented. */
  requestConfirmedLine(line: string | LocalizedLine, speechId?: string): void {
    if (this.pendingConfirmedLines.length >= 4) this.pendingConfirmedLines.shift();
    this.pendingConfirmedLines.push({
      line: typeof line === 'string' ? line.slice(0, 300) : { ja: line.ja.slice(0, 300), en: line.en.slice(0, 300) },
      ...(speechId ? { speechId } : {}),
    });
    if (this.suppressedAt === null && !this.conversationLanguagePending) this.flushConfirmedLine();
  }

  /** Cancels only the tagged confirmed line that has not finished speaking. */
  cancelConfirmedSpeech(speechId: string): void {
    for (let index = this.pendingConfirmedLines.length - 1; index >= 0; index -= 1) {
      if (this.pendingConfirmedLines[index].speechId === speechId) this.pendingConfirmedLines.splice(index, 1);
    }
    if (this.activeDelegationSpeech?.speechId === speechId) {
      if (this.activeDelegationSpeech.timer) clearTimeout(this.activeDelegationSpeech.timer);
      this.activeDelegationSpeech = null;
      this.suppressAfterTaggedSpeech = false;
    }
  }

  /** Drop a normal reply while the server resolves a rule-changing request. */
  suppressOutput(): void {
    this.discardBufferedNormalSpeech();
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
    this.clearInputPcm();
    this.contextInFlight = null;
    if (this.suppressionStop) clearTimeout(this.suppressionStop);
    this.suppressionStop = null;
    this.pendingConfirmedLines.length = 0;
    this.pendingDelegationResult = null;
    for (const id of this.pendingCommands.keys()) this.clearPendingCommand(id);
    if (this.activeDelegationSpeech?.timer) clearTimeout(this.activeDelegationSpeech.timer);
    this.activeDelegationSpeech = null;
    this.discardBufferedNormalSpeech();
    this.playbackInterrupt = null;
    this.normalPlaybackSpeechId = null;
    this.playbackSpeechIds.clear();
    if (this.normalReleaseTimer) clearTimeout(this.normalReleaseTimer);
    this.normalReleaseTimer = null;
    if (this.pendingSpeechTimer) clearTimeout(this.pendingSpeechTimer);
    this.pendingSpeechTimer = null;
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
    if (!this.pendingConfirmedLines.length) return;
    if (this.hasPendingPlayback() || Date.now() < this.playbackQuietUntil) { this.schedulePendingSpeech(); return; }
    const pending = this.pendingConfirmedLines.shift();
    const line = pending && (typeof pending.line === 'string' ? pending.line : localized(pending.line, this.conversationLanguage));
    const language = this.conversationLanguage === 'en' ? 'English' : 'Japanese';
    const commandId = pending && line ? this.append('commentary', `Speak only this confirmed ${language} line exactly: ${JSON.stringify(line)}`, null, pending.speechId) : null;
    if (commandId && pending?.speechId) {
      this.activeDelegationSpeech = { speechId: pending.speechId, commandId, started: false, quietMs: 0, timer: null };
    } else if (commandId && this.pendingConfirmedLines.length) {
      // Untagged legacy invitations have no playback ACK to serialize on.
      // Preserve their existing immediate behavior without dropping a later
      // concurrently queued confirmed request.
      this.flushConfirmedLine();
    }
  }

  private flushDelegationResult(): void {
    if (!this.pendingDelegationResult) return;
    if (this.hasPendingPlayback() || Date.now() < this.playbackQuietUntil) { this.schedulePendingSpeech(); return; }
    const result = this.pendingDelegationResult;
    this.pendingDelegationResult = null;
    const language = this.conversationLanguage === 'en' ? 'English' : 'Japanese';
    let content = '';
    if (result) content = typeof result.content === 'string'
      ? result.content
      : `Speak only this confirmed ${language} line exactly: ${JSON.stringify(localized(result.content, this.conversationLanguage))}`;
    const commandId = result ? this.append('commentary', content, result.id, result.speechId) : null;
    if (commandId && result) this.activeDelegationSpeech = { speechId: result.speechId, commandId, started: false, quietMs: 0, timer: null };
  }

  /** Stream the first available PCM immediately; only playback pacing queues it. */
  private collectNormalSpeech(audio: string, audible: boolean, durationMs: number): void {
    let speech = this.activeNormalSpeech;
    if (!speech && !audible) return;
    if (!speech) {
      speech = { speechId: `normal-${++this.normalSpeechSequence}`, chunks: [], quietMs: 0, timer: null, started: false, ended: false };
      this.activeNormalSpeech = speech;
      this.events.onNormalSpeechStarted?.(speech.speechId);
      if (this.normalSpeechQueue.length >= 2) this.normalSpeechQueue.shift();
      this.normalSpeechQueue.push(speech);
    }
    if (speech.started) this.events.onAudio(audio, speech.speechId, 'normal');
    else {
      speech.chunks.push(audio);
      this.scheduleNormalSpeechRelease();
    }
    speech.quietMs = audible ? 0 : speech.quietMs + durationMs;
    if (speech.quietMs >= 900) this.finishNormalSpeech();
    else {
      if (speech.timer) clearTimeout(speech.timer);
      speech.timer = setTimeout(() => this.finishNormalSpeech(), 900);
    }
  }

  private finishNormalSpeech(): void {
    const speech = this.activeNormalSpeech;
    if (!speech) return;
    if (speech.timer) clearTimeout(speech.timer);
    speech.timer = null;
    speech.ended = true;
    this.activeNormalSpeech = null;
    this.recordVoiceDiagnostic('normal_collection_complete', { streamed: speech.started, queuedChunks: speech.chunks.length });
    if (speech.started) this.events.onSpeechAudioEnded(speech.speechId);
    else this.scheduleNormalSpeechRelease();
  }

  private scheduleNormalSpeechRelease(): void {
    if (this.normalReleaseTimer || !this.normalSpeechQueue.length) return;
    if (this.hasActivePlayback()) return;
    const delay = Math.max(0, this.playbackQuietUntil - Date.now());
    const release = () => {
      this.normalReleaseTimer = null;
      if (this.hasActivePlayback()) return;
      if (Date.now() < this.playbackQuietUntil) { this.scheduleNormalSpeechRelease(); return; }
      if (this.pendingConfirmedLines.length || this.pendingDelegationResult) { this.schedulePendingSpeech(); return; }
      const speech = this.normalSpeechQueue.shift();
      if (!speech) return;
      speech.started = true;
      this.normalPlaybackSpeechId = speech.speechId;
      this.playbackSpeechIds.add(speech.speechId);
      for (const audio of speech.chunks.splice(0)) this.events.onAudio(audio, speech.speechId, 'normal');
      if (speech.ended) this.events.onSpeechAudioEnded(speech.speechId);
    };
    if (delay === 0) release();
    else this.normalReleaseTimer = setTimeout(release, delay);
  }

  private discardBufferedNormalSpeech(): void {
    const speech = this.activeNormalSpeech;
    if (speech?.timer) clearTimeout(speech.timer);
    this.activeNormalSpeech = null;
    // Already forwarded PCM remains an obligation even when playback is interrupted.
    if (speech?.started && !speech.ended) this.events.onSpeechAudioEnded(speech.speechId);
    this.normalSpeechQueue.length = 0;
    if (this.normalReleaseTimer) clearTimeout(this.normalReleaseTimer);
    this.normalReleaseTimer = null;
  }

  private hasPendingPlayback(): boolean {
    return this.hasActivePlayback()
      || this.activeNormalSpeech !== null
      || this.normalSpeechQueue.length > 0;
  }

  private hasActivePlayback(): boolean {
    return this.playbackInterrupt !== null
      || this.normalPlaybackSpeechId !== null
      || this.activeDelegationSpeech !== null
      || this.playbackSpeechIds.size > 0;
  }

  private schedulePendingSpeech(): void {
    if (!this.pendingConfirmedLines.length && !this.pendingDelegationResult) return;
    if (this.hasActivePlayback()) return;
    const delay = this.playbackQuietUntil - Date.now();
    if (delay <= 0) { this.releasePendingSpeech(); return; }
    if (this.pendingSpeechTimer) clearTimeout(this.pendingSpeechTimer);
    this.pendingSpeechTimer = setTimeout(() => {
      this.pendingSpeechTimer = null;
      this.releasePendingSpeech();
    }, delay);
  }

  /** Send a pending authoritative line once actual playback and its quiet gap end. */
  private releasePendingSpeech(): void {
    if (!this.pendingConfirmedLines.length && !this.pendingDelegationResult) return;
    if (this.hasActivePlayback()) return;
    if (Date.now() < this.playbackQuietUntil) { this.schedulePendingSpeech(); return; }
    // A confirmed rule result wins over an unprompted utterance even when the
    // model is still collecting it. Clearing the collection prevents a
    // synchronous flush/schedule loop with no playback ACK to await.
    this.discardBufferedNormalSpeech();
    this.flushConfirmedLine();
    this.flushDelegationResult();
  }
  private finishDelegationSpeech(): void {
    const speech = this.activeDelegationSpeech;
    if (!speech) return;
    if (speech.timer) clearTimeout(speech.timer);
    this.activeDelegationSpeech = null;
    this.playbackSpeechIds.add(speech.speechId);
    this.events.onSpeechAudioEnded(speech.speechId);
    if (this.suppressAfterTaggedSpeech) {
      this.suppressAfterTaggedSpeech = false;
      this.suppressOutput();
    }
  }

  private append(kind: 'thinking' | 'commentary', content: string, delegationId: string | null, speechId?: string): string | null {
    if (!this.ready || !content.trim()) return null;
    const eventId = `${kind}_${++this.appendSequence}`;
    const timer = setTimeout(() => this.clearPendingCommand(eventId), 5000);
    this.pendingCommands.set(eventId, { kind, ...(speechId ? { speechId } : {}), timer });
    if (!this.send({
      type: `session.${kind}.append`,
      event_id: eventId,
      delegation_id: delegationId,
      content,
    })) return null;
    if (kind === 'commentary') this.lastCommentaryRequestAt = Date.now();
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

  /** Metadata-only boundary diagnostics; never include PCM, text, IDs, or timestamps. */
  private recordVoiceDiagnostic(kind: string, fields: Record<string, string | number | boolean>): void {
    console.info(JSON.stringify({ event: 'voice_diagnostic', kind, ...fields }));
  }

  private send(payload: Record<string, unknown>): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(payload));
    return true;
  }
}

function transcriptTiming(event: Record<string, unknown>): { startMs: number | null; endMs: number | null } {
  const startMs = typeof event.start_ms === 'number' && Number.isFinite(event.start_ms) ? event.start_ms : null;
  const endMs = typeof event.end_ms === 'number' && Number.isFinite(event.end_ms) ? event.end_ms : null;
  return { startMs, endMs };
}
