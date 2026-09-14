import type { MatchStats, SideStats, SpinView } from '../../shared/protocol.js';
export type { MatchStats, SideStats } from '../../shared/protocol.js';

const WINNING_LINE_ROWS = { top: 0, middle: 1, bottom: 2, diagonalDown: 0, diagonalUp: 2 } as const;

/**
 * Resolves the symbol on every confirmed payline. Older spin payloads retain
 * their centre-row projection, so server and historic wire fixtures agree.
 */
export function winningSymbols(spin: SpinView): Array<SpinView['symbols'][number]> {
  if (spin.payout === 0) return [];
  if (spin.grid && spin.winningLines?.length) {
    return spin.winningLines.map(line => spin.grid![WINNING_LINE_ROWS[line]][0]);
  }
  return [spin.symbols[0]];
}

function createSideStats(): SideStats {
  return { wins: { cherry: 0, bell: 0, seven: 0 }, bestSpin: null };
}

export function createMatchStats(): MatchStats {
  return { player: createSideStats(), rival: createSideStats() };
}

/** Record each confirmed domain spin once; misses leave the summary unchanged. */
export function recordSpin(stats: MatchStats, spin: SpinView): void {
  const symbols = winningSymbols(spin);
  if (symbols.length === 0) return;
  const side = stats[spin.side];
  for (const symbol of symbols) side.wins[symbol] += 1;
  if (side.bestSpin === null || spin.payout > side.bestSpin.payout) {
    side.bestSpin = { round: spin.round, payout: spin.payout };
  }
}

function cloneSideStats(stats: SideStats): SideStats {
  return { wins: { ...stats.wins }, bestSpin: stats.bestSpin === null ? null : { ...stats.bestSpin } };
}

export function cloneMatchStats(stats: MatchStats): MatchStats {
  return { player: cloneSideStats(stats.player), rival: cloneSideStats(stats.rival) };
}
