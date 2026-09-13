import type { SymbolId, UpgradeId } from '../../shared/protocol';
import { BASE_POOL, UPGRADE_CLOSE_SECONDS, UPGRADE_DEFINITIONS } from '../domain/game';
import { SYMBOLS } from './ReelMotion';

export const MAX_REEL_STRIP_LENGTH = 21;

/** Public composition only; spacing is decorative and never selects an outcome. */
export function buildReelStrip(upgrades: readonly UpgradeId[]): SymbolId[] {
  // Normal #115 matches score the contiguous BASE_POOL window by its stop index.
  // Preserve that order exactly so the centre and both visible neighbours agree.
  if (upgrades.length === 0) return [...BASE_POOL];
  const counts: Record<SymbolId, number> = { cherry: 0, bell: 0, seven: 0 };
  for (const symbol of BASE_POOL) counts[symbol] += 1;
  for (const id of upgrades.slice(0, UPGRADE_CLOSE_SECONDS.length)) {
    const definition = UPGRADE_DEFINITIONS[id];
    counts[definition.addedSymbol] += definition.addedCount;
  }
  // Spread duplicate symbols around the loop so a rare symbol never requires
  // racing through an entire block of newly added cherries to reach its stop.
  return SYMBOLS.flatMap(symbol => Array.from({ length: counts[symbol] }, (_, index) => ({
    symbol, position: (index + .5) / counts[symbol],
  }))).sort((a, b) => a.position - b.position).map(cell => cell.symbol);
}
