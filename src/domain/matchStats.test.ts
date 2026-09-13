import { describe, expect, it } from 'vitest';
import type { Side, SpinView, SymbolId } from '../../shared/protocol';
import { advanceMatch, createMatch, PAYOUT, startMatch } from './game';
import { cloneMatchStats, createMatchStats, recordSpin } from './matchStats';

function winningSpin(side: Side, symbol: SymbolId, round: number): SpinView {
  return { side, round, symbols: [symbol, symbol, symbol], payout: PAYOUT[symbol], total: PAYOUT[symbol] };
}

describe('confirmed match statistics', () => {
  it.each([2654435761, 3668339987, 4203543429, 1035485675])('reconciles both sides with all 30 domain spins for seed %s', seed => {
    const state = createMatch(seed, 'stats-domain-check');
    startMatch(state);
    const spins = advanceMatch(state, 60).filter(event => event.type === 'spin');
    const stats = createMatchStats();
    expect(spins).toHaveLength(30);
    for (const event of spins) {
      recordSpin(stats, event.player);
      recordSpin(stats, event.rival);
    }
    expect(state.stats).toEqual(stats);

    for (const side of ['player', 'rival'] as const) {
      const summary = stats[side];
      const history = spins.map(event => event[side]);
      const total = history.reduce((sum, spin) => sum + spin.payout, 0);
      const betCost = history.reduce((sum, spin) => sum + (spin.bet ?? 0), 0);
      expect(state.balances[side]).toBe(100 - betCost + total);
      expect(Object.values(summary.wins).reduce((sum, count) => sum + count, 0)).toBe(history.reduce((sum, spin) => sum + (spin.winningLines?.length ?? Number(spin.payout > 0)), 0));

      const highestPayout = Math.max(...history.map(spin => spin.payout));
      const firstBest = history.find(spin => spin.payout === highestPayout);
      expect(summary.bestSpin).toEqual(highestPayout > 0 ? { round: firstBest!.round, payout: highestPayout } : null);
    }
  });

  it('counts each winning symbol and keeps the first highest-paying round through ties', () => {
    const stats = createMatchStats();
    const cherry = winningSpin('player', 'cherry', 3);
    recordSpin(stats, cherry);
    expect(stats.player.bestSpin).toEqual({ round: 3, payout: PAYOUT.cherry });
    recordSpin(stats, winningSpin('player', 'bell', 8));
    expect(stats.player.bestSpin).toEqual({ round: 8, payout: PAYOUT.bell });
    recordSpin(stats, winningSpin('player', 'seven', 12));
    recordSpin(stats, winningSpin('player', 'seven', 18));
    recordSpin(stats, winningSpin('player', 'cherry', 22));
    expect(stats.player.wins).toEqual({ cherry: 2, bell: 1, seven: 2 });
    expect(stats.player.bestSpin).toEqual({ round: 12, payout: PAYOUT.seven });
    expect(cherry).toEqual(winningSpin('player', 'cherry', 3));
  });

  it('does not change an empty or populated summary for a miss', () => {
    const stats = createMatchStats();
    const miss: SpinView = { side: 'player', round: 1, symbols: ['cherry', 'bell', 'seven'], payout: 0, total: 0 };
    recordSpin(stats, miss);
    expect(stats).toEqual(createMatchStats());
    recordSpin(stats, winningSpin('player', 'bell', 2));
    const before = cloneMatchStats(stats);
    recordSpin(stats, { ...miss, round: 3, total: PAYOUT.bell });
    expect(stats).toEqual(before);
  });

  it('keeps each side and each match independent', () => {
    const firstMatch = createMatchStats();
    const nextMatch = createMatchStats();
    recordSpin(firstMatch, winningSpin('player', 'seven', 4));
    expect(firstMatch.rival).toEqual({ wins: { cherry: 0, bell: 0, seven: 0 }, bestSpin: null });
    expect(nextMatch).toEqual(createMatchStats());
    recordSpin(nextMatch, winningSpin('rival', 'bell', 6));
    expect(firstMatch.player.wins.seven).toBe(1);
    expect(firstMatch.rival.wins.bell).toBe(0);
    expect(nextMatch.player.bestSpin).toBeNull();
  });

  it('clones all nested data so snapshot edits cannot affect live statistics', () => {
    const original = createMatchStats();
    recordSpin(original, winningSpin('player', 'seven', 8));
    recordSpin(original, winningSpin('rival', 'bell', 10));
    const copy = cloneMatchStats(original);
    expect(copy).toEqual(original);
    copy.player.wins.seven = 20;
    copy.player.bestSpin!.round = 30;
    copy.rival.wins.bell = 15;
    copy.rival.bestSpin!.payout = 0;
    expect(original.player).toEqual({ wins: { cherry: 0, bell: 0, seven: 1 }, bestSpin: { round: 8, payout: PAYOUT.seven } });
    expect(original.rival).toEqual({ wins: { cherry: 0, bell: 1, seven: 0 }, bestSpin: { round: 10, payout: PAYOUT.bell } });

    const empty = createMatchStats();
    const emptyCopy = cloneMatchStats(empty);
    expect(emptyCopy).toEqual(empty);
    recordSpin(empty, winningSpin('player', 'cherry', 1));
    expect(emptyCopy).toEqual(createMatchStats());
  });
});
