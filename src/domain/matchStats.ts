import type { MatchStats, SideStats, SpinView } from '../../shared/protocol.js';
export type { MatchStats, SideStats } from '../../shared/protocol.js';

function createSideStats(): SideStats {
  return { wins: { cherry: 0, bell: 0, seven: 0 }, bestSpin: null };
}

export function createMatchStats(): MatchStats {
  return { player: createSideStats(), rival: createSideStats() };
}

/** Record each confirmed domain spin once; misses leave the summary unchanged. */
export function recordSpin(stats: MatchStats, spin: SpinView): void {
  if (spin.payout === 0) return;
  const side = stats[spin.side];
  side.wins[spin.symbols[0]] += 1;
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
