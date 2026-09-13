import type { SymbolId, UpgradeId } from '../../shared/protocol';
import { BASE_POOL, UPGRADE_CLOSE_SECONDS, UPGRADE_DEFINITIONS } from '../domain/game';

export const MAX_REEL_STRIP_LENGTH = 21;

/** The display strip is the authoritative pool in the same order as domain stops. */
export function buildReelStrip(upgrades: readonly UpgradeId[]): SymbolId[] {
  const strip = [...BASE_POOL];
  for (const id of upgrades.slice(0, UPGRADE_CLOSE_SECONDS.length)) {
    const definition = UPGRADE_DEFINITIONS[id];
    for (let count = 0; count < definition.addedCount; count += 1) strip.push(definition.addedSymbol);
  }
  return strip;
}
