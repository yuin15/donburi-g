import { describe, expect, it } from 'vitest';
import type { Side, SpinView } from '../../shared/protocol';
import { PAYOUT } from '../domain/game';
import { RivalReactions, type RivalReactionKind } from './RivalReactions';

function spin(side: Side, payout = 0, total = 960): SpinView {
  const symbols: SpinView['symbols'] = payout === PAYOUT.seven ? ['seven', 'seven', 'seven']
    : payout === PAYOUT.bell ? ['bell', 'bell', 'bell']
      : payout === PAYOUT.cherry ? ['cherry', 'cherry', 'cherry'] : ['cherry', 'bell', 'seven'];
  return { side, round: 25, symbols, payout, total };
}

describe('CPU rival reactions', () => {
  it('keeps a rival jackpot ahead of a player small hit and lead change', () => {
    const reaction = new RivalReactions().next(spin('player', PAYOUT.cherry, 96), spin('rival', PAYOUT.seven, 126), 10, 'rival');
    expect(reaction.kind).toBe('rival-jackpot');
    expect(reaction.expression).toBe('ecstatic');
    expect(reaction.text).toContain('Sevens');
  });

  it('recognizes simultaneous jackpots before either individual jackpot', () => {
    const reaction = new RivalReactions().next(spin('player', PAYOUT.seven, 126), spin('rival', PAYOUT.seven, 120), 8, null);
    expect(reaction.kind).toBe('both-jackpot');
    expect(reaction.expression).toBe('surprised');
    expect(reaction.text).toContain('Both');
  });

  it.each(['player', 'rival'] as const)('uses the supplied confirmed %s lead change before small payouts', leader => {
    const reaction = new RivalReactions().next(spin('player', PAYOUT.bell, leader === 'player' ? 106 : 94), spin('rival', PAYOUT.cherry, leader === 'rival' ? 106 : 94), 20, leader);
    expect(reaction.kind).toBe(`${leader}-lead`);
  });

  it('does not invent a lead change from the current score alone', () => {
    const reactions = new RivalReactions();
    expect(reactions.next(spin('player', 0, 100), spin('rival', 0, 94), 30, null).kind).toBe('quiet');
    expect(reactions.next(spin('player', PAYOUT.cherry, 103), spin('rival', 0, 94), 28, null).kind).toBe('player-win');
  });

  it.each([
    { remaining: 10, gap: PAYOUT.bell, expected: 'close-finish' },
    { remaining: 0.1, gap: 0, expected: 'close-finish' },
    { remaining: 10.1, gap: PAYOUT.cherry, expected: 'quiet' },
    { remaining: 8, gap: PAYOUT.seven, expected: 'quiet' },
    { remaining: 0, gap: PAYOUT.cherry, expected: 'quiet' },
  ] as const)('handles the closing window at $remaining seconds and a $gap point gap', ({ remaining, gap, expected }) => {
    const reaction = new RivalReactions().next(spin('player', 0, 100 + gap), spin('rival', 0, 100), remaining, null);
    expect(reaction.kind).toBe(expected);
  });

  it('replaces a past jackpot or comeback line on the next quiet round', () => {
    const reactions = new RivalReactions();
    const jackpot = reactions.next(spin('player', PAYOUT.seven, 130), spin('rival', 0, 100), 24, 'player');
    const quiet = reactions.next(spin('player', 0, 130), spin('rival', 0, 100), 22, null);
    expect(quiet.kind).toBe('quiet');
    expect(quiet.text).not.toBe(jackpot.text);
    expect(quiet.expression).toBe('wry-smile');
  });

  const scenes: { kind: RivalReactionKind; player: number; rival: number; remaining?: number; comeback?: Side }[] = [
    { kind: 'both-jackpot', player: PAYOUT.seven, rival: PAYOUT.seven },
    { kind: 'player-jackpot', player: PAYOUT.seven, rival: 0 },
    { kind: 'rival-jackpot', player: 0, rival: PAYOUT.seven },
    { kind: 'player-lead', player: PAYOUT.bell, rival: PAYOUT.cherry, comeback: 'player' },
    { kind: 'rival-lead', player: PAYOUT.cherry, rival: PAYOUT.bell, comeback: 'rival' },
    { kind: 'both-win', player: PAYOUT.cherry, rival: PAYOUT.bell },
    { kind: 'player-win', player: PAYOUT.cherry, rival: 0 },
    { kind: 'rival-win', player: 0, rival: PAYOUT.cherry },
    { kind: 'close-finish', player: 0, rival: 0, remaining: 8 },
    { kind: 'quiet', player: 0, rival: 0 },
  ];

  it.each(scenes)('varies $kind lines, avoids premature victory, and resets between matches', ({ kind, player, rival, remaining = 30, comeback = null }) => {
    const reactions = new RivalReactions();
    const playerSpin = spin('player', player, comeback === 'rival' ? 106 : 112);
    const rivalSpin = spin('rival', rival, comeback === 'player' ? 106 : 112);
    const inputsBefore = structuredClone([playerSpin, rivalSpin]);
    const first = reactions.next(playerSpin, rivalSpin, remaining, comeback);
    expect(first.kind).toBe(kind);
    let previous = first.text;
    for (let round = 0; round < 6; round += 1) {
      const reaction = reactions.next(playerSpin, rivalSpin, remaining, comeback);
      expect(reaction.kind).toBe(kind);
      expect(reaction.text).not.toBe(previous);
      expect(reaction.text).not.toMatch(/I win|I won|you lost|victory|game over/i);
      previous = reaction.text;
    }
    expect([playerSpin, rivalSpin]).toEqual(inputsBefore);
    reactions.reset();
    expect(reactions.next(playerSpin, rivalSpin, remaining, comeback)).toEqual(first);
  });
});
