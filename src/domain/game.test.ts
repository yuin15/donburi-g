import { describe, expect, it } from 'vitest';
import {
  advanceMatch,
  createMatch,
  getPoolCounts,
  getSnapshot,
  startMatch,
  submitUpgrade,
} from './game';

describe('authoritative match domain', () => {
  it.each([
    { seed: 2654435761, winner: 'rival', player: 600, rival: 1680 },
    { seed: 3668339987, winner: 'player', player: 1800, rival: 240 },
    { seed: 4203543429, winner: 'draw', player: 480, rival: 480 },
    { seed: 1035485675, winner: 'player', player: 720, rival: 600, comeback: true },
  ])('replays the $winner outcome for test seed $seed', (fixture) => {
    const state = createMatch(fixture.seed, 'test-fixture');
    startMatch(state);
    for (const [index, time] of [[0, 20], [1, 40]] as const) {
      advanceMatch(state, time);
      submitUpgrade(state, 'player', index, 'steady');
      submitUpgrade(state, 'rival', index, 'jackpot');
    }
    advanceMatch(state, 50);
    if (fixture.comeback) expect(state.scores.player).toBeLessThan(state.scores.rival);
    advanceMatch(state, 60);
    expect(state.winner).toBe(fixture.winner);
    expect(state.scores).toEqual({ player: fixture.player, rival: fixture.rival });
  });
  it('runs exactly 30 rounds and resolves at 60 seconds', () => {
    const state = createMatch(123, 'm1');
    startMatch(state);
    const events = advanceMatch(state, 60);
    expect(state.round).toBe(30);
    expect(state.status).toBe('result');
    expect(state.remaining).toBe(0);
    expect(events.filter((event) => event.type === 'spin')).toHaveLength(30);
    expect(events.filter((event) => event.type === 'match_end')).toHaveLength(1);
    const ended = events.find((event) => event.type === 'match_end');
    expect(ended?.snapshot).toMatchObject({ elapsed: 60, remaining: 0, round: 30, status: 'result' });
    expect(ended?.snapshot).toEqual(getSnapshot(state));
  });

  it('is deterministic for the same seed', () => {
    const a = createMatch(777, 'a');
    const b = createMatch(777, 'b');
    startMatch(a);
    startMatch(b);
    const av = advanceMatch(a, 60).filter((event) => event.type === 'spin');
    const bv = advanceMatch(b, 60).filter((event) => event.type === 'spin');
    expect(av.map((event) => JSON.stringify(event))).toEqual(
      bv.map((event) => JSON.stringify({ ...event, seq: event.seq })),
    );
    expect(a.scores).toEqual(b.scores);
  });

  it('opens upgrades at 20/40 and applies after 24/44 boundaries', () => {
    const state = createMatch(10, 'm');
    startMatch(state);
    advanceMatch(state, 20);
    expect(state.openOffers.has(0)).toBe(true);
    expect(submitUpgrade(state, 'player', 0, 'jackpot', 20.5)).toBe(true);
    expect(submitUpgrade(state, 'player', 0, 'steady', 21)).toBe(false);
    const before = getPoolCounts(state, 'player');
    advanceMatch(state, 24);
    const after = getPoolCounts(state, 'player');
    expect(after.seven - before.seven).toBe(1);
    expect(state.upgrades.player).toEqual(['jackpot']);
    expect(state.upgrades.rival).toEqual(['steady']);
  });

  it('rejects early, late, duplicated, and post-result upgrades', () => {
    const state = createMatch(3, 'm');
    startMatch(state);
    expect(submitUpgrade(state, 'player', 0, 'steady', 19.99)).toBe(false);
    advanceMatch(state, 20);
    expect(submitUpgrade(state, 'player', 0, 'steady', 20.1)).toBe(true);
    expect(submitUpgrade(state, 'player', 0, 'jackpot', 20.2)).toBe(false);
    advanceMatch(state, 24);
    expect(submitUpgrade(state, 'rival', 0, 'jackpot', 24)).toBe(false);
    advanceMatch(state, 60);
    expect(submitUpgrade(state, 'player', 1, 'steady', 40)).toBe(false);
  });

  it('catches up after a delayed timer without duplicated rounds', () => {
    const state = createMatch(55, 'm');
    startMatch(state);
    const first = advanceMatch(state, 37.8);
    const second = advanceMatch(state, 59.9);
    const final = advanceMatch(state, 60);
    const spins = [...first, ...second, ...final].filter((event) => event.type === 'spin');
    expect(spins).toHaveLength(30);
    expect(new Set(spins.map((event) => event.player.round)).size).toBe(30);
  });

  it('returns a client-safe snapshot without hidden reel or rng state', () => {
    const state = createMatch(99, 'safe');
    const snapshot = getSnapshot(state);
    expect(snapshot.matchId).toBe('safe');
    expect('rngState' in snapshot).toBe(false);
    expect('pools' in snapshot).toBe(false);
  });
});
