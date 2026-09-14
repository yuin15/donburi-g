import { describe, expect, it } from 'vitest';
import { advanceMatch, createMatch, getPoolCounts, getSnapshot, purchaseUpgrade, requestManualSpin, startMatch } from './game';
import { parseServerEnvelope } from '../../shared/wire';
import { upgradePrice } from '../../shared/shop';
import { buildReelStrip } from '../view/ReelStrip';

describe('paid upgrades', () => {
  it.each([
    ['steady', { cherry: 22, bell: 3, seven: 2 }],
    ['jackpot', { cherry: 4, bell: 3, seven: 5 }],
  ] as const)('charges $10, $15, then $20 for three %s purchases while preserving its effect and cap', (id, pool) => {
    const state = createMatch(42, 'shop', 'manual');
    expect(upgradePrice([], id)).toBe(10);
    expect(purchaseUpgrade(state, id, 0)).toBe(false);
    startMatch(state);
    state.scores.player = 45;
    for (const [count, price, balance] of [[0, 10, 35], [1, 15, 20], [2, 20, 0]]) {
      expect(upgradePrice(state.upgrades.player, id)).toBe(price);
      expect(purchaseUpgrade(state, id, count)).toBe(true);
      expect(state.scores.player).toBe(balance);
      expect(purchaseUpgrade(state, id, count)).toBe(false);
    }
    expect(upgradePrice(state.upgrades.player, id)).toBeNull();
    expect(purchaseUpgrade(state, id, 3)).toBe(false);
    expect(state.upgrades.player).toEqual([id, id, id]);
    expect(state.upgradeSpent).toBe(45);
    expect(getPoolCounts(state, 'player')).toEqual(pool);
    expect(state.upgrades.rival).toEqual([]);
    expect(createMatch().upgradeSpent).toBe(0);
  });
  it('rejects a $10 purchase when the player lacks sufficient balance', () => {
    const state = createMatch(42, 'shop', 'manual');
    startMatch(state);
    state.scores.player = 9;

    expect(purchaseUpgrade(state, 'steady', 0)).toBe(false);
    expect(state.scores.player).toBe(9);
    expect(state.upgradeSpent).toBe(0);
    expect(state.upgrades.player).toEqual([]);
  });
  it('preserves started spins and validates recovery after spending', () => {
    const state = createMatch(42, 'shop', 'manual'); startMatch(state);
    const event = requestManualSpin(state, 0).find(e => e.type === 'side_spin');
    if (event?.type !== 'side_spin') throw new Error('missing spin');
    const before = structuredClone(event.spin);
    expect(purchaseUpgrade(state, 'jackpot', 0)).toBe(true);
    expect(event.spin).toEqual(before);
    const wire = { type: 'snapshot', snapshot: getSnapshot(state), lastSpins: { player: event.spin }, sessionId: 'shop', streamSeq: 1, serverTime: 0 };
    expect(parseServerEnvelope(JSON.stringify(wire))).not.toBeNull();
    const next = requestManualSpin(state, 1.1).find(e => e.type === 'side_spin');
    expect(next?.type === 'side_spin' && next.spin.upgrades).toEqual(['jackpot']);
    advanceMatch(state, 60);
    expect(purchaseUpgrade(state, 'steady', 0)).toBe(false);
    expect(state.upgrades.rival).toEqual([]);
  });
  it('renders all six legal purchases with the exact pool composition', () => {
    const strip = buildReelStrip(['steady', 'jackpot', 'steady', 'jackpot', 'steady', 'jackpot']);
    expect(strip).toHaveLength(30);
    expect(strip.filter(s => s === 'cherry')).toHaveLength(22);
    expect(strip.filter(s => s === 'seven')).toHaveLength(5);
  });
});
