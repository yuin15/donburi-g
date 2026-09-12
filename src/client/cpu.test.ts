import { afterEach, expect, it, vi } from 'vitest';
import { advanceMatch, createMatch, startMatch } from '../domain/game';
import { submitCpuUpgrade } from './cpu';

afterEach(() => vi.restoreAllMocks());

it.each(['player', 'rival'] as const)('uses actual input time for %s at both deadlines even when ticks stall', side => {
  for (const [index, open, close] of [[0, 20, 24], [1, 40, 44]] as const) {
    for (const offset of [-1, 0, 1, 5000]) {
      const state = createMatch(55, 'deadline');
      startMatch(state);
      advanceMatch(state, open);
      const startedAt = 700_000;
      vi.spyOn(performance, 'now').mockReturnValue(startedAt + close * 1000 + offset);
      const accepted = submitCpuUpgrade(state, side, index, 'jackpot', startedAt);
      expect(accepted).toBe(offset < 0);
      expect(state.elapsed).toBe(open); // No intervening timer tick.
      advanceMatch(state, close);
      expect(state.upgrades[side][index]).toBe(offset < 0 ? 'jackpot' : 'steady');
    }
  }
});

it('locks the first valid choice without changing spin results on a duplicate input', () => {
  const state = createMatch(55, 'duplicate');
  startMatch(state);
  advanceMatch(state, 20);
  vi.spyOn(performance, 'now').mockReturnValue(21_000);
  const scores = { ...state.scores };
  const rng = { ...state.rngState };
  expect(submitCpuUpgrade(state, 'player', 0, 'jackpot', 0)).toBe(true);
  expect(submitCpuUpgrade(state, 'player', 0, 'steady', 0)).toBe(false);
  expect(state.scores).toEqual(scores);
  expect(state.rngState).toEqual(rng);
  advanceMatch(state, 24);
  expect(state.upgrades.player).toEqual(['jackpot']);
});

it('uses the new match clock after rematch and never reopens a finished match', () => {
  const old = createMatch(1, 'old');
  startMatch(old);
  advanceMatch(old, 60);
  const fresh = createMatch(2, 'fresh');
  startMatch(fresh);
  advanceMatch(fresh, 20);
  vi.spyOn(performance, 'now').mockReturnValue(121_000);
  expect(submitCpuUpgrade(old, 'player', 0, 'jackpot', 100_000)).toBe(false);
  expect(submitCpuUpgrade(fresh, 'player', 0, 'jackpot', 100_000)).toBe(true);
  advanceMatch(fresh, 24);
  expect(fresh.upgrades.player).toEqual(['jackpot']);
  expect(old.upgrades.player).toEqual(['steady', 'steady']);
});
