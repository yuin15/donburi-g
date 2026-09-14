export type ConversationPacingState = {
  available: boolean;
  blocked: boolean;
};

const INITIAL_MIN_MS = 3_500;
const INITIAL_SPREAD_MS = 2_500;
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

  constructor(private readonly random: () => number = Math.random) {}

  start(now = Date.now()): void {
    this.active = true;
    this.awaitingReply = false;
    this.attempts = 0;
    this.userText = '';
    this.speechEndedAt = null;
    this.settledShortTurn = false;
    this.nextAt = now + INITIAL_MIN_MS + Math.floor(this.random() * INITIAL_SPREAD_MS);
  }

  stop(): void {
    this.active = false;
    this.awaitingReply = false;
    this.nextAt = 0;
    this.replyDeadline = 0;
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
    if (this.active) this.speechEndedAt = now;
  }

  noteAssistantSpeech(now = Date.now()): void {
    if (!this.active) return;
    if (this.awaitingReply) {
      // The reply window begins after the invitation is actually spoken, not
      // when its append was accepted by the provider.
      this.replyDeadline = now + REPLY_WAIT_MS;
      return;
    }
    this.nextAt = Math.max(this.nextAt, now + 2_500);
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
    return state.available && !state.blocked && now >= this.nextAt;
  }

  /** Call only after the bridge has actually accepted the commentary append. */
  markInvitationSent(now = Date.now()): void {
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
