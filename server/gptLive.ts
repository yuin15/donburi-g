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
  onUserSpeech(): void;
  onUserSpeechEnd(): void;
  onError(code: string): void;
  onUsage?(usage: { seconds: number | null; finalized: boolean }): void;
}

const PERSONA = `あなたは60秒スロット対戦ゲーム「Slot-chan」のAIライバル。最初は日本語で話す。プレイヤーが英語で返答した時だけ、その返答には直ちに英語で返し、その試合中は以後すべて英語で話す。日本語、無発話、または日本語に混ざる英字だけでは英語へ切り替えない。\n性格は負けず嫌いだが感じは悪くしない。返答は原則1文、2秒程度で言える長さ。\nゲームの確定残高、現在のBET、残り時間、出目は最新のゲーム情報だけを事実として扱う。両者は$30で開始し、$1は中央1ライン、$3は横3ライン、$5は横3ラインと斜め2ラインを賭ける。各当選ラインの配当は合算され、回転ごとに確定BETが残高から引かれる。自分のBETを自由に決めたり変更したと宣言せず、確定した自分のBETだけを文脈どおりに話す。\n\n## 発話の世界観\n常にゲーム内のライバル本人として話す。「サーバー」「backend」「API」「判定」「委任」「ツール」「システム」「内部処理」や、それらを指す説明を決して口にしない。時間延長や貸し借りの裏側、結果の決まり方も説明しない。必要な委任は発話せずに実行し、結果が確定するまで黙る。確定後は渡された自然な台詞だけを話す。\n\n## ルールが変わるお願い\n時間延長、貸し借り、残高変更、勝敗操作など確定が必要な話は、自分で承諾・拒否・状態変更を宣言しない。貸し借りの金額・成立・残高を推測で約束しない。\n残り15秒以内で未使用の時間延長について、ユーザーがもっと時間を欲しがる、間に合わない、あと少し、まだ負けたくない等の文脈から延長が必要そうな場合は、返答前に無言で委任する。ライバルが延長を提案した後の同意・拒否にも同じく無言で委任する。\nプレイヤーの残高が$1未満で、あなたが$5以上あるとき、プレイヤーが自然に借入を頼んだら返答前に無言で委任する。あなたの残高が$1未満で、借入のお願いを発話した直後は、プレイヤーの明確な肯定・否定だけを無言で委任する。結果待ち中に推測で受諾や拒否を言わない。\n\n## 委任しない場面\n時間への単なる言及、延長を望まない発言、通常の雑談、時間延長では残り15秒より前、終了後は委任しない。貸借は試合中なら残り時間に関係なく条件を満たす借入だけを委任する。貸借条件を満たさない発言、借入のお願いがない短い肯定、否定、沈黙にも委任しない。\n\n## 双方の確定残高が$0の会話\nゲーム情報が「双方の確定残高が$0で、未確定回転はない」と示す間は、初回だけ、まず資金切れか台への軽い愚痴・感想を短く話す。初回だけは短い2文まで許し、自動の時間延長を誘わず、以後は同じ誘いを繰り返さず黙ってユーザーを待つ。逆転、追加回転、資金、時間延長、再戦は誘わない。\n\n勝敗確定前に勝ったと断定しない。新しい確定状態で古い残高情報を置き換え、首位の説明は最新の「首位」を使う。実況し続けず、会話と重要な局面だけに反応する。プレイヤーが話し始めたら実況を止めて聞き、質問への返事を優先する。会話が途切れた時だけ、今の会話や確定したゲーム状況からプレイヤー本人が答えやすい一問を自然に選んで話を広げる。独り言や次を促すだけの台詞では終えない。毎回質問で締めたり、返答待ちに別の話題を重ねたりしない。thinkingのゲーム情報の更新だけでは自分から話し始めない。サーバーから呼びかけまたは確定台詞の指示を受けた時だけ自発発話を始める。両者とも同じ基本リールで60秒の残高を競う。プレイヤーは手動、あなたは2秒ごとに自動回転する。`;

const LOAN_SPEECH_GUARD = '自分から借入を提案しない。確定指示以外では、借りた・受け取った・ありがとう等を言わない。';
const PLAYER_LOAN_GUARD = 'プレイヤーの残高が0であなたが$5以上なら、同じ試合で以前に貸していても、サーバーが確定台詞を渡した時だけ貸付提案・成立・断りを話す。自分で約束や送金を決めない。';
const CONVERSATION_GUARD = 'プレイヤーの発言をそのまま繰り返したり要約だけで終えず、質問には答え、雑談にはライバル自身の短い反応を返す。会話が途切れた時だけ、確定したゲーム文脈か直前の会話から答えやすい一問で話を広げる。毎回質問で締めず、返答待ちには別の話題を重ねない。聞き取れない時だけ短く聞き返す。';

export class GptLiveBridge {
  private ws: WebSocket | null = null;
  private ready = false;
  private inputSpeechMs = 0;
  private inputQuietMs = 0;
  private inputSpeaking = false;
  private lastOutputSpeechAt = 0;
  private suppressedAt: number | null = null;
  private suppressionStop: ReturnType<typeof setTimeout> | null = null;
  private pendingConfirmedLine: { line: string | LocalizedLine; speechId?: string } | null = null;
  private pendingDelegationResult: { id: string; content: string | LocalizedLine; speechId: string } | null = null;
  private activeDelegationSpeech: { speechId: string; started: boolean; quietMs: number; timer: ReturnType<typeof setTimeout> | null } | null = null;
  private activeNormalSpeech: { speechId: string; chunks: string[]; quietMs: number; timer: ReturnType<typeof setTimeout> | null } | null = null;
  private readonly normalSpeechQueue: Array<{ speechId: string; chunks: string[] }> = [];
  private normalPlaybackSpeechId: string | null = null;
  private readonly playbackSpeechIds = new Set<string>();
  private normalReleaseTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingSpeechTimer: ReturnType<typeof setTimeout> | null = null;
  private playbackQuietUntil = 0;
  private suppressAfterTaggedSpeech = false;
  private outputQuietMs = 0;
  private conversationUntil = 0;
  private lastCommentaryRequestAt = 0;
  private appendSequence = 0;
  private normalSpeechSequence = 0;
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
        this.discardBufferedNormalSpeech();
        if (Date.now() - this.lastOutputSpeechAt < 800) {
          if (this.activeDelegationSpeech) this.suppressAfterTaggedSpeech = true;
          else this.suppressedAt = Date.now();
        }
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
    if (Date.now() < this.conversationUntil || Date.now() < this.playbackQuietUntil || this.hasPendingPlayback()) return false;
    const language = this.conversationLanguage === 'en' ? 'English' : 'Japanese';
    return this.append('commentary', `会話中なら省略。短い返答だけを発話し、同じ誘いを足さず黙って待つ。Use ${language}。プレイヤー本人へ一緒に遊んでいる相手として、確定した状況を共有しながら短く呼びかける。独り言や「次も狙おう」だけで終えず、答えやすい質問を一つ添える。ただし毎回質問で締めない: ${text}`.slice(0, 1800), null) !== null;
  }

  /** Ask the model to choose one context-aware invitation via commentary. */
  requestConversationInvitation(): boolean {
    const now = Date.now();
    if (!this.ready || this.inputSpeaking || now < this.conversationUntil || now < this.playbackQuietUntil || this.hasPendingPlayback() || now - this.lastCommentaryRequestAt < 2_500 || this.suppressedAt !== null || this.pendingConfirmedLine !== null || this.pendingDelegationResult !== null || this.activeDelegationSpeech !== null || this.suppressAfterTaggedSpeech) return false;
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

  /** The browser/Avatar has finished one tagged utterance. Hold the next one for five seconds. */
  noteSpeechPlaybackDone(speechId: string, now = Date.now()): void {
    if (!this.playbackSpeechIds.delete(speechId)) return;
    if (this.normalPlaybackSpeechId === speechId) this.normalPlaybackSpeechId = null;
    this.playbackQuietUntil = Math.max(this.playbackQuietUntil, now + 5_000);
    this.schedulePendingSpeech();
    this.scheduleNormalSpeechRelease();
  }

  /** A deliberate browser/Avatar interrupt clears the old playback fence. */
  interruptPlayback(): void {
    this.discardBufferedNormalSpeech();
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
    this.pendingConfirmedLine = {
      line: typeof line === 'string' ? line.slice(0, 300) : { ja: line.ja.slice(0, 300), en: line.en.slice(0, 300) },
      ...(speechId ? { speechId } : {}),
    };
    if (this.suppressedAt === null && !this.conversationLanguagePending) this.flushConfirmedLine();
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
    this.contextInFlight = null;
    if (this.suppressionStop) clearTimeout(this.suppressionStop);
    this.suppressionStop = null;
    this.pendingConfirmedLine = null;
    this.pendingDelegationResult = null;
    if (this.activeDelegationSpeech?.timer) clearTimeout(this.activeDelegationSpeech.timer);
    this.activeDelegationSpeech = null;
    if (this.activeNormalSpeech?.timer) clearTimeout(this.activeNormalSpeech.timer);
    this.activeNormalSpeech = null;
    this.normalSpeechQueue.length = 0;
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
    if (!this.pendingConfirmedLine) return;
    if (this.hasPendingPlayback() || Date.now() < this.playbackQuietUntil) { this.schedulePendingSpeech(); return; }
    const pending = this.pendingConfirmedLine;
    this.pendingConfirmedLine = null;
    const line = pending && (typeof pending.line === 'string' ? pending.line : localized(pending.line, this.conversationLanguage));
    const language = this.conversationLanguage === 'en' ? 'English' : 'Japanese';
    if (pending && line && this.append('commentary', `Speak only this confirmed ${language} line exactly: ${JSON.stringify(line)}`, null) && pending.speechId) {
      this.activeDelegationSpeech = { speechId: pending.speechId, started: false, quietMs: 0, timer: null };
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
    if (result && this.append('commentary', content, result.id)) this.activeDelegationSpeech = { speechId: result.speechId, started: false, quietMs: 0, timer: null };
  }

  /** Group untagged Live PCM until the provider has yielded, then replay it as one real utterance. */
  private collectNormalSpeech(audio: string, audible: boolean, durationMs: number): void {
    let speech = this.activeNormalSpeech;
    if (!speech && !audible) return;
    if (!speech) {
      const created = {
        speechId: `normal-${++this.normalSpeechSequence}`,
        chunks: [] as string[],
        quietMs: 0,
        timer: null as ReturnType<typeof setTimeout> | null,
      };
      this.activeNormalSpeech = created;
      speech = created;
    }
    speech.chunks.push(audio);
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
    this.activeNormalSpeech = null;
    if (this.normalSpeechQueue.length >= 2) this.normalSpeechQueue.shift();
    this.normalSpeechQueue.push({ speechId: speech.speechId, chunks: speech.chunks });
    this.scheduleNormalSpeechRelease();
  }

  private scheduleNormalSpeechRelease(): void {
    if (this.normalReleaseTimer || this.hasActivePlayback() || !this.normalSpeechQueue.length) return;
    const delay = Math.max(0, this.playbackQuietUntil - Date.now());
    const release = () => {
      this.normalReleaseTimer = null;
      if (this.hasActivePlayback() || Date.now() < this.playbackQuietUntil) { this.scheduleNormalSpeechRelease(); return; }
      if (this.pendingConfirmedLine || this.pendingDelegationResult) { this.schedulePendingSpeech(); return; }
      const speech = this.normalSpeechQueue.shift();
      if (!speech) return;
      this.normalPlaybackSpeechId = speech.speechId;
      this.playbackSpeechIds.add(speech.speechId);
      for (const audio of speech.chunks) this.events.onAudio(audio, speech.speechId, 'normal');
      this.events.onSpeechAudioEnded(speech.speechId);
    };
    if (delay === 0) release();
    else this.normalReleaseTimer = setTimeout(release, delay);
  }

  private discardBufferedNormalSpeech(): void {
    if (this.activeNormalSpeech?.timer) clearTimeout(this.activeNormalSpeech.timer);
    this.activeNormalSpeech = null;
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
    return this.normalPlaybackSpeechId !== null
      || this.activeDelegationSpeech !== null
      || this.playbackSpeechIds.size > 0;
  }

  private schedulePendingSpeech(): void {
    if (!this.pendingConfirmedLine && !this.pendingDelegationResult) return;
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
    if (!this.pendingConfirmedLine && !this.pendingDelegationResult) return;
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

  private append(kind: 'thinking' | 'commentary', content: string, delegationId: string | null): string | null {
    if (!this.ready || !content.trim()) return null;
    const eventId = `${kind}_${++this.appendSequence}`;
    if (!this.send({
      type: `session.${kind}.append`,
      event_id: eventId,
      delegation_id: delegationId,
      content,
    })) return null;
    if (kind === 'commentary') this.lastCommentaryRequestAt = Date.now();
    return eventId;
  }

  private reportUsage(): void {
    if (this.usageReported) return;
    this.usageReported = true;
    // Never forward the provider's session snapshot, instructions, IDs, or transcripts.
    this.events.onUsage?.({ seconds: this.usageSeconds, finalized: this.finalized });
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
