import { randomBytes } from 'node:crypto';
import type WebSocket from 'ws';
import { z } from 'zod';
import type { ClientMessage, ServerMessage } from '../shared/protocol.js';
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

const ClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('start') }),
  z.object({
    type: z.literal('upgrade'),
    commandId: z.string().min(1).max(80),
    upgradeId: z.enum(['steady', 'jackpot']),
    offerIndex: z.union([z.literal(0), z.literal(1)]),
  }),
  z.object({ type: z.literal('mic'), audio: z.string().min(1).max(256_000) }),
  z.object({ type: z.literal('snapshot') }),
  z.object({ type: z.literal('close') }),
]);

const MAX_SESSION_MS = 120_000;
const RESULT_REACTION_MS = 8_000;

export class MatchSession {
  private readonly state: MatchState;
  private readonly commands = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private hardStop: NodeJS.Timeout | null = null;
  private resultStop: NodeJS.Timeout | null = null;
  private startedAt = 0;
  private lastSnapshotAt = 0;
  private avatar: StartedAvatarSession | null = null;
  private media: MediaServerLeg | null = null;
  private gpt: GptLiveBridge | null = null;
  private voiceReady = false;
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
          if (this.closed) return;
          this.voiceReady = true;
          this.emit({ type: 'voice_status', status: 'ready' });
        },
        onAudio: (audio) => this.media?.speak(audio),
        onTranscript: (role, delta) => {
          if (this.closed) return;
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
      this.emitSafeError('live_connect_failed', 'AIキャラクターへ接続できませんでした。練習モードを利用してください。', false);
      // Do not await shutdown here: shutdown waits for initialization to settle.
      void this.shutdown('initialize_failed');
    }
  }

  handleRaw(raw: string): void {
    if (this.closed || raw.length > 300_000) return;
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
    this.voiceReady = false;
    this.media?.close();
    const closeGpt = this.gpt?.close().catch(() => undefined);
    this.stopping = (async () => {
      await closeGpt;
      // A provider can finish creating a session after the browser leaves.
      // Wait for ownership of that session before releasing the quota lease.
      await this.initialization;
      if (this.avatar) await stopAvatarSession(this.avatar.sessionId).catch(() => undefined);
      this.avatar = null;
      if (this.releaseQuota) await this.releaseQuota().catch(() => undefined);
      this.releaseQuota = null;
      this.recentUserText = '';
      this.emit({ type: 'voice_status', status: 'closed', message: reason });
      if (this.frontend.readyState === 1) this.frontend.close(1000, 'session_closed');
    })();
    return this.stopping;
  }

  private failVoice(): void {
    if (this.closed) return;
    this.emitSafeError('voice_error', '会話接続が切れたため対戦を終了しました。もう一度接続してください。', false);
    void this.shutdown('voice_error');
  }

  private handle(message: ClientMessage): void {
    if (message.type === 'close') {
      void this.shutdown('client_close');
      return;
    }
    if (message.type === 'snapshot') {
      this.emitSnapshot();
      return;
    }
    if (message.type === 'mic') {
      this.gpt?.sendMic(message.audio);
      return;
    }
    if (message.type === 'start') {
      this.beginMatch();
      return;
    }
    if (message.type === 'upgrade') {
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
    if (!this.voiceReady) {
      this.emitSafeError('voice_not_ready', 'AIキャラクターの準備中です。', true);
      return;
    }
    if (this.state.status !== 'ready') return;
    startMatch(this.state);
    this.startedAt = Date.now();
    this.emitSnapshot();
    this.gpt?.requestReaction('対戦が今始まる。短く挑発して。');
    this.timer = setInterval(() => this.tick(), 100);
  }

  private tick(): void {
    if (this.state.status !== 'playing') return;
    const elapsed = (Date.now() - this.startedAt) / 1000;
    const events = advanceMatch(this.state, elapsed);
    for (const event of events) this.handleGameEvent(event);
    if (Date.now() - this.lastSnapshotAt >= 250) this.emitSnapshot();
  }

  private handleGameEvent(event: GameEvent): void {
    if (event.type === 'spin') {
      this.emit({ type: 'spin', player: event.player, rival: event.rival });
      if (event.player.payout >= 1200) this.react('player_jackpot', 'プレイヤーが7揃いの大当たりを出した。驚きか悔しさを一言。');
      if (event.rival.payout >= 1200) this.react('rival_jackpot', 'あなた自身が7揃いの大当たりを出した。喜びを一言。');
      return;
    }
    if (event.type === 'leader_change') {
      this.pushContext('首位交代');
      if (event.leader === 'player') this.react('player_leads', 'プレイヤーが首位に立った。短く悔しがって。');
      if (event.leader === 'rival') this.react('rival_leads', 'あなたが首位に立った。断定的な勝利宣言はせず軽口を一言。');
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
      this.gpt?.requestReaction(`改造が確定。プレイヤー=${event.player}、あなた=${event.rival}。自分の作戦を短く言って。`);
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
      this.gpt?.requestReaction(direction);
      if (this.timer) clearInterval(this.timer);
      this.resultStop = setTimeout(() => void this.shutdown('result_complete'), RESULT_REACTION_MS);
    }
  }

  private async decideRivalUpgrade(offerIndex: 0 | 1): Promise<void> {
    const snapshot = getSnapshot(this.state);
    const choice = await chooseRivalUpgrade(snapshot, offerIndex, this.recentUserText);
    const accepted = submitUpgrade(this.state, 'rival', offerIndex, choice.upgradeId, this.state.elapsed);
    if (accepted) {
      const label = choice.upgradeId === 'jackpot' ? '大勝負' : '安定型';
      this.emit({ type: 'rival_line', text: `作戦を決めた。${label}で行く。`, reason: `upgrade_${choice.source}` });
    }
  }

  private react(reason: string, instruction: string): void {
    this.pushContext(reason);
    this.gpt?.requestReaction(instruction);
  }

  private pushContext(reason: string): void {
    const snapshot = getSnapshot(this.state);
    this.gpt?.updateGameContext(
      `ゲーム確定情報(${reason}): 残り${Math.ceil(snapshot.remaining)}秒、プレイヤー${snapshot.scores.player}点、あなた${snapshot.scores.rival}点、プレイヤー改造[${snapshot.upgrades.player.join(',')}],あなた改造[${snapshot.upgrades.rival.join(',')}],状態=${snapshot.status},勝者=${snapshot.winner ?? '未確定'}。`,
    );
  }

  private emitSnapshot(): void {
    this.lastSnapshotAt = Date.now();
    this.emit({ type: 'snapshot', snapshot: getSnapshot(this.state) });
  }

  private emitSafeError(code: string, message: string, recoverable: boolean): void {
    this.emit({ type: 'error', code, message, recoverable });
  }

  private emit(message: ServerMessage): void {
    if (this.frontend.readyState !== 1) return;
    this.frontend.send(JSON.stringify(message));
  }
}
