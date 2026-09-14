import { rewardDuration, rewardSymbol } from './RewardPresentation';
import type { Bet, MatchSnapshot, ServerMessage, Side, SpinView, UpgradeId } from '../../shared/protocol';
import { upgradePrice } from '../../shared/shop';
import type { LiveSession } from '../client/LiveSession';
import type { AiConnectionState, AiProvider, AiRuntimeEvent } from '../client/AiStatus';
import {
  advanceMatch, applyTimeExtension, createMatch, getSnapshot, LOAN_AMOUNT, MANUAL_SPIN_INTERVAL, PAYOUT, requestManualSpin, setBet,
  startMatch, purchaseUpgrade, transferLoan, type GameEvent, type MatchState,
} from '../domain/game';
import { RoundPresentation } from './RoundPresentation';
import { RivalReactions } from './RivalReactions';
import { selectAmbientRivalExpression, selectResultRivalExpression } from './RivalExpressionSelection';
import type {
  GameCommands, GameExpression, GameMode, GameViewModelDependencies, GameViewState,
} from './GameViewState';

const INITIAL_LINE = 'Think you can beat me?';
const CPU_MESSAGE = 'CLICK / SPACE · PRESS AGAIN TO QUEUE';
const DEFAULT_NOTICE = '3 MATCHING SYMBOLS · CENTER LINE';

function voiceSetupFailureMessage(error: unknown, videoEnabled = false): string {
  const detail = error instanceof Error ? `${error.name}:${error.message}` : '';
  if (/NotAllowedError|SecurityError|permission_denied/.test(detail)) return 'Microphone permission was denied. Allow it in your browser, then retry AI voice.';
  if (/NotFoundError|microphone_unavailable/.test(detail)) return 'No microphone was found. Connect or select one, then retry AI voice.';
  if (/NotReadableError|microphone_start_failed/.test(detail)) return 'Your microphone is unavailable or busy. Close other audio apps, then retry AI voice.';
  if (/access_denied|missing_ticket/.test(detail)) return 'Your invite code was not accepted. Check it, then retry AI voice.';
  if (/avatar_connect_failed/.test(detail)) return 'Live video could not connect. Retry AI voice, or turn off live video.';
  if (videoEnabled && /voice_connect_failed|session_failed/.test(detail)) return 'AI voice or live video could not connect. Turn off live video and retry AI voice.';
  if (/connection_timeout|voice_connect_failed|session_failed|socket_closed|socket_error/.test(detail)) return 'AI voice did not become ready. Retry AI voice, or play a CPU duel.';
  return 'AI voice setup failed. Allow your microphone, then retry AI voice.';
}

/** Application state and commands, independent of the browser and renderer. */
export class GameViewModel implements GameCommands {
  private mode: GameMode = 'idle';
  private snapshot = getSnapshot(createMatch(1, 'preview'));
  private practiceState: MatchState | null = null;
  private practiceStartedAt = 0;
  private liveSession: LiveSession | null = null;
  private liveSnapshot: MatchSnapshot | null = null;
  private liveReelUpgrades: MatchSnapshot['upgrades'] = { player: [], rival: [] };
  private lastInviteCode = '';
  private gateVisible = true;
  private gateMessage = 'CPU play needs no external AI service.';
  private connecting = false;
  private connectionText = 'Ready to play';
  private voiceReady = false;
  private gameConnected = false;
  private voiceMuted = false;
  private micMuted = false;
  private micActive = false;
  private micLevel = 0;
  private effectsMuted = false;
  private aiConfigured = { gptLive: false, responses: false, liveAvatar: false, liveKit: false };
  private aiRuntime: Record<AiProvider, AiConnectionState> = { gptLive: 'idle', liveAvatar: 'idle', liveKit: 'idle' };
  private responsesState: AiConnectionState = 'idle';
  private countdown: GameViewState['countdown'] = null;
  private starting = false;
  private awaitingStart = false;
  private result: MatchSnapshot | null = null;
  private sessionRecord = { best: 0, streak: 0, newBest: false };
  private lastSpin: GameViewState['lastSpin'] = null;
  private displayBalances: Record<Side, number> = { player: 30, rival: 30 };
  private payout: GameViewState['payout'] = null;
  private cue: GameViewState['cue'] = null;
  private timeExtension: GameViewState['timeExtension'] = null;
  private loanTransfer: GameViewState['loanTransfer'] = null;
  private textChoice: GameViewState['textChoice'] = null;
  private textChoiceToken = 0;
  private readonly offeredTextChoices = new Set<'borrow' | 'lend' | 'extend'>();
  private rivalDistraction: GameViewState['rivalDistraction'] = null;
  private line = INITIAL_LINE;
  private videoEnabled = false;
  private videoActive = false;
  private heard = '';
  private lastHeardAt = 0;
  private assistantText = '';
  private conversation: GameViewState['conversation'] = 'idle';
  private conversationTimer: number | undefined;
  private expression: GameExpression = 'neutral';
  private reactionUntil = 0;
  private warnedTime = false;
  private previousLeader: Side | null = null;
  private readonly rivalReactions = new RivalReactions();
  private readonly rounds: RoundPresentation;
  private spinQueued = false;
  private spinPending = false;
  private spinAnimating = false;
  private spinNextAt = 0;
  private spinRequestId: string | undefined;
  private betRequestId: string | undefined;
  private practiceTimer: number | undefined;
  private spinQueueTimer: number | undefined;
  private spinRequestTimer: number | undefined;
  private cueTimer: number | undefined;
  private timeExtensionTimer: number | undefined;
  private loanTransferTimer: number | undefined;
  private textChoiceTimer: number | undefined;
  private payoutTimers: Partial<Record<Side, number>> = {};
  private assistantTimer: number | undefined;
  private revision = 0;
  private disposed = false;
  private purchaseCommand = 0;
  private readonly timers = new Set<number>();
  private readonly waits = new Map<number, (valid: boolean) => void>();
  private readonly listeners = new Set<(state: GameViewState) => void>();
  private published: GameViewState;

  constructor(private readonly deps: GameViewModelDependencies) {
    this.rounds = new RoundPresentation({
      play: (spin, stopped) => deps.presentation.playSpin(spin, stopped),
      settled: (spin, celebrate) => this.revealSpin(spin, celebrate),
      ended: snapshot => this.finishPresentation(snapshot),
    });
    this.published = this.buildState();
  }

  get state(): GameViewState { return this.published; }

  setAiDebugConfiguration(configured: GameViewState['aiDebug']['configured']): void {
    this.aiConfigured = { ...configured };
    this.emit();
  }

  setAiDebugUnavailable(): void {
    this.aiConfigured = { gptLive: false, responses: false, liveAvatar: false, liveKit: false };
    this.emit();
  }

  setAiDebugRuntime(provider: AiProvider, state: AiConnectionState): void {
    this.aiRuntime = { ...this.aiRuntime, [provider]: state };
    this.emit();
  }

  setAiDebugResponses(state: AiConnectionState): void {
    this.responsesState = state;
    this.emit();
  }

  subscribe(listener: (state: GameViewState) => void): () => void {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    listener(this.published);
    return () => { this.listeners.delete(listener); };
  }

  async startCpu(): Promise<void> {
    if (this.disposed) return;
    this.prepareCpu();
    await this.start();
  }

  async start(): Promise<void> {
    if (this.disposed || this.starting || this.connecting || this.awaitingStart || this.isPlaying() || this.mode === 'idle') return;
    if (this.mode === 'live' && (this.liveSnapshot?.status === 'result' || !this.liveSession)) {
      if (!this.lastInviteCode) return;
      const connected = await this.establishLive(this.lastInviteCode);
      if (connected === null || !this.isCurrent(connected)) return;
    }
    const current = this.revision;
    if (this.mode === 'live' && !this.gameConnected) {
      this.prepareCpu('Voice is unavailable. Ready for a CPU duel.');
      return;
    }
    this.resetBattle();
    this.starting = true;
    this.emit();
    try {
      if (!await this.runCountdown(current)) return;
      if (this.mode === 'practice') this.beginPractice();
      else if (this.liveSession) {
        this.awaitingStart = true;
        this.liveSession.send({ type: 'start' });
      }
    } catch (error) {
      if (this.isCurrent(current)) this.returnToGate(voiceSetupFailureMessage(error, this.videoEnabled));
    } finally {
      if (this.isCurrent(current)) { this.starting = false; this.emit(); }
    }
  }

  async connectLive(inviteCode: string, video = false): Promise<void> {
    if (this.disposed || this.connecting) return;
    const code = inviteCode.trim();
    if (!code) { this.gateMessage = 'Enter your invite code.'; this.emit(); return; }
    this.videoEnabled = video;
    const connected = await this.establishLive(code);
    if (connected === null || !this.isCurrent(connected)) return;
    this.lastInviteCode = code;
    this.gateVisible = false;
    this.emit();
    this.deps.presentation.focus('start');
  }

  requestSpin(): void {
    if (this.disposed || !this.isPlaying()) return;
    if (this.betRequestId || this.spinPending || this.spinAnimating || this.deps.clock.now() < this.spinNextAt) return;
    this.performManualSpin();
  }

  setBet(bet: Bet): void {
    if (this.disposed) return;
    if (this.mode === 'practice' && this.practiceState && setBet(this.practiceState, 'player', bet)) {
      this.consumeSnapshot(getSnapshot(this.practiceState));
    } else if (this.mode === 'live' && this.liveSession && !this.betRequestId) {
      const commandId = this.liveSession.setBet?.(bet);
      if (!commandId) return;
      this.betRequestId = commandId;
      this.snapshot = { ...this.snapshot, bets: { ...this.snapshot.bets, player: bet } };
      this.liveSnapshot = this.snapshot;
    }
    this.emit();
  }

  purchaseUpgrade(id: UpgradeId): void {
    if (this.disposed || !this.isPlaying()) return;
    const price = upgradePrice(this.snapshot.upgrades.player, id);
    if (price === null || Math.min(this.snapshot.scores.player, this.displayBalances.player) < price) return;
    const expectedCount = this.snapshot.upgrades.player.filter(value => value === id).length;
    if (this.practiceState) {
      this.processPracticeEvents(advanceMatch(this.practiceState, this.practiceElapsed()));
      purchaseUpgrade(this.practiceState, id, expectedCount);
      this.consumeSnapshot(getSnapshot(this.practiceState));
      this.maybeOfferTextChoice();
      this.emit();
    } else {
      this.liveSession?.send({ type: 'purchase', matchId: this.snapshot.matchId,
        commandId: `purchase:${++this.purchaseCommand}`, upgradeId: id, expectedCount });
    }
  }

  respondTextChoice(token: number, accepted: boolean): void {
    const choice = this.textChoice;
    if (this.disposed || this.mode !== 'practice' || !this.practiceState || !choice || choice.token !== token) return;
    if (this.deps.clock.now() >= choice.expiresAt) {
      this.clearTextChoice();
      this.line = 'Offer expired. Keep spinning.';
      this.emit();
      return;
    }
    // Clear first: a double click, timer, or stale DOM node cannot apply twice.
    this.clearTextChoice();
    this.processPracticeEvents(advanceMatch(this.practiceState, this.practiceElapsed()));
    this.consumeSnapshot(getSnapshot(this.practiceState));
    if (this.practiceState.status !== 'playing') { this.emit(); return; }
    if (!accepted) {
      this.line = choice.kind === 'extend' ? 'No extension. Finish strong.' : 'Offer declined. Keep spinning.';
      this.emit();
      return;
    }
    if (choice.kind === 'extend') {
      const event = applyTimeExtension(this.practiceState);
      if (event) {
        this.consumeSnapshot(event.after);
        this.presentTimeExtension(event.before.remaining, event.after.remaining);
        this.line = 'One more chance. +10 seconds.';
      }
    } else {
      const direction = choice.kind === 'borrow' ? 'rival_to_player' : 'player_to_rival';
      const event = transferLoan(this.practiceState, direction);
      if (event) {
        this.rounds.syncLoan(direction, LOAN_AMOUNT);
        this.displayBalances = { ...event.after.balances };
        this.consumeSnapshot(event.after);
        this.presentLoan(direction, LOAN_AMOUNT);
        this.line = direction === 'rival_to_player' ? 'Here. Make this $5 count.' : 'Fine. One $5 loan.';
      }
    }
    if (!this.textChoice) this.maybeOfferTextChoice();
    this.emit();
  }

  leave(): void {
    if (this.disposed) return;
    this.cancelBattle();
    this.mode = 'idle';
    this.gateVisible = true;
    this.gateMessage = 'Match closed. Play again anytime.';
    this.lastInviteCode = '';
    this.emit();
    this.deps.presentation.focus('gate');
  }

  toggleMicMuted(): void {
    if (this.disposed || !this.voiceReady || !this.micActive || this.snapshot.status === 'result') return;
    this.micMuted = !this.micMuted;
    this.micLevel = 0;
    this.liveSession?.setMicMuted(this.micMuted);
    if (this.micMuted && this.conversation === 'listening') this.setConversation('idle');
    this.emit();
  }

  toggleVoiceMuted(): void {
    if (this.disposed) return;
    this.voiceMuted = !this.voiceMuted;
    this.liveSession?.setMuted(this.voiceMuted);
    this.emit();
  }

  toggleEffectsMuted(): void {
    if (this.disposed) return;
    this.effectsMuted = !this.effectsMuted;
    this.deps.presentation.setEffectsMuted(this.effectsMuted);
    this.emit();
  }

  visibilityChanged(): void {
    if (this.disposed) return;
    if (!this.deps.isVisible()) {
      this.spinQueued = false;
      this.cancelTimer(this.spinQueueTimer);
      this.spinQueueTimer = undefined;
    } else if (this.mode === 'live') this.liveSession?.send({ type: 'snapshot' });
    this.emit();
  }

  dispose(): void {
    if (this.disposed) return;
    this.cancelBattle();
    this.disposed = true;
    this.lastInviteCode = '';
    this.listeners.clear();
  }

  private isCurrent(revision: number): boolean { return !this.disposed && this.revision === revision; }
  private isPlaying(): boolean { return (this.mode === 'practice' ? this.practiceState?.status : this.mode === 'live' ? this.liveSnapshot?.status : undefined) === 'playing'; }
  private practiceElapsed(): number { return (this.deps.clock.now() - this.practiceStartedAt) / 1000; }

  private schedule(action: () => void, delay: number): number {
    const current = this.revision;
    const id = this.deps.clock.setTimeout(() => {
      this.timers.delete(id);
      if (this.isCurrent(current)) action();
    }, delay);
    this.timers.add(id);
    return id;
  }

  private cancelTimer(id: number | undefined): void {
    if (id === undefined) return;
    this.deps.clock.clearTimeout(id);
    this.timers.delete(id);
  }

  private clearTimers(): void {
    for (const id of this.timers) this.deps.clock.clearTimeout(id);
    this.timers.clear();
    for (const [id, resolve] of this.waits) { this.deps.clock.clearTimeout(id); resolve(false); }
    this.waits.clear();
    this.practiceTimer = this.spinQueueTimer = this.spinRequestTimer = undefined;
    this.cueTimer = this.assistantTimer = this.conversationTimer = this.timeExtensionTimer = this.loanTransferTimer = this.textChoiceTimer = undefined;
    this.payoutTimers = {};
  }

  private wait(delay: number, current: number): Promise<boolean> {
    return new Promise(resolve => {
      const id = this.deps.clock.setTimeout(() => { this.waits.delete(id); resolve(this.isCurrent(current)); }, delay);
      this.waits.set(id, resolve);
    });
  }

  private async runCountdown(current: number): Promise<boolean> {
    for (const value of [3, 2, 1] as const) {
      this.countdown = value;
      this.emit();
      if (!await this.wait(450, current)) return false;
    }
    this.countdown = 'GO!';
    this.emit();
    if (!await this.wait(300, current)) return false;
    this.countdown = null;
    return true;
  }

  private cancelBattle(): void {
    this.revision += 1;
    this.clearTimers();
    this.clearSpinInput();
    this.rounds.reset();
    this.deps.presentation.stopScene();
    this.deps.presentation.stopSound();
    this.practiceState = null;
    this.liveSnapshot = null;
    this.betRequestId = undefined;
    this.voiceReady = false;
    this.micActive = false;
    this.micLevel = 0;
    this.gameConnected = false;
    this.connecting = false;
    this.starting = false;
    this.awaitingStart = false;
    this.countdown = null;
    this.payout = null;
    this.cue = null;
    this.timeExtension = null;
    this.loanTransfer = null;
    this.clearTextChoice();
    this.offeredTextChoices.clear();
    this.rivalDistraction = null;
    this.assistantText = '';
    this.conversation = 'idle';
    const previous = this.liveSession;
    this.liveSession = null;
    void previous?.disconnect().catch(() => undefined);
  }

  private resetBattle(): void {
    this.clearTimers();
    this.clearSpinInput();
    this.rounds.reset();
    this.deps.presentation.stopSound();
    this.deps.presentation.resetScene();
    this.snapshot = getSnapshot(createMatch(1, 'preview'));
    this.displayBalances = { ...this.snapshot.balances };
    this.liveReelUpgrades = { player: [], rival: [] };
    this.result = null;
    this.sessionRecord.newBest = false;
    this.lastSpin = null;
    this.payout = null;
    this.cue = null;
    this.timeExtension = null;
    this.loanTransfer = null;
    this.clearTextChoice();
    this.offeredTextChoices.clear();
    this.rivalDistraction = null;
    this.line = INITIAL_LINE;
    this.heard = this.assistantText = '';
    this.conversation = 'idle';
    this.expression = 'neutral';
    this.reactionUntil = 0;
    this.warnedTime = false;
    this.previousLeader = null;
    this.rivalReactions.reset();
  }

  private prepareCpu(message = CPU_MESSAGE): void {
    this.cancelBattle();
    this.resetBattle();
    this.mode = 'practice';
    this.gateVisible = false;
    this.connectionText = message;
    this.emit();
    this.deps.presentation.focus('start');
  }

  private beginPractice(): void {
    this.practiceState = createMatch(Math.floor(this.deps.random() * 0xffff_ffff), undefined, 'manual');
    startMatch(this.practiceState);
    this.practiceStartedAt = this.deps.clock.now();
    this.consumeSnapshot(getSnapshot(this.practiceState));
    this.maybeOfferTextChoice();
    this.emit();
    this.deps.presentation.focus('start');
    const tick = () => {
      if (!this.practiceState || this.practiceState.status !== 'playing') return;
      this.processPracticeEvents(advanceMatch(this.practiceState, this.practiceElapsed()));
      this.consumeSnapshot(getSnapshot(this.practiceState));
      this.maybeOfferTextChoice();
      this.emit();
      if (this.practiceState.status === 'playing') this.practiceTimer = this.schedule(tick, 100);
    };
    this.practiceTimer = this.schedule(tick, 100);
  }

  private processPracticeEvents(events: GameEvent[]): void {
    const newest = new Map<Side, GameEvent>();
    for (const event of events) if (event.type === 'side_spin') newest.set(event.spin.side, event);
    for (const event of events) {
      if (event.type === 'side_spin' && event === newest.get(event.spin.side)) this.handleSpin(event.spin, this.practiceState?.upgrades);
      if (event.type === 'match_end') {
        this.cancelTimer(this.practiceTimer);
        this.practiceTimer = undefined;
        this.rounds.end(event.snapshot);
      }
    }
  }

  private syncPurchases(snapshot: MatchSnapshot): void {
    const previous = this.rounds.scores.player;
    this.rounds.syncPurchases(snapshot.upgradeSpent ?? 0);
    this.displayBalances.player += this.rounds.scores.player - previous;
  }

  private consumeSnapshot(snapshot: MatchSnapshot): void {
    this.syncPurchases(snapshot);
    this.snapshot = snapshot;
    if (snapshot.status === 'playing' || snapshot.status === 'result' || snapshot.status === 'aborted') this.awaitingStart = false;
    if (snapshot.status === 'playing') {
      if (!this.warnedTime && snapshot.remaining <= 10) { this.warnedTime = true; this.deps.presentation.playSound('warning'); }
    }
    if (snapshot.status === 'result' || snapshot.status === 'aborted') this.clearSpinInput();
    if (snapshot.status === 'result' || snapshot.status === 'aborted') this.clearTextChoice();
  }

  private clearSpinInput(): void {
    this.cancelTimer(this.spinQueueTimer);
    this.cancelTimer(this.spinRequestTimer);
    this.spinQueueTimer = this.spinRequestTimer = undefined;
    this.spinQueued = this.spinPending = this.spinAnimating = false;
    this.spinNextAt = 0;
    this.spinRequestId = undefined;
  }

  private clearTextChoice(): void {
    this.cancelTimer(this.textChoiceTimer);
    this.textChoiceTimer = undefined;
    this.textChoice = null;
  }

  private maybeOfferTextChoice(): void {
    const state = this.practiceState;
    if (this.mode !== 'practice' || this.voiceReady || !state || state.status !== 'playing') return;
    if (this.textChoice) {
      if (this.isTextChoiceEligible(state, this.textChoice.kind)) return;
      this.clearTextChoice();
    }
    let choice: Omit<NonNullable<GameViewState['textChoice']>, 'token' | 'expiresAt'> | null = null;
    // A player without even the minimum bet gets the first decision. The rival
    // gets the next priority, then the late-match extension.
    if (!this.offeredTextChoices.has('borrow') && state.scores.player < 1 && state.scores.rival >= LOAN_AMOUNT) {
      choice = { kind: 'borrow', question: 'BORROW $5?', detail: 'Ask your rival for one more spin.', acceptLabel: 'BORROW $5', declineLabel: 'DECLINE' };
    } else if (!this.offeredTextChoices.has('lend') && state.scores.rival < 1 && state.scores.player >= LOAN_AMOUNT) {
      choice = { kind: 'lend', question: 'LEND $5?', detail: 'Your rival is out of cash.', acceptLabel: 'LEND $5', declineLabel: 'DECLINE' };
    } else if (!this.offeredTextChoices.has('extend') && !state.extensionUsed && state.duration === 60 && state.remaining <= 15) {
      choice = { kind: 'extend', question: 'EXTEND THE DUEL?', detail: 'Add 10 seconds for one more chance.', acceptLabel: 'EXTEND +10 SEC', declineLabel: 'DECLINE' };
    }
    if (!choice) return;
    this.offeredTextChoices.add(choice.kind);
    const token = ++this.textChoiceToken;
    const expiresAt = this.deps.clock.now() + 5000;
    this.textChoice = { ...choice, token, expiresAt };
    this.textChoiceTimer = this.schedule(() => {
      if (this.textChoice?.token !== token) return;
      this.clearTextChoice();
      this.line = 'Offer expired. Keep spinning.';
      this.emit();
    }, 5000);
  }

  private isTextChoiceEligible(state: MatchState, kind: NonNullable<GameViewState['textChoice']>['kind']): boolean {
    if (kind === 'borrow') return state.scores.player < 1 && state.scores.rival >= LOAN_AMOUNT && !state.loanUsed.rival_to_player;
    if (kind === 'lend') return state.scores.rival < 1 && state.scores.player >= LOAN_AMOUNT && !state.loanUsed.player_to_rival;
    return !state.extensionUsed && state.duration === 60 && state.remaining <= 15;
  }

  private presentTimeExtension(before: number, after: number): void {
    this.timeExtension = { decision: 'accepted', before, after };
    this.deps.presentation.playSound('ruleChange');
    this.cancelTimer(this.timeExtensionTimer);
    this.timeExtensionTimer = this.schedule(() => { this.timeExtension = null; this.emit(); }, 1350);
  }

  private presentLoan(direction: 'rival_to_player' | 'player_to_rival', amount: 5): void {
    this.loanTransfer = { direction, amount };
    this.cancelTimer(this.loanTransferTimer);
    this.loanTransferTimer = this.schedule(() => { this.loanTransfer = null; this.emit(); }, 1800);
  }

  private flushSpinQueue(): void {
    this.cancelTimer(this.spinQueueTimer);
    this.spinQueueTimer = undefined;
    if (!this.isPlaying() || !this.deps.isVisible()) { this.spinQueued = false; this.emit(); return; }
    if (!this.spinQueued || this.spinPending || this.spinAnimating) return;
    const delay = this.spinNextAt - this.deps.clock.now();
    if (delay > 0) { this.spinQueueTimer = this.schedule(() => this.flushSpinQueue(), delay + 1); return; }
    this.performManualSpin();
  }

  private performManualSpin(): void {
    if (!this.isPlaying()) return;
    this.spinQueued = false;
    this.spinPending = true;
    this.spinNextAt = this.deps.clock.now() + MANUAL_SPIN_INTERVAL * 1000 + 10;
    if (this.mode === 'practice' && this.practiceState) {
      const events = requestManualSpin(this.practiceState, this.practiceElapsed());
      this.spinPending = false;
      this.processPracticeEvents(events);
      this.consumeSnapshot(getSnapshot(this.practiceState));
      this.maybeOfferTextChoice();
    } else if (this.mode === 'live') {
      this.spinRequestId = this.liveSession?.sendSpin();
      if (this.spinRequestId) {
        this.spinRequestTimer = this.schedule(() => {
          this.spinPending = this.spinQueued = false;
          this.spinRequestId = undefined;
          this.liveSession?.send({ type: 'snapshot' });
          this.emit();
        }, 6000);
      } else this.spinPending = false;
    }
    this.emit();
  }

  private handleSpin(spin: SpinView, upgrades = this.snapshot.upgrades): void {
    const confirmed = { ...spin, upgrades: [...(spin.upgrades ?? upgrades[spin.side])] };
    if (!this.rounds.spin(confirmed)) return;
    // `play` may settle synchronously. Read the presentation's authoritative
    // current value so an accepted spin shows its paid BET before stopping, but
    // a synchronous stop remains at its confirmed total.
    this.displayBalances[spin.side] = this.rounds.scores[spin.side];
    if (spin.side === 'player') {
      const lastSpin = { ...this.lastSpin };
      delete lastSpin.player;
      this.lastSpin = lastSpin;
      this.spinAnimating = true;
      this.spinPending = false;
      this.spinRequestId = undefined;
      this.cancelTimer(this.spinRequestTimer);
      this.spinRequestTimer = undefined;
      this.deps.presentation.playSound('spin');
    }
  }

  private revealSpin(spin: SpinView, celebrate: boolean): void {
    const side = spin.side;
    if (side === 'player') this.spinAnimating = false;
    this.lastSpin = { ...this.lastSpin, [side]: spin };
    this.displayBalances[side] = this.rounds.scores[side];
    // RoundPresentation starts at zero so it can wait for both reel stops. The
    // bankroll already includes the untouched side's starting cash and the paid BET.
    const scores = this.displayBalances;
    const leader = scores.player > scores.rival ? 'player' : scores.player < scores.rival ? 'rival' : null;
    const settled = this.rounds.isSettled;
    const comeback = settled && leader && this.previousLeader && leader !== this.previousLeader;
    if (settled && leader) this.previousLeader = leader;
    const stale = !celebrate || !this.deps.isVisible() || this.snapshot.rounds[side] > spin.round;
    this.clearPayout(side);
    if (!stale) {
      if (spin.payout) {
        this.payout = { player: 0, rival: 0, ...this.payout, [side]: spin.payout };
        this.payoutTimers[side] = this.schedule(() => { this.clearPayout(side); this.emit(); }, rewardDuration(spin.payout, rewardSymbol(spin)));
      }
      if (side === 'player' && this.cue?.kind !== 'warning') { this.cancelTimer(this.cueTimer); this.cue = null; }
      this.reactionUntil = this.deps.clock.now() + 1600;
      const reaction = this.rivalReactions.nextSpin(spin, scores, this.snapshot.remaining, comeback ? leader : null);
      this.expression = reaction.expression;
      if (!this.voiceReady) this.line = reaction.text;
      if (side === 'player' && spin.payout >= PAYOUT.seven) this.announce('BIG WIN', 'jackpot');
      else if (spin.payout) this.deps.presentation.playSound(side === 'player' ? rewardSymbol(spin) === 'bell' ? 'bellWin' : 'win' : 'rivalWin');
      else if (comeback) this.deps.presentation.playSound('lead');
    }
    this.emit();
  }

  private clearPayout(side: Side): void {
    this.cancelTimer(this.payoutTimers[side]);
    delete this.payoutTimers[side];
    if (this.payout) {
      this.payout = { ...this.payout, [side]: 0 };
      if (!this.payout.player && !this.payout.rival) this.payout = null;
    }
  }

  private announce(text: string, kind: 'lead' | 'warning' | 'jackpot'): void {
    this.cancelTimer(this.cueTimer);
    this.cue = { text, kind };
    this.deps.presentation.playSound(kind);
    this.cueTimer = this.schedule(() => { this.cue = null; this.emit(); }, 1800);
  }

  private finishPresentation(snapshot: MatchSnapshot): void {
    this.consumeSnapshot(snapshot);
    const current = this.revision;
    const fallbackFrom = this.voiceReady ? null : this.line;
    this.deps.presentation.celebrateResult(snapshot.winner ?? 'draw', () => {
      if (this.isCurrent(current)) this.publishResult(snapshot, fallbackFrom);
    });
  }

  private publishResult(snapshot: MatchSnapshot, fallbackFrom: string | null): void {
    this.clearTextChoice();
    if (this.result?.matchId !== snapshot.matchId) {
      this.sessionRecord.newBest = snapshot.scores.player > this.sessionRecord.best;
      this.sessionRecord.best = Math.max(this.sessionRecord.best, snapshot.scores.player);
      this.sessionRecord.streak = snapshot.winner === 'player' ? this.sessionRecord.streak + 1 : 0;
    }
    this.result = snapshot;
    this.clearPayout('player');
    this.clearPayout('rival');
    this.cancelTimer(this.cueTimer);
    this.payout = this.cue = null;
    this.expression = selectResultRivalExpression(snapshot);
    this.reactionUntil = Infinity;
    // Voice may close or deliver its final caption while the cabinet is turning.
    if (fallbackFrom !== null && this.line === fallbackFrom) this.showResultLine(snapshot);
    this.emit();
    this.deps.presentation.stopSound();
    this.deps.presentation.playSound(snapshot.winner === 'player' ? 'victory' : snapshot.winner === 'rival' ? 'defeat' : 'draw');
    this.deps.presentation.focus('start');
  }

  private showResultLine(snapshot: MatchSnapshot): void {
    this.line = snapshot.winner === 'player' ? 'You got me. Rematch?' : snapshot.winner === 'rival' ? 'That round is mine. Go again?' : 'A tie! Let\'s settle it next round.';
  }

  private prepareLiveResult(snapshot: MatchSnapshot): void {
    if (snapshot.status !== 'result' || (this.liveSnapshot?.status === 'result' && this.liveSnapshot.matchId === snapshot.matchId)) return;
    this.cancelTimer(this.assistantTimer);
    this.assistantText = this.heard = '';
    this.setConversation('idle');
    if (this.voiceReady) { this.line = '…'; this.connectionText = 'Mic off · Waiting for the final reaction'; }
  }

  private async establishLive(code: string): Promise<number | null> {
    this.cancelBattle();
    const current = this.revision;
    this.mode = 'live';
    this.resetBattle();
    this.connecting = true;
    this.connectionText = 'Checking microphone permission…';
    this.gateMessage = 'Allow your microphone to talk to your rival.';
    this.emit();
    let session: LiveSession | undefined;
    try {
      session = await this.deps.liveFactory({
        message: message => { if (this.isCurrent(current) && session && this.liveSession === session) this.onLiveMessage(message); },
        disconnect: () => { if (this.isCurrent(current) && session && this.liveSession === session) this.onLiveDisconnect(); },
        microphone: state => {
          if (!this.isCurrent(current) || !session || this.liveSession !== session) return;
          this.micActive = state.active;
          this.micLevel = state.active && !this.micMuted ? state.level : 0;
          this.emit();
        },
        aiStatus: event => {
          if (this.isCurrent(current) && session && this.liveSession === session) this.onAiStatus(event);
        },
        route: () => {
          if (!this.isCurrent(current) || !session || this.liveSession !== session) return;
          this.videoActive = false;
          this.connectionText = 'Live video ended · Voice continues';
          this.emit();
        },
      });
      if (!this.isCurrent(current)) { await session.disconnect(); return null; }
      this.liveSession = session;
      this.videoActive = this.videoEnabled;
      session.setMuted(this.voiceMuted);
      session.setMicMuted(this.micMuted);
      await session.connect(code, this.videoEnabled ? 'avatar' : 'audio');
      if (!this.isCurrent(current) || this.liveSession !== session) return null;
      this.connecting = false;
      this.emit();
      return current;
    } catch (error) {
      if (this.isCurrent(current)) this.returnToGate(voiceSetupFailureMessage(error, this.videoEnabled));
      return null;
    }
  }

  private onLiveDisconnect(): void {
    this.voiceReady = false;
    this.micActive = false;
    this.micLevel = 0;
    // LiveClient dispatches disconnect before rejecting a setup failure. Keep
    // this generation valid so establishLive can show its classified retry UI.
    if (this.connecting && !this.gameConnected && !this.liveSnapshot) return;
    if (this.liveSnapshot?.status === 'result') {
      this.connectionText = 'Voice closed · Ready for a rematch';
      this.liveSession = null;
      this.emit();
    } else if (!this.liveSnapshot || this.liveSnapshot.status === 'ready') {
      this.prepareCpu('Voice closed. Ready for a CPU duel.');
    } else this.returnToGate('Game connection closed. Start a CPU duel to play again.');
  }

  private onAiStatus(event: AiRuntimeEvent): void {
    this.aiRuntime = { ...this.aiRuntime, [event.provider]: event.state };
    this.emit();
  }

  private returnToGate(message: string): void {
    this.cancelBattle();
    this.mode = 'idle';
    this.gateVisible = true;
    this.gateMessage = message;
    this.emit();
    this.deps.presentation.focus('gate');
  }

  private onLiveMessage(message: ServerMessage): void {
    if (message.type === 'bet_status') {
      if (message.commandId !== this.betRequestId) return;
      this.betRequestId = undefined;
      this.snapshot = { ...this.snapshot, bets: { ...this.snapshot.bets, player: message.bet } };
      this.liveSnapshot = this.snapshot;
    } else if (message.type === 'spin_status') {
      if (message.commandId !== this.spinRequestId) return;
      if (!message.accepted) {
        this.cancelTimer(this.spinRequestTimer);
        this.spinRequestId = undefined;
        this.spinPending = false;
        this.spinQueued = false;
        this.spinNextAt = this.deps.clock.now() + message.retryAfterMs + 10;
      }
    } else if (message.type === 'voice_status') {
      this.connectionText = message.status === 'ready' ? 'VOICE READY' : message.status === 'connecting' ? 'Connecting voice…' : message.status === 'closed' ? 'Voice closed' : message.message ?? 'Voice unavailable';
      this.voiceReady = message.status === 'ready';
      if (message.status === 'closed' || message.status === 'error') { this.micActive = false; this.micLevel = 0; this.setConversation('idle'); }
      if (this.voiceReady) this.gameConnected = true;
      if (!this.voiceReady && this.gameConnected) {
        this.heard = this.assistantText = '';
        this.cancelTimer(this.assistantTimer);
        if (this.liveSnapshot?.status === 'result' && (message.status === 'error' || this.line === '…')) this.showResultLine(this.liveSnapshot);
      }
    } else if (message.type === 'snapshot') {
      const enteringPlay = this.liveSnapshot?.status !== 'playing' && message.snapshot.status === 'playing';
      this.prepareLiveResult(message.snapshot);
      this.liveSnapshot = message.snapshot;
      this.syncRivalDistraction(message.snapshot);
      this.liveReelUpgrades = { player: [...message.snapshot.upgrades.player], rival: [...message.snapshot.upgrades.rival] };
      const last = message.lastSpins ?? message.lastSpin;
      this.syncPurchases(message.snapshot);
      if (last) for (const side of ['player', 'rival'] as const) {
        if (last[side]) this.handleSpin(last[side], message.snapshot.upgrades);
      }
      this.consumeSnapshot(message.snapshot);
      if (message.snapshot.status === 'playing') this.awaitingStart = false;
      if (message.snapshot.status === 'result') this.rounds.end(message.snapshot);
      if (enteringPlay) { this.emit(); this.deps.presentation.focus('start'); }
    } else if (message.type === 'spin') {
      this.handleSpin(message.player, this.liveReelUpgrades);
      this.handleSpin(message.rival, this.liveReelUpgrades);
    } else if (message.type === 'side_spin') {
      this.handleSpin(message.spin, this.liveReelUpgrades);
    } else if (message.type === 'rival_line') {
      if (!this.voiceReady) this.line = message.text;
    } else if (message.type === 'time_extension') {
      this.liveSnapshot = message.after;
      this.consumeSnapshot(message.after);
      this.assistantText = this.heard = '';
      this.line = message.line;
      this.setConversation('replying');
      if (message.decision === 'accepted') {
        this.presentTimeExtension(message.before.remaining, message.after.remaining);
      }
    } else if (message.type === 'loan_transfer') {
      // Apply the authoritative post-transfer snapshot before waiting for any
      // later spin presentation. This prevents an old displayed balance from
      // briefly returning while reels settle.
      this.liveSnapshot = message.after;
      this.rounds.syncLoan(message.direction, message.amount);
      this.displayBalances = { ...message.after.balances };
      this.consumeSnapshot(message.after);
      this.assistantText = this.heard = '';
      this.line = message.line;
      this.setConversation('replying');
      this.presentLoan(message.direction, message.amount);
    } else if (message.type === 'rival_distraction') {
      this.line = message.line;
      this.setConversation('replying');
      this.rivalDistraction = message.state === 'started' ? { active: true, seconds: message.seconds } : null;
    } else if (message.type === 'voice_interrupt') {
      this.cancelTimer(this.assistantTimer);
      this.assistantText = this.heard = '';
      // The same transport event also clears playback before the final reaction.
      if (this.voiceReady && this.liveSnapshot?.status !== 'result') {
        this.line = 'Listening…';
        this.setConversation('listening');
      }
    } else if (message.type === 'transcript') {
      if (message.role === 'user') {
        this.cancelTimer(this.assistantTimer);
        this.assistantText = '';
        this.line = 'Listening…';
        this.setConversation('listening');
        const now = this.deps.clock.now();
        const previous = now - this.lastHeardAt < 2500 ? this.heard.replace(/^YOU: /, '') : '';
        this.heard = `YOU: ${`${previous}${message.delta}`.slice(-120)}`;
        this.lastHeardAt = now;
      }
      else {
        this.cancelTimer(this.assistantTimer);
        this.assistantText = `${this.assistantText}${message.delta}`.slice(-120);
        this.line = this.assistantText;
        this.setConversation('replying');
        if (this.liveSnapshot?.status === 'result') this.connectionText = 'Mic off · Final reaction';
        this.assistantTimer = this.schedule(() => { this.assistantText = ''; }, 2500);
      }
    } else if (message.type === 'match_ended') {
      this.prepareLiveResult(message.snapshot);
      this.liveSnapshot = message.snapshot;
      this.syncRivalDistraction(message.snapshot);
      this.consumeSnapshot(message.snapshot);
      this.rounds.end(message.snapshot);
    } else if (message.type === 'error') {
      this.connectionText = message.message;
      if (!message.recoverable) {
        // The server reserves enough lifetime for a full duel. A lobby timeout
        // must remain visible as a retry option instead of becoming CPU silently.
        if (message.code === 'lobby_timeout') {
          this.returnToGate(`${message.message} Retry AI voice, or start a CPU duel.`);
          return;
        }
        // LiveClient forwards a server error before rejecting setup. Preserve
        // the generation so establishLive can classify it for a retry.
        if (this.connecting && !this.gameConnected && !this.liveSnapshot) return;
        if (!this.liveSnapshot || this.liveSnapshot.status === 'ready') this.prepareCpu('Voice is unavailable. Ready for a CPU duel.');
        else this.returnToGate(`${message.message} Start a CPU duel to play again.`);
      }
    }
    this.emit();
  }

  private setConversation(phase: GameViewState['conversation']): void {
    this.cancelTimer(this.conversationTimer);
    this.conversation = phase;
    if (phase === 'idle') {
      if (this.line === 'Listening…') this.line = '…';
      return;
    }
    this.conversationTimer = this.schedule(() => {
      this.conversation = 'idle';
      if (this.line === 'Listening…') this.line = '…';
      this.emit();
    }, 3000);
  }

  private syncRivalDistraction(snapshot: MatchSnapshot): void {
    const distraction = snapshot.rivalDistraction;
    if (distraction && distraction.untilElapsed > snapshot.elapsed) {
      this.rivalDistraction = { active: true, seconds: distraction.seconds };
    } else if (this.rivalDistraction?.active) {
      this.rivalDistraction = null;
    }
  }

  private buildState(): GameViewState {
    const now = this.deps.clock.now();
    const scores = { ...this.displayBalances };
    const gap = scores.player - scores.rival;
    const playing = this.isPlaying();
    const busy = !!this.betRequestId || this.spinPending || this.spinAnimating || now < this.spinNextAt;
    const spinState = playing ? busy ? 'spinning' : 'ready' : null;
    const hint = '';
    const finalStopping = this.snapshot.status === 'result' && !this.result;
    const disabled = playing ? busy : this.mode === 'idle' || this.connecting || this.starting || this.awaitingStart || finalStopping || (this.mode === 'live' && !this.gameConnected);
    const label = playing ? 'SPIN' : finalStopping ? 'LAST SPIN' : this.result ? 'REMATCH' : this.connecting || this.starting || this.awaitingStart ? 'READY…' : 'PLAY';
    return {
      mode: this.mode, snapshot: structuredClone(this.snapshot), scores, balances: { ...this.snapshot.balances }, bets: { ...this.snapshot.bets }, lastSpin: this.lastSpin ? structuredClone(this.lastSpin) : null,
      gate: { visible: this.gateVisible, message: this.gateMessage, connecting: this.connecting },
      connection: { text: this.connectionText, voiceReady: this.voiceReady, showVideo: this.voiceReady && this.videoActive, showVoiceControls: this.mode === 'live' && (!this.gameConnected || this.voiceReady) },
      modeBadge: { text: this.mode === 'idle' ? 'CPU DUEL' : this.voiceReady ? 'LIVE AI' : 'CPU DUEL', tone: this.mode === 'idle' ? 'idle' : this.voiceReady ? 'live' : 'practice' },
      countdown: this.countdown, startControl: { disabled, label, spinState, hint },
      machineNotice: playing && this.snapshot.remaining <= 10 ? 'FINAL SPINS · KEEP GOING' : DEFAULT_NOTICE,
      sessionRecord: { ...this.sessionRecord },
      result: this.result ? structuredClone(this.result) : null, payout: this.payout ? { ...this.payout } : null, cue: this.cue ? { ...this.cue } : null, timeExtension: this.timeExtension ? { ...this.timeExtension } : null, loanTransfer: this.loanTransfer ? { ...this.loanTransfer } : null, textChoice: this.textChoice ? { ...this.textChoice } : null, rivalDistraction: this.rivalDistraction ? { ...this.rivalDistraction } : null,
      expression: this.result || now < this.reactionUntil ? this.expression : selectAmbientRivalExpression({
        scores, remaining: this.snapshot.remaining, playing,
        spinning: !this.rounds.isSettled, countdown: this.countdown !== null,
        textChoice: this.textChoice !== null, listening: this.conversation === 'listening',
        distracted: !!this.rivalDistraction?.active,
      }),
      rivalMood: this.rivalDistraction?.active ? 'DISTRACTED...' : this.snapshot.status === 'result' ? gap > 0 ? 'Next round is mine.' : gap < 0 ? 'Up for a rematch?' : 'One more to settle it.' : gap > 0 ? 'I can still catch you.' : gap < 0 ? 'Catch me if you can.' : '60 seconds. Let\'s play.',
      microphone: { visible: this.mode === 'live' && this.voiceReady, active: this.micActive && this.snapshot.status !== 'result', muted: this.micMuted, level: this.micActive && !this.micMuted && this.snapshot.status !== 'result' ? this.micLevel : 0 },
      line: this.line, heard: this.heard, conversation: this.conversation, voiceMuted: this.voiceMuted, effectsMuted: this.effectsMuted,
      aiDebug: { configured: { ...this.aiConfigured }, runtime: { ...this.aiRuntime }, responses: this.responsesState },
    };
  }

  private emit(): void {
    if (this.disposed) return;
    this.published = this.buildState();
    for (const listener of this.listeners) listener(this.published);
  }
}
