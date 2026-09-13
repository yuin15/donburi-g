import { describe, expect, it } from 'vitest';
import type { Side, SpinView } from '../../shared/protocol';
import { PAYOUT } from '../domain/game';
import { RivalReactions, type RivalReactionKind } from './RivalReactions';

function spin(side: Side, payout = 0, total = 30): SpinView {
  const symbols: SpinView['symbols'] = payout === PAYOUT.seven ? ['seven', 'seven', 'seven']
    : payout === PAYOUT.bell ? ['bell', 'bell', 'bell']
      : payout === PAYOUT.cherry ? ['cherry', 'cherry', 'cherry'] : ['cherry', 'bell', 'seven'];
  return { side, round: 25, symbols, payout, total };
}

describe('CPU rival reactions', () => {
  it('keeps a rival jackpot ahead of a player small hit and lead change', () => {
    const reaction = new RivalReactions().next(spin('player', 3, 30), spin('rival', 30, 1920), 10, 'rival');
    expect(reaction.kind).toBe('rival-jackpot');
    expect(reaction.expression).toBe('confident');
    expect(reaction.text).toContain('Sevens');
  });

  it('recognizes simultaneous jackpots before either individual jackpot', () => {
    const reaction = new RivalReactions().next(spin('player', 30, 60), spin('rival', 30, 30), 8, null);
    expect(reaction.kind).toBe('both-jackpot');
    expect(reaction.expression).toBe('surprised');
    expect(reaction.text).toContain('Both');
  });

  it.each(['player', 'rival'] as const)('uses the supplied confirmed %s lead change before small payouts', leader => {
    const reaction = new RivalReactions().next(spin('player', 6, leader === 'player' ? 30 : 30), spin('rival', 3, leader === 'rival' ? 30 : 30), 20, leader);
    expect(reaction.kind).toBe(`${leader}-lead`);
  });

  it('does not invent a lead change from the current score alone', () => {
    const reactions = new RivalReactions();
    expect(reactions.next(spin('player', 0, 30), spin('rival', 0, 6), 30, null).kind).toBe('quiet');
    expect(reactions.next(spin('player', 3, 32), spin('rival', 0, 6), 28, null).kind).toBe('player-win');
  });

  it.each([
    { remaining: 10, gap: 6, expected: 'close-finish' },
    { remaining: 0.1, gap: 0, expected: 'close-finish' },
    { remaining: 10.1, gap: 3, expected: 'quiet' },
    { remaining: 8, gap: 360, expected: 'quiet' },
    { remaining: 0, gap: 3, expected: 'quiet' },
  ] as const)('handles the closing window at $remaining seconds and a $gap point gap', ({ remaining, gap, expected }) => {
    const reaction = new RivalReactions().next(spin('player', 0, 30 + gap), spin('rival', 0, 30), remaining, null);
    expect(reaction.kind).toBe(expected);
  });

  it('replaces a past jackpot or comeback line on the next quiet round', () => {
    const reactions = new RivalReactions();
    const jackpot = reactions.next(spin('player', 30, 30), spin('rival', 0, 30), 24, 'player');
    const quiet = reactions.next(spin('player', 0, 30), spin('rival', 0, 30), 22, null);
    expect(quiet.kind).toBe('quiet');
    expect(quiet.text).not.toBe(jackpot.text);
    expect(quiet.expression).toBe('neutral');
  });

  const scenes: { kind: RivalReactionKind; player: number; rival: number; remaining?: number; comeback?: Side }[] = [
    { kind: 'both-jackpot', player: 30, rival: 30 },
    { kind: 'player-jackpot', player: 30, rival: 0 },
    { kind: 'rival-jackpot', player: 0, rival: 30 },
    { kind: 'player-lead', player: 6, rival: 3, comeback: 'player' },
    { kind: 'rival-lead', player: 3, rival: 6, comeback: 'rival' },
    { kind: 'both-win', player: 3, rival: 6 },
    { kind: 'player-win', player: 3, rival: 0 },
    { kind: 'rival-win', player: 0, rival: 3 },
    { kind: 'close-finish', player: 0, rival: 0, remaining: 8 },
    { kind: 'quiet', player: 0, rival: 0 },
  ];

  it.each(scenes)('varies $kind lines, avoids premature victory, and resets between matches', ({ kind, player, rival, remaining = 30, comeback = null }) => {
    const reactions = new RivalReactions();
    const playerSpin = spin('player', player, comeback === 'rival' ? 30 : 30);
    const rivalSpin = spin('rival', rival, comeback === 'player' ? 30 : 30);
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
