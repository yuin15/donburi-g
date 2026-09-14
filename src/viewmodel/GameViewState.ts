import type { Bet, MatchSnapshot, Side, SpinView, UpgradeId } from '../../shared/protocol';
import type { LiveSessionFactory } from '../client/LiveSession';
import type { AiConnectionState } from '../client/AiStatus';
import type { RivalExpression } from './RivalExpressions';

export type GameMode = 'idle' | 'practice' | 'live';
export type GameExpression = RivalExpression;
export type GameSound = 'spin' | 'choose' | 'win' | 'rivalWin' | 'jackpot' | 'lead' | 'warning' | 'ruleChange' | 'result' | 'bellWin' | 'victory' | 'defeat' | 'draw';
export type RoundPair = { player: SpinView; rival: SpinView };
export type TextChoice = {
  readonly token: number;
  /** Absolute client-clock deadline. Commands reject it even if a timer is delayed. */
  readonly expiresAt: number;
  readonly kind: 'borrow' | 'lend' | 'extend';
  readonly question: string;
  readonly detail: string;
  readonly acceptLabel: string;
  readonly declineLabel: string;
};

export interface GameViewState {
  readonly mode: GameMode;
  readonly snapshot: MatchSnapshot;
  readonly scores: Readonly<Record<Side, number>>;
  readonly balances: Readonly<Record<Side, number>>;
  readonly bets: Readonly<Record<Side, Bet>>;
  readonly lastSpin: Partial<Record<Side, SpinView>> | null;
  readonly gate: { readonly visible: boolean; readonly message: string; readonly connecting: boolean };
  readonly connection: { readonly text: string; readonly voiceReady: boolean; readonly showVideo: boolean; readonly showVoiceControls: boolean };
  readonly modeBadge: { readonly text: string; readonly tone: 'idle' | 'practice' | 'live' };
  readonly countdown: 3 | 2 | 1 | 'GO!' | null;
  readonly startControl: {
    readonly disabled: boolean;
    readonly label: string;
    readonly spinState: 'ready' | 'spinning' | 'queued' | null;
    readonly hint: string;
  };
  readonly machineNotice: string;
  readonly result: MatchSnapshot | null;
  readonly sessionRecord: { readonly best: number; readonly streak: number; readonly newBest: boolean };
  readonly payout: Readonly<Record<Side, number>> | null;
  readonly cue: { readonly text: string; readonly kind: 'lead' | 'warning' | 'jackpot' } | null;
  /** A short client-only hold; the server match clock continues underneath it. */
  readonly timeExtension: { readonly decision: 'accepted' | 'rejected'; readonly before: number; readonly after: number } | null;
  /** A confirmed server-side transfer; it is presentation only, never a control. */
  readonly loanTransfer: { readonly direction: 'rival_to_player' | 'player_to_rival'; readonly amount: 5 } | null;
  /** A short, local CPU-only decision card. Live negotiations remain voice-only. */
  readonly textChoice: TextChoice | null;
  /** The server temporarily skipped rival turns; player input and the clock continue. */
  readonly rivalDistraction: { readonly active: boolean; readonly seconds: 2 | 4 } | null;
  readonly expression: GameExpression;
  readonly rivalMood: string;
  readonly line: string;
  readonly heard: string;
  readonly conversation: 'idle' | 'listening' | 'replying';
  readonly microphone: { readonly visible: boolean; readonly active: boolean; readonly muted: boolean; readonly level: number };
  readonly voiceMuted: boolean;
  readonly effectsMuted: boolean;
  readonly aiDebug: {
    readonly configured: Readonly<Record<'gptLive' | 'responses' | 'liveAvatar' | 'liveKit', boolean>>;
    readonly runtime: Readonly<Record<'gptLive' | 'liveAvatar' | 'liveKit', AiConnectionState>>;
    readonly responses: AiConnectionState;
  };
}

/** One-shot presentation calls. State subscriptions must not replay these effects. */
export interface GamePresentation {
  playSpin(spin: SpinView, stopped: (celebrate?: boolean) => void): void;
  resetScene(): void;
  stopScene(): void;
  /** Publish the result UI in ready, immediately before the result effects begin. */
  celebrateResult(winner: Side | 'draw', ready?: () => void): void;
  playSound(cue: GameSound): void;
  stopSound(): void;
  setEffectsMuted(muted: boolean): void;
  focus(target: 'start' | 'gate'): void;
}

export interface GameClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): number;
  clearTimeout(id: number): void;
}

export interface GameViewModelDependencies {
  clock: GameClock;
  random(): number;
  isVisible(): boolean;
  liveFactory: LiveSessionFactory;
  presentation: GamePresentation;
}

/** User commands; no DOM nodes, renderer instances or arbitrary fixture setters. */
export interface GameCommands {
  startCpu(): Promise<void>;
  start(): Promise<void>;
  connectLive(inviteCode: string, video?: boolean): Promise<void>;
  requestSpin(): void;
  respondTextChoice(token: number, accepted: boolean): void;
  purchaseUpgrade(id: UpgradeId): void;
  setBet(bet: Bet): void;
  leave(): void;
  toggleVoiceMuted(): void;
  toggleMicMuted(): void;
  toggleEffectsMuted(): void;
  visibilityChanged(): void;
  dispose(): void;
}
