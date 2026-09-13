import { describe, expect, it } from 'vitest';
import {
  advanceMatch,
  applyTimeExtension,
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
    { seed: 2654435761, winner: 'rival', player: 15, rival: 42 },
    { seed: 3668339987, winner: 'player', player: 45, rival: 6 },
    { seed: 4203543429, winner: 'draw', player: 12, rival: 12 },
    { seed: 1035485675, winner: 'player', player: 18, rival: 15, comeback: true },
  ])('replays the $winner outcome for test seed $seed', (fixture) => {
    const state = createMatch(fixture.seed, 'test-fixture', 'automatic', { upgrades: true });
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
    const state = createMatch(10, 'm', 'automatic', { upgrades: true });
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
    const state = createMatch(3, 'm', 'automatic', { upgrades: true });
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
      expect(snapshot.scores[side]).toBe(30 - snapshot.rounds[side] + total);
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

  it('authoritatively grants one late +10 second extension and then finishes at 70 seconds', () => {
    const state = createMatch(123, 'extended', 'manual');
    startMatch(state);
    advanceMatch(state, 54.25);
    const event = applyTimeExtension(state);
    expect(event).toMatchObject({ type: 'time_extended', before: { duration: 60 }, after: { duration: 70 } });
    expect(state.remaining).toBeCloseTo(15.75);
    expect(applyTimeExtension(state)).toBeNull();
    const end = advanceMatch(state, 70).find(candidate => candidate.type === 'match_end');
    expect(end).toMatchObject({ snapshot: { elapsed: 70, duration: 70, remaining: 0, status: 'result' } });
  });

  it('does not extend early, after the result, or beyond the one permitted change', () => {
    const state = createMatch(123, 'guarded');
    startMatch(state);
    advanceMatch(state, 44.9);
    expect(applyTimeExtension(state)).toBeNull();
    advanceMatch(state, 60);
    expect(applyTimeExtension(state)).toBeNull();
  });
});

describe('independent manual match authority', () => {
  it('keeps base reels, accepts up to 55 player spins, and automatically draws 30 rival spins', () => {
    const state = createMatch(123, 'base-duel', 'manual');
    const base = structuredClone(state.pools);
    startMatch(state);
    const events = [];
    for (let round = 0; round < 55; round++) {
      const elapsed = round * MANUAL_SPIN_INTERVAL;
      events.push(...requestManualSpin(state, elapsed));
      expect(submitUpgrade(state, 'player', elapsed < 40 ? 0 : 1, 'jackpot', elapsed)).toBe(false);
      expect(submitUpgrade(state, 'rival', elapsed < 40 ? 0 : 1, 'steady', elapsed)).toBe(false);
      expect(state.pools).toEqual(base);
      expect(state.activePools).toEqual(base);
    }
    events.push(...advanceMatch(state, 60));
    expect(events.some(event => event.type === 'upgrade_open' || event.type === 'upgrade_applied')).toBe(false);
    expect(getSnapshot(state)).toMatchObject({ status: 'result', rounds: { player: 55, rival: 30 }, upgrades: { player: [], rival: [] } });
  });

  it('runs the rival every two seconds while an idle player never consumes a draw or gains coins', () => {
    const state = createMatch(123, 'manual-idle', 'manual');
    const playerRng = state.rngState.player;
    expect(requestManualSpin(state, 0)).toEqual([]);
    startMatch(state);
    const events = advanceMatch(state, 60);
    const spins = events.filter(event => event.type === 'side_spin');
    expect(spins).toHaveLength(30);
    expect(spins.map(event => event.at)).toEqual(Array.from({ length: 30 }, (_, i) => (i + 1) * 2));
    expect(spins.every(event => event.spin.side === 'rival')).toBe(true);
    expect(state).toMatchObject({ round: 0, rounds: { player: 0, rival: 30 }, status: 'result', winner: 'player', scores: { player: 30 }, rngState: { player: playerRng } });
    expect(state.scores.rival).toBeGreaterThan(0);
    expect(state.stats.player).toEqual(getSnapshot(createMatch()).stats.player);
  });

  it('player spam cannot create extra rival spins, change its random sequence, or bypass the player cooldown', () => {
    const clicked = createMatch(777, 'clicked', 'manual');
    const idle = createMatch(777, 'idle', 'manual');
    startMatch(clicked); startMatch(idle);
    for (let n = 0; n < 550; n++) requestManualSpin(clicked, n / 10);
    advanceMatch(clicked, 60); advanceMatch(idle, 60);
    expect(clicked.rounds).toEqual({ player: 50, rival: 30 });
    expect(clicked.rngState.rival).toBe(idle.rngState.rival);
    expect(clicked.scores.rival).toBe(idle.scores.rival);
    expect(clicked.stats.rival).toEqual(idle.stats.rival);
  });

  it('accepts an immediate click and exact 1.1s boundaries without coupling the other side', () => {
    const state = createMatch(777, 'cooldown', 'manual');
    startMatch(state);
    const rivalRng = state.rngState.rival;
    expect(requestManualSpin(state, 0).filter(e => e.type === 'side_spin').map(e => e.spin.side)).toEqual(['player']);
    expect(requestManualSpin(state, 1.099)).toEqual([]);
    expect(requestManualSpin(state, 1.1).filter(e => e.type === 'side_spin').map(e => e.spin.side)).toEqual(['player']);
    expect(state.rngState.rival).toBe(rivalRng);
    expect(requestManualSpin(state, 1.1)).toEqual([]);
    expect(advanceMatch(state, 2).filter(e => e.type === 'side_spin').map(e => e.spin.side)).toEqual(['rival']);
    expect(state.rounds).toEqual({ player: 2, rival: 1 });
  });

  it('rejects a player spin with no cash without advancing the round or charging again', () => {
    const state = createMatch(777, 'no-funds', 'manual');
    startMatch(state);
    state.scores.player = 0;
    const rng = state.rngState.player;
    expect(requestManualSpin(state, 0)).toEqual([]);
    expect(state.rounds.player).toBe(0);
    expect(state.scores.player).toBe(0);
    expect(state.rngState.player).toBe(rng);
  });

  it('settles the last scheduled rival spin at 60s, while rejecting deadline and later player clicks', () => {
    const state = createMatch(123, 'last-click', 'manual');
    startMatch(state);
    requestManualSpin(state, 59.99);
    const playerRng = state.rngState.player;
    const events = requestManualSpin(state, 60);
    expect(events.filter(e => e.type === 'side_spin').map(e => e.spin.side)).toEqual(['rival']);
    expect(state.rounds).toEqual({ player: 1, rival: 30 });
    expect(state.rngState.player).toBe(playerRng);
    const ended = events.find(e => e.type === 'match_end');
    expect(ended?.snapshot).toEqual(getSnapshot(state));
    expect(requestManualSpin(state, 100)).toEqual([]);
  });
});
