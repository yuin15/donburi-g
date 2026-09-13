import type { MatchSnapshot, MatchStats, Side, SpinView, SymbolId, UpgradeId } from '../../shared/protocol.js';
import { MANUAL_SPIN_INTERVAL, MATCH_SECONDS, RIVAL_SPIN_INTERVAL } from '../../shared/protocol.js';
import { cloneMatchStats, createMatchStats, recordSpin } from './matchStats.js';

export { MANUAL_SPIN_INTERVAL, MATCH_SECONDS } from '../../shared/protocol.js';

export type MatchStatus = MatchSnapshot['status'];

export interface UpgradeDefinition {
  id: UpgradeId;
  label: string;
  description: string;
  addedSymbol: SymbolId;
  addedCount: number;
}

export interface MatchState {
  matchId: string;
  status: MatchStatus;
  spinMode: 'automatic' | 'manual';
  upgradesEnabled: boolean;
  lastManualSpinAt: number | null;
  elapsed: number;
  remaining: number;
  round: number;
  rounds: Record<Side, number>;
  scores: Record<Side, number>;
  stats: MatchStats;
  pools: Record<Side, SymbolId[]>;
  activePools: Record<Side, SymbolId[]>;
  upgrades: Record<Side, UpgradeId[]>;
  pending: Record<Side, Partial<Record<0 | 1, UpgradeId>>>;
  openOffers: Set<0 | 1>;
  winner?: Side | 'draw';
  eventSeq: number;
  processedSecond: number;
  rngState: Record<Side, number>;
  lastLeader: Side | 'draw';
}

export type GameEvent =
  | { type: 'spin'; seq: number; at: number; player: SpinView; rival: SpinView }
  | { type: 'side_spin'; seq: number; at: number; spin: SpinView }
  | { type: 'upgrade_open'; seq: number; at: number; offerIndex: 0 | 1; closesAt: number }
  | { type: 'upgrade_applied'; seq: number; at: number; offerIndex: 0 | 1; player: UpgradeId; rival: UpgradeId }
  | { type: 'leader_change'; seq: number; at: number; leader: Side | 'draw' }
  | { type: 'match_end'; seq: number; at: number; snapshot: MatchSnapshot };

export const SPIN_INTERVAL = RIVAL_SPIN_INTERVAL;
export const UPGRADE_OPEN_SECONDS = [20, 40] as const;
export const UPGRADE_CLOSE_SECONDS = [24, 44] as const;
export const DEFAULT_UPGRADE: UpgradeId = 'steady';

export const UPGRADE_DEFINITIONS: Record<UpgradeId, UpgradeDefinition> = {
  steady: {
    id: 'steady',
    label: '安定型',
    description: 'チェリーを6枚追加',
    addedSymbol: 'cherry',
    addedCount: 6,
  },
  jackpot: {
    id: 'jackpot',
    label: '大勝負',
    description: '7を1枚追加',
    addedSymbol: 'seven',
    addedCount: 1,
  },
};

export const STARTING_BALANCE = 30;
export const SPIN_COST = 1;
export const PAYOUT: Record<SymbolId, number> = { cherry: 3, bell: 6, seven: 30 };
export const BASE_POOL: readonly SymbolId[] = ['cherry', 'bell', 'seven', 'cherry', 'bell', 'cherry', 'bell', 'cherry', 'seven'];

function makeId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `match-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function nextRandom(state: MatchState, side: Side): number {
  let x = state.rngState[side] >>> 0;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  state.rngState[side] = x >>> 0;
  return (state.rngState[side] >>> 0) / 0x1_0000_0000;
}

function currentLeader(scores: Record<Side, number>): Side | 'draw' {
  if (scores.player === scores.rival) return 'draw';
  return scores.player > scores.rival ? 'player' : 'rival';
}

function nextSeq(state: MatchState): number {
  state.eventSeq += 1;
  return state.eventSeq;
}

function spinSide(state: MatchState, side: Side): SpinView | null {
  if (state.scores[side] < SPIN_COST) return null;
  state.scores[side] -= SPIN_COST;
  state.rounds[side] += 1;
  state.round = state.rounds.player;
  const pool = state.activePools[side];
  const symbols = [0, 1, 2].map(() => pool[Math.floor(nextRandom(state, side) * pool.length)]) as [SymbolId, SymbolId, SymbolId];
  const payout = symbols[0] === symbols[1] && symbols[1] === symbols[2] ? PAYOUT[symbols[0]] : 0;
  state.scores[side] += payout;
  const result = { round: state.rounds[side], side, symbols, payout, total: state.scores[side], upgrades: [...state.upgrades[side]] };
  recordSpin(state.stats, result);
  return result;
}

function applyUpgrade(state: MatchState, side: Side, id: UpgradeId): void {
  const definition = UPGRADE_DEFINITIONS[id];
  for (let i = 0; i < definition.addedCount; i += 1) state.pools[side].push(definition.addedSymbol);
  state.upgrades[side].push(id);
}

export function createMatch(
  seed = 0x51f15e,
  matchId = makeId(),
  spinMode: 'automatic' | 'manual' = 'automatic',
  legacyOptions: { upgrades?: boolean } = {},
): MatchState {
  const playerSeed = (seed ^ 0x9e3779b9) >>> 0 || 1;
  const rivalSeed = (seed ^ 0x85ebca6b) >>> 0 || 2;
  return {
    matchId,
    status: 'ready',
    spinMode,
    // Retained only for historical rule/reel verification. Current matches use the base pool.
    upgradesEnabled: legacyOptions.upgrades ?? false,
    lastManualSpinAt: null,
    elapsed: 0,
    remaining: MATCH_SECONDS,
    round: 0,
    rounds: { player: 0, rival: 0 },
    scores: { player: STARTING_BALANCE, rival: STARTING_BALANCE },
    stats: createMatchStats(),
    pools: { player: [...BASE_POOL], rival: [...BASE_POOL] },
    activePools: { player: [...BASE_POOL], rival: [...BASE_POOL] },
    upgrades: { player: [], rival: [] },
    pending: { player: {}, rival: {} },
    openOffers: new Set(),
    eventSeq: 0,
    processedSecond: 0,
    rngState: { player: playerSeed, rival: rivalSeed },
    lastLeader: 'draw',
  };
}

export function startMatch(state: MatchState): void {
  if (state.status !== 'ready') throw new Error('match_not_ready');
  state.status = 'playing';
}

export function submitUpgrade(
  state: MatchState,
  side: Side,
  offerIndex: 0 | 1,
  id: UpgradeId,
  atElapsed = state.elapsed,
): boolean {
  if (state.status !== 'playing' || !state.upgradesEnabled) return false;
  if (!state.openOffers.has(offerIndex)) return false;
  if (atElapsed < UPGRADE_OPEN_SECONDS[offerIndex] || atElapsed >= UPGRADE_CLOSE_SECONDS[offerIndex]) return false;
  if (state.pending[side][offerIndex]) return false;
  if (!(id in UPGRADE_DEFINITIONS)) return false;
  state.pending[side][offerIndex] = id;
  return true;
}

function performSpin(state: MatchState, at: number, events: GameEvent[], side?: Side): boolean {
  const leaderBefore = currentLeader(state.scores);
  const spins = side
    ? [spinSide(state, side)]
    : [spinSide(state, 'player'), spinSide(state, 'rival')];
  const settled = spins.filter((spin): spin is SpinView => spin !== null);
  if (side) {
    if (settled[0]) events.push({ type: 'side_spin', seq: nextSeq(state), at, spin: settled[0] });
  } else if (settled.length === 2) {
    events.push({ type: 'spin', seq: nextSeq(state), at, player: settled[0], rival: settled[1] });
  } else {
    settled.forEach(spin => events.push({ type: 'side_spin', seq: nextSeq(state), at, spin }));
  }
  const leaderAfter = currentLeader(state.scores);
  if (settled.length && leaderAfter !== leaderBefore && leaderAfter !== state.lastLeader) {
    state.lastLeader = leaderAfter;
    events.push({ type: 'leader_change', seq: nextSeq(state), at, leader: leaderAfter });
  }
  return settled.length > 0;
}

function processSecond(state: MatchState, second: number, events: GameEvent[]): void {
  if (second % SPIN_INTERVAL === 0 && second <= MATCH_SECONDS) {
    performSpin(state, second, events, state.spinMode === 'manual' ? 'rival' : undefined);
  }

  const openIndex = UPGRADE_OPEN_SECONDS.indexOf(second as 20 | 40);
  if (state.upgradesEnabled && openIndex >= 0) {
    const offerIndex = openIndex as 0 | 1;
    state.openOffers.add(offerIndex);
    events.push({
      type: 'upgrade_open',
      seq: nextSeq(state),
      at: second,
      offerIndex,
      closesAt: UPGRADE_CLOSE_SECONDS[offerIndex],
    });
  }

  const closeIndex = UPGRADE_CLOSE_SECONDS.indexOf(second as 24 | 44);
  if (state.upgradesEnabled && closeIndex >= 0) {
    const offerIndex = closeIndex as 0 | 1;
    const player = state.pending.player[offerIndex] ?? DEFAULT_UPGRADE;
    const rival = state.pending.rival[offerIndex] ?? DEFAULT_UPGRADE;
    applyUpgrade(state, 'player', player);
    applyUpgrade(state, 'rival', rival);
    state.openOffers.delete(offerIndex);
    state.activePools = { player: [...state.pools.player], rival: [...state.pools.rival] };
    events.push({ type: 'upgrade_applied', seq: nextSeq(state), at: second, offerIndex, player, rival });
  }

  if (second === MATCH_SECONDS) {
    state.status = 'result';
    state.winner = currentLeader(state.scores);
    state.remaining = 0;
    events.push({ type: 'match_end', seq: nextSeq(state), at: second, snapshot: getSnapshot(state) });
  }
}

export function advanceMatch(state: MatchState, elapsedSeconds: number): GameEvent[] {
  if (state.status !== 'playing') return [];
  const target = Math.min(MATCH_SECONDS, Math.max(state.elapsed, elapsedSeconds));
  const events: GameEvent[] = [];
  const wholeTarget = Math.floor(target);
  for (let second = state.processedSecond + 1; second <= wholeTarget; second += 1) {
    state.elapsed = second;
    state.remaining = MATCH_SECONDS - second;
    processSecond(state, second, events);
    state.processedSecond = second;
    if (second === MATCH_SECONDS) break;
  }
  state.elapsed = Math.min(target, MATCH_SECONDS);
  state.remaining = Math.max(0, MATCH_SECONDS - state.elapsed);
  return events;
}

/** Advance deadlines first, then draw once for an eligible manual request. */
export function requestManualSpin(state: MatchState, elapsedSeconds: number): GameEvent[] {
  const events = advanceMatch(state, elapsedSeconds);
  if (state.status !== 'playing' || state.spinMode !== 'manual' || state.elapsed >= MATCH_SECONDS) return events;
  // Ignore binary floating-point noise at exact 1.1-second boundaries.
  if (state.lastManualSpinAt !== null && state.elapsed + 1e-9 < state.lastManualSpinAt + MANUAL_SPIN_INTERVAL) return events;
  const playerRound = state.rounds.player;
  performSpin(state, state.elapsed, events, 'player');
  if (state.rounds.player > playerRound) state.lastManualSpinAt = state.elapsed;
  return events;
}

export function abortMatch(state: MatchState): void {
  if (state.status === 'result') return;
  state.status = 'aborted';
}

export function getSnapshot(state: MatchState): MatchSnapshot {
  return {
    matchId: state.matchId,
    status: state.status,
    elapsed: state.elapsed,
    remaining: state.remaining,
    round: state.round,
    rounds: { ...state.rounds },
    scores: { ...state.scores },
    stats: cloneMatchStats(state.stats),
    upgrades: { player: [...state.upgrades.player], rival: [...state.upgrades.rival] },
    winner: state.winner,
    eventSeq: state.eventSeq,
  };
}

export function getPoolCounts(state: MatchState, side: Side): Record<SymbolId, number> {
  return state.pools[side].reduce<Record<SymbolId, number>>(
    (counts, symbol) => ({ ...counts, [symbol]: counts[symbol] + 1 }),
    { cherry: 0, bell: 0, seven: 0 },
  );
}
