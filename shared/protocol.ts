export type Side = 'player' | 'rival';
export type UpgradeId = 'steady' | 'jackpot';
export type SymbolId = 'cherry' | 'bell' | 'seven';

export interface SpinView {
  round: number;
  side: Side;
  symbols: [SymbolId, SymbolId, SymbolId];
  payout: number;
  total: number;
}

export interface MatchSnapshot {
  matchId: string;
  status: 'ready' | 'countdown' | 'playing' | 'result' | 'aborted';
  elapsed: number;
  remaining: number;
  round: number;
  scores: Record<Side, number>;
  upgrades: Record<Side, UpgradeId[]>;
  winner?: Side | 'draw';
  eventSeq: number;
}

export type ClientMessage =
  | { type: 'start' }
  | { type: 'upgrade'; commandId: string; upgradeId: UpgradeId; offerIndex: number }
  | { type: 'mic'; audio: string }
  | { type: 'snapshot' }
  | { type: 'close' };

export type ServerMessage =
  | { type: 'hello'; live: true; sessionId: string }
  | { type: 'avatar'; livekitUrl: string; livekitToken: string }
  | { type: 'voice_status'; status: 'connecting' | 'ready' | 'closed' | 'error'; message?: string }
  | { type: 'snapshot'; snapshot: MatchSnapshot }
  | { type: 'spin'; player: SpinView; rival: SpinView }
  | { type: 'upgrade_offer'; offerIndex: number; closesAtElapsed: number }
  | { type: 'upgrade_applied'; offerIndex: number; player: UpgradeId; rival: UpgradeId }
  | { type: 'rival_line'; text: string; reason: string }
  | { type: 'transcript'; role: 'user' | 'assistant'; delta: string }
  | { type: 'match_ended'; snapshot: MatchSnapshot }
  | { type: 'error'; code: string; message: string; recoverable: boolean };
