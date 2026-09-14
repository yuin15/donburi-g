export type ConversationPacingState = {
  available: boolean;
  blocked: boolean;
};

const INITIAL_MIN_MS = 3_500;
const INITIAL_SPREAD_MS = 1_501;
const QUIET_MIN_MS = 3_000;
const QUIET_SPREAD_MS = 2_001;
const INITIATED_AUDIO_TIMEOUT_MS = 8_000;
const REPLY_WAIT_MS = 10_000;
const RETRY_BASE_MS = 9_000;
const RETRY_STEP_MS = 6_000;
const RETRY_JITTER_MS = 2_000;
const TRANSCRIPT_SETTLE_MS = 500;

/** Server-side pacing for one natural invitation at a time. */
export class ProactiveConversationPacer {
  private nextAt = 0;
  private replyDeadline = 0;
  private awaitingReply = false;
  private attempts = 0;
  private userText = '';
  private speechEndedAt: number | null = null;
  private settledShortTurn = false;
  private active = false;
  private quietUntil = 0;
  private quietGap = 0;
  private reservedInitiatedSpeech = false;
  private initiatedAudioDeadline = 0;
  private assistantUtteranceUntil = 0;

  constructor(private readonly random: () => number = Math.random) {}

  start(now = Date.now()): void {
    this.active = true;
    this.awaitingReply = false;
    this.attempts = 0;
    this.userText = '';
    this.speechEndedAt = null;
    this.settledShortTurn = false;
    this.reserveQuiet(now, false);
    this.nextAt = Math.max(now + INITIAL_MIN_MS + Math.floor(this.random() * INITIAL_SPREAD_MS), this.quietUntil);
  }

  stop(): void {
    this.active = false;
    this.awaitingReply = false;
    this.nextAt = 0;
    this.replyDeadline = 0;
    this.quietUntil = 0;
    this.reservedInitiatedSpeech = false;
    this.initiatedAudioDeadline = 0;
  }

  noteUserSpeech(): void {
    this.userText = '';
    this.speechEndedAt = null;
    this.settledShortTurn = false;
  }

  noteUserTranscript(delta: string, now = Date.now()): void {
    this.userText = `${this.userText}${delta}`.slice(-160);
    if (this.settledShortTurn && this.userText.trim().length > 8) {
      this.settledShortTurn = false;
      this.attempts = 0;
      this.scheduleRetry(now);
    }
  }

  /** Wait briefly because input transcript deltas can arrive after speech end. */
  noteUserSpeechEnd(now = Date.now()): void {
    if (!this.active) return;
    this.speechEndedAt = now;
    this.reserveQuiet(now, false);
  }

  noteAssistantSpeech(now = Date.now()): void {
    if (!this.active) return;
    if (now >= this.assistantUtteranceUntil && !this.reservedInitiatedSpeech) this.reserveQuiet(now, false);
    // One utterance draws one gap, while every audible PCM chunk extends the
    // same gap from its actual end so a long line cannot be followed abruptly.
    this.quietUntil = now + this.quietGap;
    this.reservedInitiatedSpeech = false;
    this.initiatedAudioDeadline = 0;
    this.assistantUtteranceUntil = now + 750;
    if (this.awaitingReply) {
      // The reply window begins after the invitation is actually spoken, not
      // when its append was accepted by the provider.
      this.replyDeadline = now + REPLY_WAIT_MS;
      return;
    }
    this.nextAt = Math.max(this.nextAt, this.quietUntil);
  }

  /** Time after which an unsolicited reaction, invitation, or offer may begin. */
  nextInitiatedAt(): number { return this.quietUntil; }

  canInitiate(now = Date.now()): boolean {
    return this.active && now >= this.quietUntil && (!this.reservedInitiatedSpeech || now >= this.initiatedAudioDeadline);
  }

  markInitiatedSpeechSent(now = Date.now()): void {
    if (this.canInitiate(now)) this.reserveQuiet(now);
  }

  /** Returns true only when a new invitation may be attempted now. */
  due(now: number, state: ConversationPacingState): boolean {
    if (!this.active) return false;
    if (this.speechEndedAt !== null) {
      if (now < this.speechEndedAt + TRANSCRIPT_SETTLE_MS) return false;
      this.settleUserTurn(now);
    }
    if (this.awaitingReply) {
      if (now < this.replyDeadline) return false;
      this.awaitingReply = false;
      this.attempts = Math.min(3, this.attempts + 1);
      this.scheduleRetry(now);
      return false;
    }
    return state.available && !state.blocked && this.canInitiate(now) && now >= this.nextAt;
  }

  /** Call only after the bridge has actually accepted the commentary append. */
  markInvitationSent(now = Date.now()): void {
    this.reserveQuiet(now);
    this.awaitingReply = true;
    this.replyDeadline = now + REPLY_WAIT_MS;
  }

  /** A rejected provider request must remain eligible later, without backoff. */
  retryAfterRejectedRequest(now = Date.now()): void {
    if (this.active) this.nextAt = now + 1_000;
  }

  hasPendingReply(): boolean {
    return this.awaitingReply || this.speechEndedAt !== null;
  }

  private scheduleRetry(now: number): void {
    const jitter = Math.floor(this.random() * RETRY_JITTER_MS);
    this.nextAt = now + RETRY_BASE_MS + this.attempts * RETRY_STEP_MS + jitter;
  }

  /** Reserve one stable 3–5 second gap when an append is accepted. */
  private reserveQuiet(now: number, awaitingAudio = true): void {
    this.quietGap = QUIET_MIN_MS + Math.floor(this.random() * QUIET_SPREAD_MS);
    this.quietUntil = now + this.quietGap;
    this.reservedInitiatedSpeech = awaitingAudio;
    this.initiatedAudioDeadline = awaitingAudio ? now + INITIATED_AUDIO_TIMEOUT_MS : 0;
  }

  private settleUserTurn(now: number): void {
    this.speechEndedAt = null;
    this.awaitingReply = false;
    this.replyDeadline = 0;
    this.settledShortTurn = this.userText.trim().length <= 8;
    if (this.settledShortTurn) this.attempts = Math.min(3, this.attempts + 1);
    else this.attempts = 0;
    this.scheduleRetry(now);
  }
}
