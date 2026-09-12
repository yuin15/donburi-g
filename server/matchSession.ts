import { randomBytes } from 'node:crypto';
import type WebSocket from 'ws';
import { z } from 'zod';
import type { ClientMessage, ServerMessage, SpinView } from '../shared/protocol.js';
import {
  abortMatch,
  advanceMatch,
  createMatch,
  getSnapshot,
  startMatch,
  submitUpgrade,
  type GameEvent,
  type MatchState,
} from '../src/domain/game.js';
import { GptLiveBridge } from './gptLive.js';
import { startAvatarSession, stopAvatarSession, type StartedAvatarSession } from './liveavatar.js';
import { MediaServerLeg } from './mediaServer.js';
import { chooseRivalUpgrade } from './rivalBrain.js';
import { ReactionQueue } from './reactions.js';

const ClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('start') }),
  z.object({
    type: z.literal('upgrade'),
    matchId: z.string().min(1).max(100),
    commandId: z.string().min(1).max(80),
    upgradeId: z.enum(['steady', 'jackpot']),
    offerIndex: z.union([z.literal(0), z.literal(1)]),
  }),
  z.object({ type: z.literal('mic'), audio: z.string().min(1).max(256_000) }),
  z.object({ type: z.literal('voice_close') }),
  z.object({ type: z.literal('snapshot') }),
  z.object({ type: z.literal('close') }),
]);

const MAX_SESSION_MS = 120_000;
const RESULT_REACTION_MS = 8_000;

export class MatchSession {
  private readonly state: MatchState;
  private readonly commands = new Set<string>();
  private streamSeq = 0;
  private lastSpin: { player: SpinView; rival: SpinView } | undefined;
  private messageWindow = 0;
  private messagesInWindow = 0;
  private audioInWindow = 0;
  private reactions = new ReactionQueue(text => {
    if (!this.voiceReady || this.closed) return;
    this.pushContext('発話直前の確定情報');
    this.gpt?.requestReaction(text);
  });
  private warnedTime = false;
  private timer: NodeJS.Timeout | null = null;
  private hardStop: NodeJS.Timeout | null = null;
  private resultStop: NodeJS.Timeout | null = null;
  private startedAt = 0;
  private lastSnapshotAt = 0;
  private avatar: StartedAvatarSession | null = null;
  private media: MediaServerLeg | null = null;
  private gpt: GptLiveBridge | null = null;
  private voiceReady = false;
  private gameReady = false;
  private voiceDisabled = false;
  private readonly voiceAbort = new AbortController();
  private voiceStopping: Promise<void> | null = null;
  private closed = false;
  private initialization: Promise<void> | null = null;
  private stopping: Promise<void> | null = null;
  private recentUserText = '';
  private releaseQuota: (() => Promise<void>) | null;

  constructor(
    private readonly frontend: WebSocket,
    private readonly sessionId: string,
    releaseQuota: () => Promise<void>,
  ) {
    const seed = randomBytes(4).readUInt32BE(0);
    this.state = createMatch(seed, sessionId);
    this.releaseQuota = releaseQuota;
  }

  initialize(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.initialization ??= this.initializeProviders();
    return this.initialization;
  }

  private async initializeProviders(): Promise<void> {
    this.emit({ type: 'hello', live: true, sessionId: this.sessionId });
    this.emit({ type: 'voice_status', status: 'connecting' });
    this.hardStop = setTimeout(() => void this.shutdown('max_duration'), MAX_SESSION_MS);
    try {
      this.avatar = await startAvatarSession();
      if (this.closed) return;
      this.emit({
        type: 'avatar',
        livekitUrl: this.avatar.livekitUrl,
        livekitToken: this.avatar.livekitToken,
      });
      this.media = new MediaServerLeg(this.avatar.mediaWsUrl, () => this.failVoice());
      if (!(await this.media.start())) throw new Error('media_not_ready');
      if (this.closed) return;
      this.gpt = new GptLiveBridge({
        onReady: () => {
          if (this.closed || this.voiceDisabled) return;
          this.voiceReady = true;
          this.gameReady = true;
          this.emit({ type: 'voice_status', status: 'ready' });
        },
        onAudio: (audio) => this.media?.speak(audio),
        onTranscript: (role, delta) => {
          if (this.closed || this.voiceDisabled) return;
          if (role === 'user') this.recentUserText = `${this.recentUserText}${delta}`.slice(-500);
          this.emit({ type: 'transcript', role, delta });
        },
        onUserSpeech: () => this.media?.interrupt(),
        onError: () => this.failVoice(),
        onUsage: (usage) => console.info(JSON.stringify({ event: 'voice_session_usage', ...usage })),
      });
      if (!(await this.gpt.connect())) throw new Error('gpt_not_ready');
      if (this.closed) return;
      this.pushContext('対戦開始前');
    } catch {
      if (this.closed) return;
      this.emit({ type: 'voice_status', status: 'error', message: 'AIキャラクターへ接続できませんでした。' });
      this.emitSafeError('live_connect_failed', '音声・映像を利用できません。CPU対戦を開始できます。', false);
      // Do not await shutdown here: shutdown waits for initialization to settle.
      void this.shutdown('initialize_failed');
    }
  }

  handleRaw(raw: string): void {
    if (this.closed) return;
    if (raw.length > 300_000) { void this.shutdown('message_too_large'); return; }
    const second = Math.floor(Date.now() / 1000);
    if (second !== this.messageWindow) { this.messageWindow = second; this.messagesInWindow = 0; this.audioInWindow = 0; }
    if (++this.messagesInWindow > 120) { void this.shutdown('message_rate_exceeded'); return; }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.emitSafeError('bad_message', '不正なメッセージです。', true);
      return;
    }
    const result = ClientMessageSchema.safeParse(parsed);
    if (!result.success) {
      this.emitSafeError('bad_message', '不正な操作です。', true);
      return;
    }
    this.handle(result.data as ClientMessage);
  }

  shutdown(reason: string): Promise<void> {
    if (this.stopping) return this.stopping;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    if (this.hardStop) clearTimeout(this.hardStop);
    if (this.resultStop) clearTimeout(this.resultStop);
    if (this.state.status !== 'result') abortMatch(this.state);
    const closeVoice = this.stopVoice();
    this.stopping = (async () => {
      await closeVoice;
      if (this.releaseQuota) await this.releaseQuota().catch(() => undefined);
      this.releaseQuota = null;
      this.recentUserText = '';
      this.emit({ type: 'voice_status', status: 'closed', message: reason });
      if (this.frontend.readyState === 1) this.frontend.close(1000, 'session_closed');
    })();
    return this.stopping;
  }

  private failVoice(): void {
    if (this.closed || this.voiceDisabled) return;
    if (!this.gameReady) {
      this.emitSafeError('voice_error', '音声・映像へ接続できません。CPU対戦を開始できます。', false);
      void this.shutdown('voice_error');
      return;
    }
    this.emit({ type: 'voice_status', status: 'error', message: '音声・映像を終了しました。CPUとの対戦は続きます。' });
    void this.stopVoice();
  }

  private stopVoice(): Promise<void> {
    if (this.voiceStopping) return this.voiceStopping;
    this.voiceDisabled = true;
    this.voiceReady = false;
    this.voiceAbort.abort();
    this.reactions.close();
    this.media?.close();
    const closeGpt = this.gpt?.close().catch(() => undefined);
    this.gpt = null;
    this.recentUserText = '';
    this.voiceStopping = (async () => {
      await closeGpt;
      // Startup may still own an in-flight avatar creation request.
      await this.initialization;
      if (this.avatar) await stopAvatarSession(this.avatar.sessionId).catch(() => undefined);
      this.avatar = null;
    })();
    return this.voiceStopping;
  }

  private handle(message: ClientMessage): void {
    if (message.type === 'close') {
      void this.shutdown('client_close');
      return;
    }
    if (message.type === 'snapshot') {
      this.tick();
      this.emitSnapshot();
      return;
    }
    if (message.type === 'mic') {
      this.audioInWindow += message.audio.length;
      if (this.audioInWindow > 192_000) { void this.shutdown('audio_rate_exceeded'); return; }
      if (this.voiceReady) this.gpt?.sendMic(message.audio);
      return;
    }
    if (message.type === 'voice_close') {
      this.failVoice();
      return;
    }
    if (message.type === 'start') {
      this.beginMatch();
      return;
    }
    if (message.type === 'upgrade') {
      if (message.matchId !== this.sessionId) {
        this.emitSafeError('wrong_match', '別の対戦への操作は受付できません。', true);
        return;
      }
      // Arrival time, not the previous interval tick, decides the deadline.
      this.tick();
      if (this.commands.has(message.commandId)) return;
      this.commands.add(message.commandId);
      const accepted = submitUpgrade(
        this.state,
        'player',
        message.offerIndex,
        message.upgradeId,
        this.state.elapsed,
      );
      if (!accepted) this.emitSafeError('upgrade_rejected', 'この改造は受付できませんでした。', true);
    }
  }

  private beginMatch(): void {
    if (!this.gameReady) {
      this.emitSafeError('voice_not_ready', 'AIキャラクターの準備中です。', true);
      return;
    }
    if (this.state.status !== 'ready') return;
    startMatch(this.state);
    this.startedAt = Date.now();
    this.emitSnapshot();
    this.reactions.offer('start', '対戦が今始まる。短く挑発して。', 10, () => this.state.status === 'playing' && this.state.elapsed < 6);
    this.timer = setInterval(() => this.tick(), 100);
  }

  private tick(): void {
    if (this.state.status !== 'playing') return;
    const elapsed = (Date.now() - this.startedAt) / 1000;
    const events = advanceMatch(this.state, elapsed);
    for (const event of events) this.handleGameEvent(event);
    if (!this.warnedTime && this.state.elapsed >= 50 && this.state.status === 'playing') {
      this.warnedTime = true;
      this.reactions.offer('last-ten', '残り10秒を切った。短くラストスパートの一言。', 30, () => this.state.status === 'playing');
    }
    if (Date.now() - this.lastSnapshotAt >= 250) this.emitSnapshot();
  }

  private handleGameEvent(event: GameEvent): void {
    if (event.type === 'spin') {
      this.lastSpin = { player: event.player, rival: event.rival };
      this.emit({ type: 'spin', player: event.player, rival: event.rival });
      if (event.player.payout >= 1200 && event.rival.payout >= 1200) this.react('both_jackpot', '双方が同じ回転で7揃い。確定した得点差を踏まえて短く反応して。', event.player.round);
      else if (event.player.payout >= 1200) this.react('player_jackpot', 'プレイヤーが7揃いの大当たりを出した。驚きか悔しさを一言。', event.player.round);
      else if (event.rival.payout >= 1200) this.react('rival_jackpot', 'あなた自身が7揃いの大当たりを出した。喜びを一言。', event.rival.round);
      return;
    }
    if (event.type === 'leader_change') {
      this.pushContext('首位交代');
      if (event.leader === 'player') this.react('player_leads', 'プレイヤーが首位に立った。短く悔しがって。', Math.floor(event.at / 2));
      if (event.leader === 'rival') this.react('rival_leads', 'あなたが首位に立った。断定的な勝利宣言はせず軽口を一言。', Math.floor(event.at / 2));
      return;
    }
    if (event.type === 'upgrade_open') {
      this.emit({ type: 'upgrade_offer', offerIndex: event.offerIndex, closesAtElapsed: event.closesAt });
      void this.decideRivalUpgrade(event.offerIndex);
      return;
    }
    if (event.type === 'upgrade_applied') {
      this.emit({
        type: 'upgrade_applied',
        offerIndex: event.offerIndex,
        player: event.player,
        rival: event.rival,
      });
      this.pushContext('改造確定');
      this.reactions.offer(`upgrade:${event.offerIndex}`, `改造が確定。プレイヤー=${event.player}、あなた=${event.rival}。自分の作戦を短く言って。`, 40, () => this.state.status === 'playing');
      return;
    }
    if (event.type === 'match_end') {
      this.emitSnapshot();
      this.emit({ type: 'match_ended', snapshot: event.snapshot });
      this.pushContext('試合終了');
      const direction = event.snapshot.winner === 'player'
        ? 'あなたは負けた。試合中の流れを踏まえて短く悔しがって。'
        : event.snapshot.winner === 'rival'
          ? 'あなたは勝った。嫌味になりすぎない勝利コメントを一言。'
          : '引き分け。再戦したくなる一言。';
      this.media?.interrupt();
      this.reactions.offer('result', direction, 100, () => this.state.status === 'result', true);
      if (this.timer) clearInterval(this.timer);
      this.resultStop = setTimeout(() => void this.shutdown('result_complete'), RESULT_REACTION_MS);
    }
  }

  private async decideRivalUpgrade(offerIndex: 0 | 1): Promise<void> {
    const snapshot = getSnapshot(this.state);
    const fallback = { upgradeId: snapshot.scores.rival < snapshot.scores.player ? 'jackpot' as const : 'steady' as const, source: 'fallback' as const };
    const proposed = this.voiceReady
      ? await chooseRivalUpgrade(snapshot, offerIndex, this.recentUserText, this.voiceAbort.signal)
      : fallback;
    if (this.closed) return;
    const choice = this.voiceDisabled ? fallback : proposed;
    // A delayed interval must not extend the model's four-second choice window.
    const arrivedAt = Math.max(this.state.elapsed, (Date.now() - this.startedAt) / 1000);
    const accepted = submitUpgrade(this.state, 'rival', offerIndex, choice.upgradeId, arrivedAt);
    if (accepted) {
      const label = choice.upgradeId === 'jackpot' ? '大勝負' : '安定型';
      this.emit({ type: 'rival_line', text: `作戦を決めた。${label}で行く。`, reason: `upgrade_${choice.source}` });
    }
  }

  private react(reason: string, instruction: string, round: number): void {
    if (round !== this.state.round) return;
    this.pushContext(reason);
    this.reactions.offer(`${reason}:${round}`, instruction, reason.includes('jackpot') ? 80 : 60, () => {
      if (this.state.status !== 'playing' || this.state.round !== round) return false;
      if (reason === 'player_leads') return this.state.scores.player > this.state.scores.rival;
      if (reason === 'rival_leads') return this.state.scores.rival > this.state.scores.player;
      return true;
    });
  }

  private pushContext(reason: string): void {
    const snapshot = getSnapshot(this.state);
    this.gpt?.updateGameContext(
      `ゲーム確定情報(${reason}): 残り${Math.ceil(snapshot.remaining)}秒、プレイヤー${snapshot.scores.player}点、あなた${snapshot.scores.rival}点、プレイヤー改造[${snapshot.upgrades.player.join(',')}],あなた改造[${snapshot.upgrades.rival.join(',')}],状態=${snapshot.status},勝者=${snapshot.winner ?? '未確定'}。`,
    );
  }

  private emitSnapshot(): void {
    this.lastSnapshotAt = Date.now();
    this.emit({ type: 'snapshot', snapshot: getSnapshot(this.state), lastSpin: this.lastSpin });
  }

  private emitSafeError(code: string, message: string, recoverable: boolean): void {
    this.emit({ type: 'error', code, message, recoverable });
  }

  private emit(message: ServerMessage): void {
    if (this.frontend.readyState !== 1) return;
    this.frontend.send(JSON.stringify({ ...message, sessionId: this.sessionId, streamSeq: ++this.streamSeq, serverTime: Date.now() }));
  }
}
