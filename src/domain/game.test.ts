import { describe, expect, it } from 'vitest';
import {
  advanceMatch,
  createMatch,
  getPoolCounts,
  getSnapshot,
  MANUAL_SPIN_INTERVAL,
  PAYOUT,
  requestManualSpin,
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

  it('retains all 30 rounds of statistics when the consumer only renders the final spin', () => {
    const state = createMatch(123, 'catchup-stats');
    startMatch(state);
    const events = advanceMatch(state, 60);
    const spins = events.filter(event => event.type === 'spin');
    const snapshot = getSnapshot(state);
    expect(snapshot.round).toBe(30);
    for (const side of ['player', 'rival'] as const) {
      const history = spins.map(event => event[side]);
      for (const symbol of ['cherry', 'bell', 'seven'] as const) {
        expect(snapshot.stats[side].wins[symbol]).toBe(history.filter(spin => spin.payout === PAYOUT[symbol]).length);
      }
      const total = snapshot.stats[side].wins.cherry * PAYOUT.cherry + snapshot.stats[side].wins.bell * PAYOUT.bell + snapshot.stats[side].wins.seven * PAYOUT.seven;
      expect(total).toBe(snapshot.scores[side]);
    }
    const ended = events.find(event => event.type === 'match_end');
    expect(ended?.snapshot.stats).toEqual(snapshot.stats);
    expect(advanceMatch(state, 60)).toEqual([]);
    expect(getSnapshot(state).stats).toEqual(snapshot.stats);
  });

  it('deeply isolates snapshot statistics from later spins, consumer edits, and another match', () => {
    const state = createMatch(123, 'stats-snapshot');
    startMatch(state);
    advanceMatch(state, 30);
    const earlier = getSnapshot(state);
    const frozenEarlier = structuredClone(earlier);
    advanceMatch(state, 60);
    expect(earlier).toEqual(frozenEarlier);

    const snapshot = getSnapshot(state);
    const expected = structuredClone(state.stats);
    snapshot.stats.player.wins.cherry += 10;
    snapshot.stats.rival.wins.seven += 5;
    if (snapshot.stats.player.bestSpin) snapshot.stats.player.bestSpin.round = 30;
    if (snapshot.stats.rival.bestSpin) snapshot.stats.rival.bestSpin.payout = 0;
    expect(state.stats).toEqual(expected);
    expect(getSnapshot(state).stats).toEqual(expected);
    expect(getSnapshot(createMatch(123, 'next')).stats).toEqual({
      player: { wins: { cherry: 0, bell: 0, seven: 0 }, bestSpin: null },
      rival: { wins: { cherry: 0, bell: 0, seven: 0 }, bestSpin: null },
    });
  });

  it('returns a client-safe snapshot without hidden reel or rng state', () => {
    const state = createMatch(99, 'safe');
    const snapshot = getSnapshot(state);
    expect(snapshot.matchId).toBe('safe');
    expect('rngState' in snapshot).toBe(false);
    expect('pools' in snapshot).toBe(false);
  });
});

describe('manual match authority', () => {
  it('advances deadlines and ends without drawing when no spin is requested', () => {
    const state = createMatch(123, 'manual-idle', 'manual');
    const rng = { ...state.rngState };
    expect(state.lastManualSpinAt).toBeNull();
    expect(requestManualSpin(state, 0)).toEqual([]);
    startMatch(state);
    const events = advanceMatch(state, 60);
    expect(events.filter(event => event.type === 'spin')).toHaveLength(0);
    expect(events.filter(event => event.type === 'upgrade_applied')).toHaveLength(2);
    expect(events.filter(event => event.type === 'match_end')).toHaveLength(1);
    expect(state).toMatchObject({ round: 0, status: 'result', winner: 'draw', scores: { player: 0, rival: 0 }, rngState: rng });
    expect(getSnapshot(state).stats).toEqual(getSnapshot(createMatch()).stats);

    const automatic = createMatch(123, 'automatic');
    startMatch(automatic);
    expect(requestManualSpin(automatic, 0)).toEqual([]);
    expect(automatic.round).toBe(0);
  });

  it('accepts an immediate first spin and exact intervals without letting repeated clicks consume random draws', () => {
    const clicked = createMatch(777, 'clicked', 'manual');
    const paced = createMatch(777, 'paced', 'manual');
    startMatch(clicked);
    startMatch(paced);
    for (const time of [0, MANUAL_SPIN_INTERVAL, 2.2, 3.3]) {
      if (time > 0) {
        const rng = { ...clicked.rngState };
        expect(requestManualSpin(clicked, time - 0.001)).toEqual([]);
        expect(clicked.rngState).toEqual(rng);
      }
      const events = requestManualSpin(clicked, time);
      expect(events).toEqual(requestManualSpin(paced, time));
      const spins = events.filter(event => event.type === 'spin');
      expect(spins).toHaveLength(1);
      expect(spins[0].player.round).toBe(spins[0].rival.round);
      expect(clicked.lastManualSpinAt).toBe(time);
      expect(requestManualSpin(clicked, time)).toEqual([]);
    }
    expect(clicked.round).toBe(4);
    expect(clicked.rngState).toEqual(paced.rngState);
    expect(clicked.scores).toEqual(paced.scores);
    expect(clicked.stats).toEqual(paced.stats);
  });

  it('returns the final deadline events but never draws at or after 60 seconds', () => {
    const state = createMatch(123, 'last-click', 'manual');
    startMatch(state);
    expect(requestManualSpin(state, 59.99).filter(event => event.type === 'spin')).toHaveLength(1);
    const rng = { ...state.rngState };
    const events = requestManualSpin(state, 60);
    expect(events.map(event => event.type)).toEqual(['match_end']);
    expect(state.status).toBe('result');
    expect(state.round).toBe(1);
    expect(state.rngState).toEqual(rng);
    const ended = events.find(event => event.type === 'match_end');
    expect(ended?.snapshot).toEqual(getSnapshot(state));
    expect(requestManualSpin(state, 100)).toEqual([]);
  });

  it('applies confirmed upgrades before a boundary click and keeps each spin composition independent', () => {
    const state = createMatch(10, 'manual-upgrades', 'manual');
    startMatch(state);
    advanceMatch(state, 20);
    expect(submitUpgrade(state, 'player', 0, 'jackpot', 20.5)).toBe(true);
    const before = requestManualSpin(state, 22.9).find(event => event.type === 'spin');
    expect(before?.player.upgrades).toEqual([]);
    expect(before?.rival.upgrades).toEqual([]);

    const boundary = requestManualSpin(state, 24);
    expect(boundary[0].type).toBe('upgrade_applied');
    const applied = boundary.find(event => event.type === 'spin');
    expect(applied?.player.upgrades).toEqual(['jackpot']);
    expect(applied?.rival.upgrades).toEqual(['steady']);
    expect(getPoolCounts(state, 'player')).toEqual({ cherry: 4, bell: 3, seven: 3 });
    expect(getPoolCounts(state, 'rival')).toEqual({ cherry: 10, bell: 3, seven: 2 });

    requestManualSpin(state, 43.5);
    const rng = { ...state.rngState };
    expect(requestManualSpin(state, 44).map(event => event.type)).toEqual(['upgrade_applied']);
    expect(state.rngState).toEqual(rng);
    const later = requestManualSpin(state, 44.6).find(event => event.type === 'spin');
    expect(later?.player.upgrades).toEqual(['jackpot', 'steady']);
    expect(later?.rival.upgrades).toEqual(['steady', 'steady']);
    expect(before?.player.upgrades).toEqual([]);
    expect(applied?.player.upgrades).toEqual(['jackpot']);
    applied!.player.upgrades![0] = 'steady';
    expect(state.upgrades.player).toEqual(['jackpot', 'steady']);
    expect(later?.player.upgrades).toEqual(['jackpot', 'steady']);
  });
});
