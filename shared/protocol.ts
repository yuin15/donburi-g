export type VoiceMode = 'audio' | 'avatar';
export type AiProvider = 'gptLive' | 'liveAvatar';
export type AiProviderState = 'connecting' | 'connected' | 'failed' | 'closed';
export type Side = 'player' | 'rival';
export type LoanDirection = 'rival_to_player' | 'player_to_rival';
export type SymbolId = 'cherry' | 'bell' | 'seven';
/** Deprecated #114 API shape. New matches never offer upgrades. */
export type UpgradeId = 'steady' | 'jackpot';
export type UpgradeOfferIndex = 0 | 1;
export type Bet = 1 | 3 | 5;
export type WinningLine = 'middle' | 'top' | 'bottom' | 'diagonalDown' | 'diagonalUp';
export type ReelGrid = [
  [SymbolId, SymbolId, SymbolId],
  [SymbolId, SymbolId, SymbolId],
  [SymbolId, SymbolId, SymbolId],
];

export const MATCH_SECONDS = 60;
export const TIME_EXTENSION_SECONDS = 10;
export const MAX_MATCH_SECONDS = MATCH_SECONDS + TIME_EXTENSION_SECONDS;
export const EXTENSION_REQUEST_REMAINING_SECONDS = 15;
export const MANUAL_SPIN_INTERVAL = 1.1;
export const RIVAL_SPIN_INTERVAL = 2;
export const MAX_MATCH_ROUNDS = Math.ceil(MAX_MATCH_SECONDS / MANUAL_SPIN_INTERVAL);

export type SideStats = {
  wins: Record<SymbolId, number>;
  bestSpin: { round: number; payout: number } | null;
};

export type MatchStats = Record<Side, SideStats>;

export interface SpinView {
  round: number;
  side: Side;
  /** The centre row is retained for older display adapters. */
  symbols: [SymbolId, SymbolId, SymbolId];
  grid?: ReelGrid;
  stops?: [number, number, number];
  bet?: Bet;
  winningLines?: WinningLine[];
  payout: number;
  total: number;
  upgradeSpent?: number;
  upgrades?: UpgradeId[];
}

export interface MatchSnapshot {
  matchId: string;
  status: 'ready' | 'countdown' | 'playing' | 'result' | 'aborted';
  elapsed: number;
  remaining: number;
  /** Present on authoritative snapshots. Absent only for older saved wire fixtures. */
  duration?: number;
  round: number;
  rounds: Record<Side, number>;
  balances: Record<Side, number>;
  bets: Record<Side, Bet>;
  /** Compatibility projection for older clients; always equal to balances. */
  scores: Record<Side, number>;
  stats: MatchStats;
  upgradeSpent?: number;
  upgrades: Record<Side, UpgradeId[]>;
  /** Authoritative rival-only pause. It survives snapshot recovery during a Live match. */
  rivalDistraction?: { untilElapsed: number; seconds: 2 | 4 };
  winner?: Side | 'draw';
  eventSeq: number;
}

export type ClientMessage =
  | { type: 'purchase'; commandId: string; matchId: string; upgradeId: UpgradeId; expectedCount: number }
  | { type: 'start' }
  | { type: 'spin'; commandId: string; matchId: string }
  | { type: 'set_bet'; commandId: string; bet: Bet; matchId: string }
  | { type: 'upgrade'; commandId: string; upgradeId: UpgradeId; offerIndex: UpgradeOfferIndex; matchId?: string }
  | { type: 'mic'; audio: string }
  | { type: 'voice_speech_done'; speechId: string }
  | { type: 'voice_route_ready'; transitionId: string }
  | { type: 'voice_close' }
  | { type: 'snapshot' }
  | { type: 'close' };

export type ServerMessage =
  | { type: 'hello'; live: true; sessionId: string }
  | { type: 'voice_audio'; audio: string; speechId?: string }
  | { type: 'voice_speech_end'; speechId: string }
  | { type: 'voice_interrupt' }
  /** Server has stopped avatar audio; browser ACKs after PCM playback is ready. */
  | { type: 'voice_route'; route: 'audio'; transitionId: string }
  | { type: 'avatar'; livekitUrl: string; livekitToken: string }
  | { type: 'provider_status'; provider: AiProvider; state: AiProviderState }
  | { type: 'voice_status'; status: 'connecting' | 'ready' | 'closed' | 'error'; message?: string }
  | { type: 'snapshot'; snapshot: MatchSnapshot; lastSpin?: { player: SpinView; rival: SpinView }; lastSpins?: Partial<Record<Side, SpinView>> }
  | { type: 'spin'; player: SpinView; rival: SpinView }
  | { type: 'side_spin'; spin: SpinView }
  | { type: 'spin_status'; commandId: string; accepted: boolean; retryAfterMs: number }
  | { type: 'bet_status'; commandId: string; accepted: boolean; bet: Bet }
  | { type: 'upgrade_offer'; offerIndex: UpgradeOfferIndex; closesAtElapsed: number }
  | { type: 'upgrade_applied'; offerIndex: UpgradeOfferIndex; player: UpgradeId; rival: UpgradeId }
  | { type: 'rival_line'; text: string; reason: string }
  | {
    type: 'time_extension';
    decision: 'accepted' | 'rejected';
    before: MatchSnapshot;
    after: MatchSnapshot;
    line: string;
  }
  | { type: 'loan_transfer'; direction: LoanDirection; amount: 5; before: MatchSnapshot; after: MatchSnapshot; line: string }
  | {
    type: 'rival_distraction';
    state: 'started' | 'ended';
    seconds: 2 | 4;
    line: string;
  }
  | { type: 'transcript'; role: 'user' | 'assistant'; delta: string }
  | { type: 'match_ended'; snapshot: MatchSnapshot }
  | { type: 'error'; code: string; message: string; recoverable: boolean };

export type ServerEnvelope = ServerMessage & { sessionId: string; streamSeq: number; serverTime: number };
