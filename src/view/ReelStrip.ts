import type { SymbolId, UpgradeId } from '../../shared/protocol';
import { BASE_POOL, UPGRADE_DEFINITIONS } from '../domain/game';

export const MAX_REEL_STRIP_LENGTH = 30;

/** The display strip is the authoritative pool in the same order as domain stops. */
export function buildReelStrip(upgrades: readonly UpgradeId[]): SymbolId[] {
  const strip = [...BASE_POOL];
  const levels = { steady: 0, jackpot: 0 };
  for (const id of upgrades.slice(0, 6)) {
    if (++levels[id] > 3) continue;
    const definition = UPGRADE_DEFINITIONS[id];
    for (let count = 0; count < definition.addedCount; count += 1) strip.push(definition.addedSymbol);
  }
  return strip;
}
