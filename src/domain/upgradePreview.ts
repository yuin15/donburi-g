import type { SymbolId, UpgradeId } from '../../shared/protocol.js';
import { BASE_POOL, UPGRADE_DEFINITIONS } from './game.js';

export interface UpgradePoolPreview {
  counts: Record<SymbolId, number>;
  total: number;
  hitChance: number;
  sevenChance: number;
}

function summarize(counts: Record<SymbolId, number>): UpgradePoolPreview {
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  return {
    counts,
    total,
    hitChance: Object.values(counts).reduce((chance, count) => chance + (count / total) ** 3, 0),
    sevenChance: (counts.seven / total) ** 3,
  };
}

/** Public pool composition and probabilities; no match or random state is read. */
export function describePool(applied: readonly UpgradeId[]): UpgradePoolPreview {
  const counts: Record<SymbolId, number> = { cherry: 0, bell: 0, seven: 0 };
  for (const symbol of BASE_POOL) counts[symbol] += 1;
  for (const id of applied) {
    const definition = UPGRADE_DEFINITIONS[id];
    counts[definition.addedSymbol] += definition.addedCount;
  }
  return summarize(counts);
}

/** Public rule probabilities for three independent reels; no match or random state is read. */
export function describeUpgrade(applied: readonly UpgradeId[], choice: UpgradeId): {
  before: UpgradePoolPreview;
  after: UpgradePoolPreview;
} {
  return { before: describePool(applied), after: describePool([...applied, choice]) };
}
