import { describe, expect, it } from 'vitest';
import type { SymbolId, UpgradeId } from '../../shared/protocol';
import {
  advanceMatch,
  BASE_POOL,
  createMatch,
  getPoolCounts,
  startMatch,
  submitUpgrade,
  UPGRADE_CLOSE_SECONDS,
  UPGRADE_DEFINITIONS,
  UPGRADE_OPEN_SECONDS,
} from './game';
import { describeUpgrade, type UpgradePoolPreview } from './upgradePreview';

// Enumerate actual reel entries rather than reimplementing the preview's probability formula.
function expectPoolOdds(preview: UpgradePoolPreview, pool: readonly SymbolId[]): void {
  let combinations = 0;
  let hits = 0;
  let sevens = 0;
  for (const left of pool) {
    for (const center of pool) {
      for (const right of pool) {
        combinations += 1;
        if (left === center && center === right) {
          hits += 1;
          if (left === 'seven') sevens += 1;
        }
      }
    }
  }
  expect(preview.total).toBe(pool.length);
  expect(preview.hitChance).toBeCloseTo(hits / combinations, 12);
  expect(preview.sevenChance).toBeCloseTo(sevens / combinations, 12);
}

describe('public upgrade preview', () => {
  const sequences: [UpgradeId, UpgradeId][] = [
    ['steady', 'steady'], ['steady', 'jackpot'], ['jackpot', 'steady'], ['jackpot', 'jackpot'],
  ];

  it.each(sequences)('matches the domain before and after %s then %s', (first, second) => {
    const state = createMatch(73, 'preview-domain-check', 'automatic', { upgrades: true });
    startMatch(state);
    const choices = [first, second] as const;
    for (const index of [0, 1] as const) {
      advanceMatch(state, UPGRADE_OPEN_SECONDS[index]);
      const untouchedState = structuredClone(state);
      const preview = describeUpgrade(state.upgrades.player, choices[index]);
      expect(state).toEqual(untouchedState);
      expect(preview.before.counts).toEqual(getPoolCounts(state, 'player'));
      expectPoolOdds(preview.before, state.activePools.player);

      expect(submitUpgrade(state, 'player', index, choices[index])).toBe(true);
      advanceMatch(state, UPGRADE_CLOSE_SECONDS[index]);
      expect(preview.after.counts).toEqual(getPoolCounts(state, 'player'));
      expectPoolOdds(preview.after, state.activePools.player);
    }
  });

  it('makes the frequency versus seven payout tradeoff explicit', () => {
    const steady = describeUpgrade([], 'steady');
    const jackpot = describeUpgrade([], 'jackpot');
    expect(steady.before.counts).toEqual({ cherry: 4, bell: 3, seven: 2 });
    expect(steady.after.hitChance).toBeGreaterThan(jackpot.after.hitChance);
    expect(steady.after.sevenChance).toBeLessThan(steady.before.sevenChance);
    expect(jackpot.after.sevenChance).toBeGreaterThan(jackpot.before.sevenChance);
    expect(jackpot.after.sevenChance).toBeCloseTo(0.027, 12);
    expect(steady.after.hitChance).toBeCloseTo(0.3066666666666667, 12);
  });

  it('leaves inputs and shared definitions unchanged and returns independent counts', () => {
    const applied = Object.freeze<UpgradeId[]>(['steady']);
    const definitionsBefore = structuredClone(UPGRADE_DEFINITIONS);
    const poolBefore = [...BASE_POOL];
    const preview = describeUpgrade(applied, 'jackpot');
    const expected = structuredClone(preview);

    preview.after.counts.cherry = -1;
    expect(preview.before).toEqual(expected.before);
    preview.before.counts.seven = -1;

    expect(describeUpgrade(applied, 'jackpot')).toEqual(expected);
    expect(applied).toEqual(['steady']);
    expect(BASE_POOL).toEqual(poolBefore);
    expect(UPGRADE_DEFINITIONS).toEqual(definitionsBefore);
  });
});
