import type { MatchSnapshot, ServerMessage, Side, SpinView } from '../../shared/protocol';
import type { LiveSession } from '../client/LiveSession';
import {
  advanceMatch, createMatch, getSnapshot, MANUAL_SPIN_INTERVAL, PAYOUT, requestManualSpin,
  startMatch, type GameEvent, type MatchState,
} from '../domain/game';
import { RoundPresentation } from './RoundPresentation';
import { RivalReactions } from './RivalReactions';
import type {
  GameCommands, GameExpression, GameMode, GameViewModelDependencies, GameViewState,
} from './GameViewState';

const INITIAL_LINE = '「60秒。私に勝てる？」';
const CPU_MESSAGE = 'クリック / SPACE · 回転中も次の1回を予約';
const DEFAULT_NOTICE = '中央の1ラインで判定 · 60秒の獲得コインで勝負';

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
  private gateMessage = '通常のCPU対戦では外部AIサービスに接続しません。';
  private connecting = false;
  private connectionText = '接続していません';
  private voiceReady = false;
  private gameConnected = false;
  private voiceMuted = false;
  private effectsMuted = false;
  private countdown: GameViewState['countdown'] = null;
  private starting = false;
  private awaitingStart = false;
  private result: MatchSnapshot | null = null;
  private lastSpin: GameViewState['lastSpin'] = null;
  private payout: GameViewState['payout'] = null;
  private cue: GameViewState['cue'] = null;
  private line = INITIAL_LINE;
  private heard = '';
  private assistantText = '';
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
  private practiceTimer: number | undefined;
  private spinQueueTimer: number | undefined;
  private spinRequestTimer: number | undefined;
  private cueTimer: number | undefined;
  private payoutTimers: Partial<Record<Side, number>> = {};
  private assistantTimer: number | undefined;
  private revision = 0;
  private disposed = false;
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
      this.prepareCpu('音声・映像つき対戦を開始できませんでした。CPU対戦を開始できます。');
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
    } catch {
      if (this.isCurrent(current)) this.prepareCpu('音声・映像つき対戦を開始できませんでした。CPU対戦を開始できます。');
    } finally {
      if (this.isCurrent(current)) { this.starting = false; this.emit(); }
    }
  }

  async connectLive(inviteCode: string): Promise<void> {
    if (this.disposed || this.connecting) return;
    const code = inviteCode.trim();
    if (!code) { this.gateMessage = '招待コードを入力してください。'; this.emit(); return; }
    const connected = await this.establishLive(code);
    if (connected === null || !this.isCurrent(connected)) return;
    this.lastInviteCode = code;
    this.gateVisible = false;
    this.emit();
    this.deps.presentation.focus('start');
  }

  requestSpin(): void {
    if (this.disposed || !this.isPlaying()) return;
    if (this.spinPending || this.spinAnimating || this.deps.clock.now() < this.spinNextAt) {
      this.spinQueued = true;
      this.emit();
      this.flushSpinQueue();
    } else this.performManualSpin();
  }

  leave(): void {
    if (this.disposed) return;
    this.cancelBattle();
    this.mode = 'idle';
    this.gateVisible = true;
    this.gateMessage = '退出しました。マイクとAIの接続を終了しました。';
    this.lastInviteCode = '';
    this.emit();
    this.deps.presentation.focus('gate');
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
    this.cueTimer = this.assistantTimer = undefined;
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
    this.voiceReady = false;
    this.gameConnected = false;
    this.connecting = false;
    this.starting = false;
    this.awaitingStart = false;
    this.countdown = null;
    this.payout = null;
    this.cue = null;
    this.assistantText = '';
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
    this.liveReelUpgrades = { player: [], rival: [] };
    this.result = null;
    this.lastSpin = null;
    this.payout = null;
    this.cue = null;
    this.line = INITIAL_LINE;
    this.heard = this.assistantText = '';
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
    this.emit();
    this.deps.presentation.focus('start');
    const tick = () => {
      if (!this.practiceState || this.practiceState.status !== 'playing') return;
      this.processPracticeEvents(advanceMatch(this.practiceState, this.practiceElapsed()));
      this.consumeSnapshot(getSnapshot(this.practiceState));
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

  private consumeSnapshot(snapshot: MatchSnapshot): void {
    this.snapshot = snapshot;
    if (snapshot.status === 'playing' || snapshot.status === 'result' || snapshot.status === 'aborted') this.awaitingStart = false;
    if (snapshot.status === 'playing') {
      if (!this.warnedTime && snapshot.remaining <= 10) { this.warnedTime = true; this.announce('残り10秒！ 最後まで勝負', 'warning'); }
    }
    if (snapshot.status === 'result' || snapshot.status === 'aborted') this.clearSpinInput();
  }

  private clearSpinInput(): void {
    this.cancelTimer(this.spinQueueTimer);
    this.cancelTimer(this.spinRequestTimer);
    this.spinQueueTimer = this.spinRequestTimer = undefined;
    this.spinQueued = this.spinPending = this.spinAnimating = false;
    this.spinNextAt = 0;
    this.spinRequestId = undefined;
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
    if (this.rounds.spin(confirmed) && spin.side === 'player') {
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
    const scores = this.rounds.scores;
    const leader = scores.player > scores.rival ? 'player' : scores.player < scores.rival ? 'rival' : null;
    const comeback = leader && this.previousLeader && leader !== this.previousLeader;
    if (leader) this.previousLeader = leader;
    const stale = !celebrate || !this.deps.isVisible() || this.snapshot.rounds[side] > spin.round;
    this.clearPayout(side);
    if (!stale) {
      if (spin.payout) {
        this.payout = { player: 0, rival: 0, ...this.payout, [side]: spin.payout };
        this.payoutTimers[side] = this.schedule(() => { this.clearPayout(side); this.emit(); }, spin.payout >= PAYOUT.seven ? 1200 : 650);
      }
      if (this.cue?.kind !== 'warning') { this.cancelTimer(this.cueTimer); this.cue = null; }
      this.reactionUntil = this.deps.clock.now() + 1600;
      const reaction = this.rivalReactions.nextSpin(spin, scores, this.snapshot.remaining, comeback ? leader : null);
      this.expression = reaction.expression;
      if (!this.voiceReady) this.line = `「${reaction.text}」`;
      if (side === 'player' && spin.payout >= PAYOUT.seven) this.announce(comeback && leader === 'player' ? '逆転！' : '7揃い！', 'jackpot');
      else if (comeback) this.announce(leader === 'player' ? '逆転！' : 'ライバルが逆転！', 'lead');
      else if (spin.payout) this.deps.presentation.playSound(side === 'player' ? 'win' : 'rivalWin');
    }
    this.emit();
    if (side === 'player') this.flushSpinQueue();
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
    this.result = snapshot;
    this.clearPayout('player');
    this.clearPayout('rival');
    this.cancelTimer(this.cueTimer);
    this.payout = this.cue = null;
    this.expression = snapshot.winner === 'player' ? 'frustrated' : snapshot.winner === 'rival' ? 'confident' : 'neutral';
    this.reactionUntil = Infinity;
    if (!this.voiceReady) this.showResultLine(snapshot);
    this.emit();
    this.deps.presentation.stopScene();
    this.deps.presentation.celebrateResult(snapshot.winner ?? 'draw');
    this.deps.presentation.playSound('result');
    this.deps.presentation.focus('start');
  }

  private showResultLine(snapshot: MatchSnapshot): void {
    this.line = snapshot.winner === 'player' ? '「……負けた。もう一回！」' : snapshot.winner === 'rival' ? '「私の勝ち。再戦する？」' : '「引き分け？ 次で決めよう。」';
  }

  private prepareLiveResult(snapshot: MatchSnapshot): void {
    if (snapshot.status !== 'result' || (this.liveSnapshot?.status === 'result' && this.liveSnapshot.matchId === snapshot.matchId)) return;
    this.cancelTimer(this.assistantTimer);
    this.assistantText = this.heard = '';
    if (this.voiceReady) { this.line = '「……」'; this.connectionText = 'マイク停止 / 結果の反応を待っています'; }
  }

  private async establishLive(code: string): Promise<number | null> {
    this.cancelBattle();
    const current = this.revision;
    this.mode = 'live';
    this.resetBattle();
    this.connecting = true;
    this.connectionText = 'マイク許可を確認中…';
    this.gateMessage = 'マイク許可 → AIキャラクター接続の順に準備します…';
    this.emit();
    let session: LiveSession | undefined;
    try {
      session = await this.deps.liveFactory({
        message: message => { if (this.isCurrent(current) && session && this.liveSession === session) this.onLiveMessage(message); },
        disconnect: () => { if (this.isCurrent(current) && session && this.liveSession === session) this.onLiveDisconnect(); },
      });
      if (!this.isCurrent(current)) { await session.disconnect(); return null; }
      this.liveSession = session;
      session.setMuted(this.voiceMuted);
      await session.connect(code);
      if (!this.isCurrent(current) || this.liveSession !== session) return null;
      this.connecting = false;
      this.emit();
      return current;
    } catch {
      if (this.isCurrent(current)) this.prepareCpu('音声・映像を利用できないため、CPU対戦を準備しました。開始ボタンで遊べます。');
      return null;
    }
  }

  private onLiveDisconnect(): void {
    this.voiceReady = false;
    if (this.liveSnapshot?.status === 'result') {
      this.connectionText = '会話接続終了 / 再戦できます';
      this.liveSession = null;
      this.emit();
    } else if (!this.liveSnapshot || this.liveSnapshot.status === 'ready') {
      this.prepareCpu('音声・映像の接続が終了しました。CPU対戦を開始できます。');
    } else this.returnToGate('対戦サーバーとの接続が終了しました。通常のCPU対戦を始められます。');
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
    if (message.type === 'spin_status') {
      if (message.commandId !== this.spinRequestId) return;
      if (!message.accepted) {
        this.cancelTimer(this.spinRequestTimer);
        this.spinRequestId = undefined;
        this.spinPending = false;
        this.spinQueued = message.retryAfterMs > 0 && this.isPlaying();
        this.spinNextAt = this.deps.clock.now() + message.retryAfterMs + 10;
        this.flushSpinQueue();
      }
    } else if (message.type === 'voice_status') {
      this.connectionText = message.status === 'ready' ? 'マイク接続中 / AI会話 READY' : message.status === 'connecting' ? 'AIキャラクター接続中…' : message.status === 'closed' ? '会話接続終了' : message.message ?? '会話エラー';
      this.voiceReady = message.status === 'ready';
      if (this.voiceReady) this.gameConnected = true;
      if (!this.voiceReady && this.gameConnected) {
        this.heard = this.assistantText = '';
        this.cancelTimer(this.assistantTimer);
        if (this.liveSnapshot?.status === 'result' && (message.status === 'error' || this.line === '「……」')) this.showResultLine(this.liveSnapshot);
      }
    } else if (message.type === 'snapshot') {
      const enteringPlay = this.liveSnapshot?.status !== 'playing' && message.snapshot.status === 'playing';
      this.prepareLiveResult(message.snapshot);
      this.liveSnapshot = message.snapshot;
      this.liveReelUpgrades = { player: [...message.snapshot.upgrades.player], rival: [...message.snapshot.upgrades.rival] };
      const last = message.lastSpins ?? message.lastSpin;
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
      if (!this.voiceReady) this.line = `「${message.text}」`;
    } else if (message.type === 'transcript') {
      if (message.role === 'user') this.heard = `あなた: ${message.delta}`;
      else {
        this.cancelTimer(this.assistantTimer);
        this.assistantText = `${this.assistantText}${message.delta}`.slice(-120);
        this.line = `「${this.assistantText}」`;
        if (this.liveSnapshot?.status === 'result') this.connectionText = 'マイク停止 / 結果のひとこと';
        this.assistantTimer = this.schedule(() => { this.assistantText = ''; }, 2500);
      }
    } else if (message.type === 'match_ended') {
      this.prepareLiveResult(message.snapshot);
      this.liveSnapshot = message.snapshot;
      this.consumeSnapshot(message.snapshot);
      this.rounds.end(message.snapshot);
    } else if (message.type === 'error') {
      this.connectionText = message.message;
      if (!message.recoverable) {
        if (!this.liveSnapshot || this.liveSnapshot.status === 'ready') this.prepareCpu('音声・映像を利用できないため、CPU対戦を準備しました。');
        else this.returnToGate(`${message.message} 通常のCPU対戦を始められます。`);
      }
    }
    this.emit();
  }

  private buildState(): GameViewState {
    const now = this.deps.clock.now();
    const scores = { ...this.rounds.scores };
    const gap = scores.player - scores.rival;
    const playing = this.isPlaying();
    const busy = this.spinPending || this.spinAnimating || now < this.spinNextAt;
    const spinState = playing ? this.spinQueued ? 'queued' : busy ? 'spinning' : 'ready' : null;
    const hint = playing ? this.spinQueued ? '次の1回を予約しました' : busy ? 'もう一度押すと、次を予約' : 'クリック / SPACE で回す' : this.snapshot.status === 'result' ? `あなた ${this.snapshot.rounds.player}回転 · ライバル ${this.snapshot.rounds.rival}回転` : 'クリック / SPACE で回す';
    const finalStopping = this.snapshot.status === 'result' && !this.result;
    const disabled = playing ? false : this.mode === 'idle' || this.connecting || this.starting || this.awaitingStart || finalStopping || (this.mode === 'live' && !this.gameConnected);
    const label = playing ? this.spinQueued ? '予約済み' : busy ? '次も回す' : '回す' : finalStopping ? '最終停止中' : this.result ? '再戦する' : this.connecting || this.starting || this.awaitingStart ? '準備中' : '勝負する';
    return {
      mode: this.mode, snapshot: structuredClone(this.snapshot), scores, lastSpin: this.lastSpin ? structuredClone(this.lastSpin) : null,
      gate: { visible: this.gateVisible, message: this.gateMessage, connecting: this.connecting },
      connection: { text: this.connectionText, voiceReady: this.voiceReady, showVoiceControls: this.mode === 'live' && (!this.gameConnected || this.voiceReady) },
      modeBadge: { text: this.mode === 'idle' ? '未接続' : this.voiceReady ? 'LIVE AI' : 'CPU対戦', tone: this.mode === 'idle' ? 'idle' : this.voiceReady ? 'live' : 'practice' },
      countdown: this.countdown, startControl: { disabled, label, spinState, hint },
      machineNotice: DEFAULT_NOTICE,
      result: this.result ? structuredClone(this.result) : null, payout: this.payout ? { ...this.payout } : null, cue: this.cue ? { ...this.cue } : null,
      expression: now >= this.reactionUntil ? gap > 0 ? 'frustrated' : gap < 0 ? 'confident' : 'neutral' : this.expression,
      rivalMood: this.snapshot.status === 'result' ? gap > 0 ? '次こそ、負けない。' : gap < 0 ? 'もう一度、挑む？' : '決着は、次の勝負で。' : gap > 0 ? 'ここから、巻き返す。' : gap < 0 ? 'このまま、逃げきる。' : '正々堂々、60秒。',
      line: this.line, heard: this.heard, voiceMuted: this.voiceMuted, effectsMuted: this.effectsMuted,
    };
  }

  private emit(): void {
    if (this.disposed) return;
    this.published = this.buildState();
    for (const listener of this.listeners) listener(this.published);
  }
}
