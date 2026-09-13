import { describe, expect, it } from 'vitest';
import { advanceMatch, createMatch, getPoolCounts, getSnapshot, purchaseUpgrade, requestManualSpin, startMatch } from './game';
import { parseServerEnvelope } from '../../shared/wire';
import { buildReelStrip } from '../view/ReelStrip';

describe('paid upgrades', () => {
  it('charges escalating prices, rejects stale attempts and caps purchases', () => {
    const state = createMatch(42, 'shop', 'manual');
    expect(purchaseUpgrade(state, 'steady', 0)).toBe(false);
    startMatch(state);
    for (const [count, balance] of [[0, 25], [1, 15], [2, 0]]) {
      expect(purchaseUpgrade(state, 'steady', count)).toBe(true);
      expect(state.scores.player).toBe(balance);
      expect(purchaseUpgrade(state, 'steady', count)).toBe(false);
    }
    expect(purchaseUpgrade(state, 'steady', 3)).toBe(false);
    expect(purchaseUpgrade(state, 'jackpot', 0)).toBe(false);
    expect(state.upgradeSpent).toBe(30);
    expect(getPoolCounts(state, 'player')).toEqual({ cherry: 22, bell: 3, seven: 2 });
    expect(state.upgrades.rival).toEqual([]);
    expect(createMatch().upgradeSpent).toBe(0);
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
