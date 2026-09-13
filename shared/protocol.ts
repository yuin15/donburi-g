export type VoiceMode = 'audio' | 'avatar';
export type AiProvider = 'gptLive' | 'liveAvatar';
export type AiProviderState = 'connecting' | 'connected' | 'failed' | 'closed';
export type Side = 'player' | 'rival';
export type UpgradeId = 'steady' | 'jackpot';
export type SymbolId = 'cherry' | 'bell' | 'seven';
export type UpgradeOfferIndex = 0 | 1;

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
  symbols: [SymbolId, SymbolId, SymbolId];
  payout: number;
  total: number;
  upgrades?: UpgradeId[];
}

export interface MatchSnapshot {
  matchId: string;
  status: 'ready' | 'countdown' | 'playing' | 'result' | 'aborted';
  elapsed: number;
  remaining: number;
  /** Present on authoritative snapshots. Absent only for older saved wire fixtures. */
  duration?: typeof MATCH_SECONDS | typeof MAX_MATCH_SECONDS;
  round: number;
  rounds: Record<Side, number>;
  scores: Record<Side, number>;
  stats: MatchStats;
  upgrades: Record<Side, UpgradeId[]>;
  winner?: Side | 'draw';
  eventSeq: number;
}

export type ClientMessage =
  | { type: 'start' }
  | { type: 'spin'; commandId: string; matchId: string }
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
  | { type: 'provider_status'; provider: AiProvider; state: AiProviderState }
  | { type: 'voice_status'; status: 'connecting' | 'ready' | 'closed' | 'error'; message?: string }
  | { type: 'snapshot'; snapshot: MatchSnapshot; lastSpin?: { player: SpinView; rival: SpinView }; lastSpins?: Partial<Record<Side, SpinView>> }
  | { type: 'spin'; player: SpinView; rival: SpinView }
  | { type: 'side_spin'; spin: SpinView }
  | { type: 'spin_status'; commandId: string; accepted: boolean; retryAfterMs: number }
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
  | { type: 'transcript'; role: 'user' | 'assistant'; delta: string }
  | { type: 'match_ended'; snapshot: MatchSnapshot }
  | { type: 'error'; code: string; message: string; recoverable: boolean };

export type ServerEnvelope = ServerMessage & { sessionId: string; streamSeq: number; serverTime: number };
