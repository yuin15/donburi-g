export type VoiceMode = 'audio' | 'avatar';
export type Side = 'player' | 'rival';
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
export const MANUAL_SPIN_INTERVAL = 1.1;
export const RIVAL_SPIN_INTERVAL = 2;
export const MAX_MATCH_ROUNDS = Math.ceil(MATCH_SECONDS / MANUAL_SPIN_INTERVAL);

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
  upgrades?: UpgradeId[];
}

export interface MatchSnapshot {
  matchId: string;
  status: 'ready' | 'countdown' | 'playing' | 'result' | 'aborted';
  elapsed: number;
  remaining: number;
  round: number;
  rounds: Record<Side, number>;
  balances: Record<Side, number>;
  bets: Record<Side, Bet>;
  /** Compatibility projection for older clients; always equal to balances. */
  scores: Record<Side, number>;
  stats: MatchStats;
  upgrades: Record<Side, UpgradeId[]>;
  winner?: Side | 'draw';
  eventSeq: number;
}

export type ClientMessage =
  | { type: 'start' }
  | { type: 'spin'; commandId: string; matchId: string }
  | { type: 'set_bet'; commandId: string; bet: Bet; matchId: string }
  | { type: 'upgrade'; commandId: string; upgradeId: UpgradeId; offerIndex: UpgradeOfferIndex; matchId?: string }
  | { type: 'mic'; audio: string }
  | { type: 'voice_close' }
  | { type: 'snapshot' }
  | { type: 'close' };

export type ServerMessage =
  | { type: 'hello'; live: true; sessionId: string }
  | { type: 'voice_audio'; audio: string }
  | { type: 'voice_interrupt' }
  | { type: 'avatar'; livekitUrl: string; livekitToken: string }
  | { type: 'voice_status'; status: 'connecting' | 'ready' | 'closed' | 'error'; message?: string }
  | { type: 'snapshot'; snapshot: MatchSnapshot; lastSpin?: { player: SpinView; rival: SpinView }; lastSpins?: Partial<Record<Side, SpinView>> }
  | { type: 'spin'; player: SpinView; rival: SpinView }
  | { type: 'side_spin'; spin: SpinView }
  | { type: 'spin_status'; commandId: string; accepted: boolean; retryAfterMs: number }
  | { type: 'bet_status'; commandId: string; accepted: boolean; bet: Bet }
  | { type: 'upgrade_offer'; offerIndex: UpgradeOfferIndex; closesAtElapsed: number }
  | { type: 'upgrade_applied'; offerIndex: UpgradeOfferIndex; player: UpgradeId; rival: UpgradeId }
  | { type: 'rival_line'; text: string; reason: string }
  | { type: 'transcript'; role: 'user' | 'assistant'; delta: string }
  | { type: 'match_ended'; snapshot: MatchSnapshot }
  | { type: 'error'; code: string; message: string; recoverable: boolean };

export type ServerEnvelope = ServerMessage & { sessionId: string; streamSeq: number; serverTime: number };
