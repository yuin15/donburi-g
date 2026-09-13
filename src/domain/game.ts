import type { Bet, MatchSnapshot, MatchStats, ReelGrid, Side, SpinView, SymbolId, UpgradeId, WinningLine } from '../../shared/protocol.js';
import { EXTENSION_REQUEST_REMAINING_SECONDS, MANUAL_SPIN_INTERVAL, MATCH_SECONDS, MAX_MATCH_SECONDS, RIVAL_SPIN_INTERVAL } from '../../shared/protocol.js';
import { cloneMatchStats, createMatchStats, recordSpin } from './matchStats.js';
import { upgradePrice } from '../../shared/shop.js';

export { EXTENSION_REQUEST_REMAINING_SECONDS, MANUAL_SPIN_INTERVAL, MATCH_SECONDS, MAX_MATCH_SECONDS, TIME_EXTENSION_SECONDS } from '../../shared/protocol.js';
export type MatchStatus = MatchSnapshot['status'];
export const STARTING_BALANCE = 30;
/** A loan is a fixed transfer. Neither client nor model chooses the amount. */
export const LOAN_AMOUNT = 5;
export type LoanDirection = 'rival_to_player' | 'player_to_rival';
export const BETS = [1, 3, 5] as const satisfies readonly Bet[];
export const PAYOUT: Record<SymbolId, number> = { cherry: 3, bell: 6, seven: 30 };
export const BASE_POOL: readonly SymbolId[] = ['cherry', 'bell', 'seven', 'cherry', 'bell', 'cherry', 'bell', 'cherry', 'seven'];
export const ACTIVE_LINES: Record<Bet, readonly WinningLine[]> = {
  1: ['middle'], 3: ['top', 'middle', 'bottom'], 5: ['top', 'middle', 'bottom', 'diagonalDown', 'diagonalUp'],
};
const LINE_ROWS: Record<WinningLine, readonly [number, number, number]> = {
  top: [0, 0, 0], middle: [1, 1, 1], bottom: [2, 2, 2], diagonalDown: [0, 1, 2], diagonalUp: [2, 1, 0],
};

export interface MatchState {
  matchId: string;
  status: MatchStatus;
  spinMode: 'automatic' | 'manual';
  upgradeSpent: number;
  lastManualSpinAt: number | null;
  elapsed: number;
  remaining: number;
  duration: typeof MATCH_SECONDS | typeof MAX_MATCH_SECONDS;
  extensionUsed: boolean;
  loanUsed: Record<LoanDirection, boolean>;
  round: number;
  rounds: Record<Side, number>;
  /** Compatibility projection for older adapters. It shares the bankroll object. */
  balances: Record<Side, number>;
  scores: Record<Side, number>;
  bets: Record<Side, Bet>;
  stats: MatchStats;
  upgradesEnabled: boolean;
  upgrades: Record<Side, UpgradeId[]>;
  pools: Record<Side, SymbolId[]>;
  activePools: Record<Side, SymbolId[]>;
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
  | { type: 'leader_change'; seq: number; at: number; leader: Side | 'draw' }
  | { type: 'upgrade_open'; seq: number; at: number; offerIndex: 0 | 1; closesAt: number }
  | { type: 'upgrade_applied'; seq: number; at: number; offerIndex: 0 | 1; player: UpgradeId; rival: UpgradeId }
  | { type: 'time_extended'; seq: number; at: number; before: MatchSnapshot; after: MatchSnapshot }
  | { type: 'loan_transfer'; seq: number; at: number; direction: LoanDirection; before: MatchSnapshot; after: MatchSnapshot }
  | { type: 'match_end'; seq: number; at: number; snapshot: MatchSnapshot };
export const SPIN_INTERVAL = RIVAL_SPIN_INTERVAL;
/** Retired rules are exported only so stale review fixtures can compile. */
export const UPGRADE_OPEN_SECONDS = [20, 40] as const;
export const UPGRADE_CLOSE_SECONDS = [24, 44] as const;
export const DEFAULT_UPGRADE: UpgradeId = 'steady';
export const UPGRADE_DEFINITIONS = {
  steady: { id: 'steady' as const, label: '安定型', description: 'チェリーを6枚追加', addedSymbol: 'cherry' as const, addedCount: 6 },
  jackpot: { id: 'jackpot' as const, label: '大勝負', description: '7を1枚追加', addedSymbol: 'seven' as const, addedCount: 1 },
};

function makeId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `match-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
function nextRandom(state: MatchState, side: Side): number {
  let x = state.rngState[side] >>> 0;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  state.rngState[side] = x >>> 0;
  return state.rngState[side] / 0x1_0000_0000;
}
function currentLeader(scores: Record<Side, number>): Side | 'draw' {
  return scores.player === scores.rival ? 'draw' : scores.player > scores.rival ? 'player' : 'rival';
}
function nextSeq(state: MatchState): number { state.eventSeq += 1; return state.eventSeq; }
function at(pool: readonly SymbolId[], stop: number): SymbolId {
  return pool[((stop % pool.length) + pool.length) % pool.length];
}

/** One adjacent strip window is the outcome and the visible 3x3 grid. */
export function gridFromStops(stops: [number, number, number], pool: readonly SymbolId[] = BASE_POOL): ReelGrid {
  return [
    [at(pool, stops[0] - 1), at(pool, stops[1] - 1), at(pool, stops[2] - 1)],
    [at(pool, stops[0]), at(pool, stops[1]), at(pool, stops[2])],
    [at(pool, stops[0] + 1), at(pool, stops[1] + 1), at(pool, stops[2] + 1)],
  ];
}
export function evaluateGrid(grid: ReelGrid, bet: Bet): { winningLines: WinningLine[]; payout: number } {
  const winningLines = ACTIVE_LINES[bet].filter(line => {
    const [a, b, c] = LINE_ROWS[line];
    return grid[a][0] === grid[b][1] && grid[b][1] === grid[c][2];
  });
  return { winningLines: [...winningLines], payout: winningLines.reduce((sum, line) => sum + PAYOUT[grid[LINE_ROWS[line][0]][0]], 0) };
}
export function chooseRivalBet(state: MatchState): Bet {
  const balance = state.scores.rival, gap = balance - state.scores.player;
  if (state.remaining <= 10 && gap < 0 && balance >= 5) return 5;
  if (gap >= 25 || balance < 3) return 1;
  return 3;
}
function spinSide(state: MatchState, side: Side): SpinView | null {
  const bet = state.bets[side];
  if (state.scores[side] < bet) return null;
  state.scores[side] -= bet;
  const pool = state.activePools[side];
  const stops = [0, 1, 2].map(() => Math.floor(nextRandom(state, side) * pool.length)) as [number, number, number];
  const grid = gridFromStops(stops, pool);
  const { winningLines, payout } = evaluateGrid(grid, bet);
  state.scores[side] += payout;
  state.rounds[side] += 1;
  state.round = state.rounds.player;
  const result: SpinView = {
    round: state.rounds[side],
    side,
    symbols: grid[1],
    grid,
    stops,
    bet,
    winningLines,
    payout,
    total: state.scores[side],
    upgradeSpent: side === 'player' ? state.upgradeSpent : 0,
    ...(state.upgrades[side].length ? { upgrades: [...state.upgrades[side]] } : {}),
  };
  recordSpin(state.stats, result);
  return result;
}
export function createMatch(
  seed = 0x51f15e,
  matchId = makeId(),
  spinMode: 'automatic' | 'manual' = 'automatic',
  _legacyOptions: { upgrades?: boolean } = {},
): MatchState {
  const playerSeed = (seed ^ 0x9e3779b9) >>> 0 || 1;
  const rivalSeed = (seed ^ 0x85ebca6b) >>> 0 || 2;
  const upgradesEnabled = _legacyOptions.upgrades ?? false;
  const scores = { player: STARTING_BALANCE, rival: STARTING_BALANCE };
  return {
    matchId,
    status: 'ready',
    spinMode,
    upgradeSpent: 0,
    lastManualSpinAt: null,
    elapsed: 0,
    remaining: MATCH_SECONDS,
    duration: MATCH_SECONDS,
    extensionUsed: false,
    loanUsed: { rival_to_player: false, player_to_rival: false },
    round: 0,
    rounds: { player: 0, rival: 0 },
    balances: scores,
    scores,
    bets: { player: 1, rival: 1 },
    stats: createMatchStats(),
    upgradesEnabled,
    upgrades: { player: [], rival: [] },
    pools: { player: [...BASE_POOL], rival: [...BASE_POOL] },
    activePools: { player: [...BASE_POOL], rival: [...BASE_POOL] },
    pending: { player: {}, rival: {} },
    openOffers: new Set(),
    eventSeq: 0,
    processedSecond: 0,
    rngState: { player: playerSeed, rival: rivalSeed },
    lastLeader: 'draw',
  };
}
/** Retained for the upgrade flow; normal matches never open these offers. */
export function submitUpgrade(state: MatchState, side: Side, offer: 0 | 1, id: UpgradeId, elapsed = state.elapsed): boolean {
  if (
    !state.upgradesEnabled
    || state.status !== 'playing'
    || !state.openOffers.has(offer)
    || elapsed < UPGRADE_OPEN_SECONDS[offer]
    || elapsed >= UPGRADE_CLOSE_SECONDS[offer]
    || state.pending[side][offer]
  ) return false;
  state.pending[side][offer] = id;
  return true;
}
export function startMatch(state: MatchState): void {
  if (state.status !== 'ready') throw new Error('match_not_ready');
  state.status = 'playing';
}

/** Caller advances the authoritative clock before purchasing. Never alters an existing spin. */
export function purchaseUpgrade(state: MatchState, id: UpgradeId, expectedCount: number): boolean {
  if (state.status !== 'playing' || state.elapsed >= MATCH_SECONDS || state.upgradesEnabled) return false;
  if (id !== 'steady' && id !== 'jackpot') return false;
  const count = state.upgrades.player.filter(value => value === id).length;
  const price = upgradePrice(state.upgrades.player, id);
  if (count !== expectedCount || price === null || state.scores.player < price) return false;
  state.scores.player -= price;
  state.upgradeSpent += price;
  const definition = UPGRADE_DEFINITIONS[id];
  for (let count = 0; count < definition.addedCount; count += 1) state.pools.player.push(definition.addedSymbol);
  state.upgrades.player.push(id);
  state.activePools.player = [...state.pools.player];
  state.lastLeader = currentLeader(state.scores);
  nextSeq(state);
  return true;
}

export function setBet(state: MatchState, side: Side, bet: Bet): boolean {
  if ((state.status !== 'playing' && state.status !== 'ready') || !BETS.includes(bet) || state.scores[side] < bet) return false;
  state.bets[side] = bet;
  return true;
}
function performSpin(state: MatchState, atElapsed: number, events: GameEvent[], side?: Side): void {
  const leaderBefore = currentLeader(state.scores);
  if (side) {
    if (side === 'rival') state.bets.rival = chooseRivalBet(state);
    const spin = spinSide(state, side);
    if (spin) events.push({ type: 'side_spin', seq: nextSeq(state), at: atElapsed, spin });
  } else {
    const player = spinSide(state, 'player');
    const rival = spinSide(state, 'rival');
    if (player && rival) events.push({ type: 'spin', seq: nextSeq(state), at: atElapsed, player, rival });
    else if (player) events.push({ type: 'side_spin', seq: nextSeq(state), at: atElapsed, spin: player });
    else if (rival) events.push({ type: 'side_spin', seq: nextSeq(state), at: atElapsed, spin: rival });
  }
  const leaderAfter = currentLeader(state.scores);
  if (leaderAfter !== leaderBefore && leaderAfter !== state.lastLeader) {
    state.lastLeader = leaderAfter;
    events.push({ type: 'leader_change', seq: nextSeq(state), at: atElapsed, leader: leaderAfter });
  }
}
function processSecond(state: MatchState, second: number, events: GameEvent[]): void {
  if (second % SPIN_INTERVAL === 0 && second <= state.duration) performSpin(state, second, events, state.spinMode === 'manual' ? 'rival' : undefined);
  const openIndex = UPGRADE_OPEN_SECONDS.indexOf(second as 20 | 40);
  if (state.upgradesEnabled && openIndex >= 0) {
    const offerIndex = openIndex as 0 | 1;
    state.openOffers.add(offerIndex);
    events.push({ type: 'upgrade_open', seq: nextSeq(state), at: second, offerIndex, closesAt: UPGRADE_CLOSE_SECONDS[offerIndex] });
  }
  const closeIndex = UPGRADE_CLOSE_SECONDS.indexOf(second as 24 | 44);
  if (state.upgradesEnabled && closeIndex >= 0) {
    const offerIndex = closeIndex as 0 | 1;
    const player = state.pending.player[offerIndex] ?? DEFAULT_UPGRADE;
    const rival = state.pending.rival[offerIndex] ?? DEFAULT_UPGRADE;
    for (const [side, upgrade] of [['player', player], ['rival', rival]] as const) {
      for (let count = 0; count < UPGRADE_DEFINITIONS[upgrade].addedCount; count += 1) state.pools[side].push(UPGRADE_DEFINITIONS[upgrade].addedSymbol);
      state.upgrades[side].push(upgrade);
    }
    state.activePools = { player: [...state.pools.player], rival: [...state.pools.rival] };
    state.openOffers.delete(offerIndex);
    events.push({ type: 'upgrade_applied', seq: nextSeq(state), at: second, offerIndex, player, rival });
  }
  if (second === state.duration) {
    state.status = 'result';
    state.winner = currentLeader(state.scores);
    state.remaining = 0;
    events.push({ type: 'match_end', seq: nextSeq(state), at: second, snapshot: getSnapshot(state) });
  }
}
export function advanceMatch(state: MatchState, elapsedSeconds: number, holdAtDeadline = false): GameEvent[] {
  if (state.status !== 'playing') return [];
  const target = Math.min(state.duration, Math.max(state.elapsed, elapsedSeconds));
  const events: GameEvent[] = [];
  for (let second = state.processedSecond + 1; second <= Math.floor(target); second += 1) {
    if (holdAtDeadline && second === state.duration) break;
    state.elapsed = second;
    state.remaining = state.duration - second;
    processSecond(state, second, events);
    state.processedSecond = second;
  }
  state.elapsed = Math.min(target, state.duration);
  state.remaining = Math.max(0, state.duration - state.elapsed);
  return events;
}

/** The domain is the only place that can turn a model decision into extra time. */
export function applyTimeExtension(state: MatchState): Extract<GameEvent, { type: 'time_extended' }> | null {
  if (
    state.status !== 'playing'
    || state.extensionUsed
    || state.duration !== MATCH_SECONDS
    || state.remaining > EXTENSION_REQUEST_REMAINING_SECONDS
  ) return null;
  const before = getSnapshot(state);
  state.duration = MAX_MATCH_SECONDS;
  state.remaining = Math.max(0, state.duration - state.elapsed);
  state.extensionUsed = true;
  return { type: 'time_extended', seq: nextSeq(state), at: state.elapsed, before, after: getSnapshot(state) };
}
/**
 * The authoritative, all-or-nothing loan entry point. A transfer is possible
 * only while the borrower cannot place the minimum bet and the lender can
 * cover the fixed amount. `balances` shares `scores`, so snapshots stay equal.
 */
export function transferLoan(state: MatchState, direction: LoanDirection): Extract<GameEvent, { type: 'loan_transfer' }> | null {
  const [lender, borrower] = direction === 'rival_to_player'
    ? ['rival', 'player'] as const
    : ['player', 'rival'] as const;
  if (
    state.status !== 'playing'
    || state.loanUsed[direction]
    || state.scores[borrower] >= BETS[0]
    || state.scores[lender] < LOAN_AMOUNT
  ) return null;
  const before = getSnapshot(state);
  state.scores[lender] -= LOAN_AMOUNT;
  state.scores[borrower] += LOAN_AMOUNT;
  state.loanUsed[direction] = true;
  return { type: 'loan_transfer', seq: nextSeq(state), at: state.elapsed, direction, before, after: getSnapshot(state) };
}
export function requestManualSpin(state: MatchState, elapsedSeconds: number, holdAtDeadline = false): GameEvent[] {
  const events = advanceMatch(state, elapsedSeconds, holdAtDeadline);
  if (
    state.status !== 'playing'
    || state.spinMode !== 'manual'
    || state.elapsed >= state.duration
    || (state.lastManualSpinAt !== null && state.elapsed + 1e-9 < state.lastManualSpinAt + MANUAL_SPIN_INTERVAL)
    || state.scores.player < state.bets.player
  ) return events;
  state.lastManualSpinAt = state.elapsed;
  performSpin(state, state.elapsed, events, 'player');
  return events;
}
export function abortMatch(state: MatchState): void {
  if (state.status !== 'result') state.status = 'aborted';
}
export function getSnapshot(state: MatchState): MatchSnapshot {
  return {
    matchId: state.matchId,
    status: state.status,
    elapsed: state.elapsed,
    remaining: state.remaining,
    duration: state.duration,
    round: state.round,
    rounds: { ...state.rounds },
    balances: { ...state.scores },
    bets: { ...state.bets },
    scores: { ...state.scores },
    stats: cloneMatchStats(state.stats),
    upgradeSpent: state.upgradeSpent,
    upgrades: { player: [...state.upgrades.player], rival: [...state.upgrades.rival] },
    winner: state.winner,
    eventSeq: state.eventSeq,
  };
}
export function getPoolCounts(state?: MatchState, side: Side = 'player'): Record<SymbolId, number> {
  return (state?.pools[side] ?? BASE_POOL).reduce<Record<SymbolId, number>>(
    (counts, symbol) => ({ ...counts, [symbol]: counts[symbol] + 1 }),
    { cherry: 0, bell: 0, seven: 0 },
  );
}
