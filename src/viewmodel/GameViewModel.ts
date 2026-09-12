import type { MatchSnapshot, ServerMessage, Side, SpinView, UpgradeId } from '../../shared/protocol';
import type { LiveSession } from '../client/LiveSession';
import {
  advanceMatch, createMatch, getSnapshot, MANUAL_SPIN_INTERVAL, PAYOUT, requestManualSpin,
  SPIN_INTERVAL, startMatch, submitUpgrade, UPGRADE_CLOSE_SECONDS, UPGRADE_DEFINITIONS,
  UPGRADE_OPEN_SECONDS, type GameEvent, type MatchState,
} from '../domain/game';
import { describeUpgrade } from '../domain/upgradePreview';
import { RoundPresentation } from './RoundPresentation';
import { RivalReactions } from './RivalReactions';
import type {
  GameCommands, GameExpression, GameMode, GameViewModelDependencies, GameViewState, RoundPair,
} from './GameViewState';

const INITIAL_LINE = '「60秒。私に勝てる？」';
const CPU_MESSAGE = 'クリック / SPACE で回す · 改造チャンスは20秒・40秒';
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
  private activeOffer: { index: 0 | 1; closesAt: number } | null = null;
  private playerChoices: Partial<Record<0 | 1, UpgradeId>> = {};
  private upgradeReceipt = '';
  private upgradeReceiptUntil = 0;
  private result: MatchSnapshot | null = null;
  private lastSpin: RoundPair | null = null;
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
  private commandSequence = 0;
  private practiceTimer: number | undefined;
  private spinQueueTimer: number | undefined;
  private spinRequestTimer: number | undefined;
  private cueTimer: number | undefined;
  private payoutTimer: number | undefined;
  private assistantTimer: number | undefined;
  private revision = 0;
  private disposed = false;
  private readonly timers = new Set<number>();
  private readonly waits = new Map<number, (valid: boolean) => void>();
  private readonly listeners = new Set<(state: GameViewState) => void>();
  private published: GameViewState;

  constructor(private readonly deps: GameViewModelDependencies) {
    this.rounds = new RoundPresentation({
      play: (player, rival, stopped) => deps.presentation.playRound(player, rival, stopped),
      settled: (player, rival, celebrate) => this.revealRound(player, rival, celebrate),
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

  chooseUpgrade(choice: UpgradeId): void {
    const offer = this.activeOffer;
    if (this.disposed || !offer || this.playerChoices[offer.index]) return;
    if (this.mode === 'practice' && this.practiceState) {
      if (!submitUpgrade(this.practiceState, 'player', offer.index, choice, this.practiceElapsed())) return;
    } else if (this.mode === 'live') {
      this.liveSession?.send({ type: 'upgrade', commandId: `${this.revision}-${++this.commandSequence}`, upgradeId: choice, offerIndex: offer.index, matchId: this.snapshot.matchId });
    } else return;
    this.playerChoices[offer.index] = choice;
    this.deps.presentation.playSound('choose');
    this.emit();
    this.deps.presentation.focus('start');
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
    this.cueTimer = this.payoutTimer = this.assistantTimer = undefined;
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
    this.activeOffer = null;
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
    this.playerChoices = {};
    this.upgradeReceiptUntil = 0;
    this.activeOffer = null;
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
    const newest = events.filter(event => event.type === 'spin').at(-1);
    for (const event of events) {
      if (event.type === 'spin' && event === newest) this.handleSpin(event.player, event.rival, this.practiceState?.upgrades);
      if (event.type === 'upgrade_open' && (this.practiceState?.elapsed ?? 60) < event.closesAt) {
        this.openUpgrade(event.offerIndex, event.closesAt);
        this.schedule(() => {
          if (!this.practiceState || this.practiceState.status !== 'playing') return;
          const pick: UpgradeId = this.practiceState.scores.rival < this.practiceState.scores.player || this.deps.random() > 0.5 ? 'jackpot' : 'steady';
          submitUpgrade(this.practiceState, 'rival', event.offerIndex, pick, this.practiceElapsed());
        }, 700);
      }
      if (event.type === 'upgrade_applied') {
        this.confirmUpgrade(event.offerIndex, event.player);
        this.line = event.rival === 'jackpot' ? '「ここから大勝負で行く。」' : '「崩さず取りに行く。」';
      }
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
    if (this.activeOffer && snapshot.elapsed >= this.activeOffer.closesAt) this.activeOffer = null;
    if (snapshot.status === 'playing') {
      if (!this.warnedTime && snapshot.remaining <= 10) { this.warnedTime = true; this.announce('残り10秒！ 最後まで勝負', 'warning'); }
      const index = UPGRADE_OPEN_SECONDS.findIndex((at, index) => snapshot.elapsed >= at && snapshot.elapsed < UPGRADE_CLOSE_SECONDS[index]);
      if (index >= 0 && !this.activeOffer) this.openUpgrade(index as 0 | 1, UPGRADE_CLOSE_SECONDS[index]);
    }
    if (snapshot.status === 'result' || snapshot.status === 'aborted') { this.activeOffer = null; this.clearSpinInput(); }
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

  private handleSpin(player: SpinView, rival: SpinView, upgrades = this.snapshot.upgrades): void {
    const applied = UPGRADE_CLOSE_SECONDS.filter(at => at < player.round * SPIN_INTERVAL).length;
    const p = { ...player, upgrades: [...(player.upgrades ?? upgrades.player.slice(0, applied))] };
    const r = { ...rival, upgrades: [...(rival.upgrades ?? upgrades.rival.slice(0, applied))] };
    if (this.rounds.spin(p, r)) {
      this.spinAnimating = true;
      this.spinPending = false;
      this.spinRequestId = undefined;
      this.cancelTimer(this.spinRequestTimer);
      this.spinRequestTimer = undefined;
      this.deps.presentation.playSound('spin');
    }
  }

  private revealRound(player: SpinView, rival: SpinView, celebrate: boolean): void {
    this.spinAnimating = false;
    this.lastSpin = { player, rival };
    const leader = player.total > rival.total ? 'player' : player.total < rival.total ? 'rival' : null;
    const comeback = leader && this.previousLeader && leader !== this.previousLeader;
    if (leader) this.previousLeader = leader;
    const stale = !celebrate || !this.deps.isVisible() || this.snapshot.round > player.round;
    this.cancelTimer(this.payoutTimer);
    this.payout = null;
    if (!stale) {
      this.payout = { player: player.payout, rival: rival.payout };
      if (player.payout || rival.payout) this.payoutTimer = this.schedule(() => { this.payout = null; this.emit(); }, Math.max(player.payout, rival.payout) >= PAYOUT.seven ? 1200 : 650);
      if (this.cue?.kind !== 'warning') { this.cancelTimer(this.cueTimer); this.cue = null; }
      this.reactionUntil = this.deps.clock.now() + 1600;
      const reaction = this.rivalReactions.next(player, rival, this.snapshot.remaining, comeback ? leader : null);
      this.expression = reaction.expression;
      if (!this.voiceReady) this.line = `「${reaction.text}」`;
      if (player.payout >= PAYOUT.seven) this.announce(comeback && leader === 'player' ? '逆転！' : '7揃い！', 'jackpot');
      else if (comeback) this.announce(leader === 'player' ? '逆転！' : 'ライバルが逆転！', 'lead');
      else if (player.payout) this.deps.presentation.playSound('win');
      else if (rival.payout) this.deps.presentation.playSound('rivalWin');
    }
    this.emit();
    this.flushSpinQueue();
  }

  private announce(text: string, kind: 'lead' | 'warning' | 'jackpot'): void {
    this.cancelTimer(this.cueTimer);
    this.cue = { text, kind };
    this.deps.presentation.playSound(kind);
    this.cueTimer = this.schedule(() => { this.cue = null; this.emit(); }, 1800);
  }

  private openUpgrade(index: 0 | 1, closesAt: number): void {
    if (this.activeOffer?.index === index) return;
    this.activeOffer = { index, closesAt };
    this.deps.presentation.playSound('choose');
  }

  private confirmUpgrade(index: 0 | 1, applied: UpgradeId): void {
    this.upgradeReceipt = this.playerChoices[index] === undefined
      ? `改造${index + 1}: 未選択のため${UPGRADE_DEFINITIONS[applied].label}を適用 · 次の回転から有効`
      : `改造${index + 1}: ${UPGRADE_DEFINITIONS[applied].label}を適用 · 次の回転から有効`;
    this.upgradeReceiptUntil = this.deps.clock.now() + 3500;
    this.activeOffer = null;
  }

  private finishPresentation(snapshot: MatchSnapshot): void {
    this.consumeSnapshot(snapshot);
    this.result = snapshot;
    this.activeOffer = null;
    this.cancelTimer(this.payoutTimer);
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
      if (message.lastSpin) this.handleSpin(message.lastSpin.player, message.lastSpin.rival, message.snapshot.upgrades);
      this.consumeSnapshot(message.snapshot);
      if (message.snapshot.status === 'playing') this.awaitingStart = false;
      if (message.snapshot.status === 'result') this.rounds.end(message.snapshot);
      if (enteringPlay) { this.emit(); this.deps.presentation.focus('start'); }
    } else if (message.type === 'spin') {
      this.handleSpin(message.player, message.rival, this.liveReelUpgrades);
    } else if (message.type === 'upgrade_offer') {
      this.openUpgrade(message.offerIndex, message.closesAtElapsed);
    } else if (message.type === 'upgrade_applied') {
      this.liveReelUpgrades.player[message.offerIndex] = message.player;
      this.liveReelUpgrades.rival[message.offerIndex] = message.rival;
      this.confirmUpgrade(message.offerIndex, message.player);
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
    const hint = playing ? this.spinQueued ? '次の1回を予約しました' : busy ? 'もう一度押すと、次を予約' : 'クリック / SPACE · 両者が1回転' : this.snapshot.status === 'result' ? `${this.snapshot.round}回転の勝負` : 'クリック / SPACE で回す';
    const finalStopping = this.snapshot.status === 'result' && !this.result;
    const disabled = playing ? false : this.mode === 'idle' || this.connecting || this.starting || this.awaitingStart || finalStopping || (this.mode === 'live' && !this.gameConnected);
    const label = playing ? this.spinQueued ? '予約済み' : busy ? '次も回す' : '回す' : finalStopping ? '最終停止中' : this.result ? '再戦する' : this.connecting || this.starting || this.awaitingStart ? '準備中' : '勝負する';
    const preview = this.snapshot.status === 'playing' && !this.activeOffer ? UPGRADE_OPEN_SECONDS.findIndex(at => this.snapshot.elapsed >= at - 5 && this.snapshot.elapsed < at) : -1;
    const index = this.activeOffer?.index ?? (preview >= 0 ? preview as 0 | 1 : null);
    let upgrade: GameViewState['upgrade'] = null;
    if (index !== null) {
      const open = this.activeOffer !== null;
      const remainingSeconds = Math.max(0, (open ? UPGRADE_CLOSE_SECONDS[index] : UPGRADE_OPEN_SECONDS[index]) - this.snapshot.elapsed);
      const choice = this.playerChoices[index] ?? null;
      upgrade = {
        phase: open ? 'open' : 'preview', index, remainingSeconds, progress: Math.min(1, remainingSeconds / (open ? 4 : 5)), choice,
        choiceText: !open ? '見比べよう。受付後に選べます' : choice ? `選択済み: ${UPGRADE_DEFINITIONS[choice].label}` : 'クリック / キー 1・2 で選択',
        options: { steady: describeUpgrade(this.snapshot.upgrades.player, 'steady'), jackpot: describeUpgrade(this.snapshot.upgrades.player, 'jackpot') },
      };
    }
    let rivalUpgradeNotice = '';
    if (this.snapshot.status === 'playing') {
      const choosing = UPGRADE_OPEN_SECONDS.some((open, index) => this.snapshot.elapsed >= open && this.snapshot.elapsed < UPGRADE_CLOSE_SECONDS[index]);
      const applied = this.snapshot.upgrades.rival;
      const since = this.snapshot.elapsed - UPGRADE_CLOSE_SECONDS[applied.length - 1];
      if (choosing) rivalUpgradeNotice = '⚙ リール改造中';
      else if (applied.length && since >= 0 && since < 3.5) {
        const definition = UPGRADE_DEFINITIONS[applied[applied.length - 1]];
        rivalUpgradeNotice = `${definition.addedSymbol === 'cherry' ? 'チェリー' : '7'} +${definition.addedCount} · ${definition.label}`;
      }
    }
    return {
      mode: this.mode, snapshot: structuredClone(this.snapshot), scores, lastSpin: this.lastSpin ? structuredClone(this.lastSpin) : null,
      gate: { visible: this.gateVisible, message: this.gateMessage, connecting: this.connecting },
      connection: { text: this.connectionText, voiceReady: this.voiceReady, showVoiceControls: this.mode === 'live' && (!this.gameConnected || this.voiceReady) },
      modeBadge: { text: this.mode === 'idle' ? '未接続' : this.voiceReady ? 'LIVE AI' : 'CPU対戦', tone: this.mode === 'idle' ? 'idle' : this.voiceReady ? 'live' : 'practice' },
      countdown: this.countdown, startControl: { disabled, label, spinState, hint }, upgrade,
      upgradeProgress: this.snapshot.status === 'playing' ? this.activeOffer ? '改造を選ぼう！' : this.snapshot.elapsed < 20 ? `改造まで ${Math.ceil(20 - this.snapshot.elapsed)}秒` : this.snapshot.elapsed < 40 ? `次の改造まで ${Math.ceil(40 - this.snapshot.elapsed)}秒` : '改造完了・ラストスパート' : this.snapshot.status === 'result' ? '次は、どの作戦でいく？' : '改造チャンス 20秒・40秒',
      rivalUpgradeNotice, machineNotice: now < this.upgradeReceiptUntil ? this.upgradeReceipt : DEFAULT_NOTICE,
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
