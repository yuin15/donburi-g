import { describe, expect, it, vi } from 'vitest';
import type { Side, SpinView } from '../../shared/protocol';
import { createMatch, getSnapshot } from '../domain/game';
import { RoundPresentation } from './RoundPresentation';

const spin = (side: Side, round: number, total = 120): SpinView => ({ round, total, side, payout: 120, symbols: ['cherry', 'cherry', 'cherry'] });
function end(player = 4, rival = 30) {
  const snapshot = getSnapshot(createMatch(1, 'test'));
  return { ...snapshot, status: 'result' as const, elapsed: 60, remaining: 0, round: player, rounds: { player, rival }, scores: { player: 480, rival: 3480 }, winner: 'rival' as const };
}
function setup() {
  const stopped: Array<(celebrate?: boolean) => void> = [];
  const settled = vi.fn(), ended = vi.fn();
  const presenter = new RoundPresentation({ play: (_spin, done) => { stopped.push(done); }, settled, ended });
  return { presenter, stopped, settled, ended };
}
describe('independent spin presentation', () => {
  it('keeps a purchase deducted when an older spin stops or is recovered', () => {
    const { presenter, stopped } = setup();
    presenter.reset({ player: 30, rival: 30 });
    presenter.spin({ ...spin('player', 1, 32), payout: 3, upgradeSpent: 0 });
    expect(presenter.scores.player).toBe(29);
    presenter.syncPurchases(5);
    expect(presenter.scores.player).toBe(24);
    stopped[0]();
    expect(presenter.scores.player).toBe(27);
    presenter.syncPurchases(5);
    expect(presenter.scores.player).toBe(27);
    presenter.spin({ ...spin('player', 2, 26), payout: 0, upgradeSpent: 5 });
    stopped[1]();
    expect(presenter.scores.player).toBe(26);
  });
  it('reveals only the side that stopped, regardless of overlapping start order', () => {
    const { presenter, stopped, settled } = setup();
    const p = spin('player', 4, 480), r = spin('rival', 15, 1320);
    presenter.spin(p); presenter.spin(r);
    expect(presenter.scores).toEqual({ player: p.total - p.payout, rival: r.total - r.payout });
    stopped[1]();
    expect(presenter.scores).toEqual({ player: p.total - p.payout, rival: r.total });
    expect(settled).toHaveBeenCalledExactlyOnceWith(r, true);
    stopped[0]();
    expect(presenter.scores).toEqual({ player: 480, rival: 1320 });
  });
  it('holds the final result until both different final counts have stopped, then ends once', () => {
    const { presenter, stopped, ended } = setup();
    presenter.spin(spin('player', 4, 480)); presenter.spin(spin('rival', 30, 3480));
    presenter.end(end());
    stopped[1]();
    expect(ended).not.toHaveBeenCalled();
    stopped[0]();
    expect(ended).toHaveBeenCalledExactlyOnceWith(end());
    presenter.end(end()); stopped[1]();
    expect(ended).toHaveBeenCalledOnce();
    expect(presenter.spin(spin('rival', 31))).toBe(false);
  });
  it('finishes after the rival stop even when the player never spun', () => {
    const { presenter, stopped, ended } = setup();
    presenter.spin(spin('rival', 30, 3480));
    presenter.end(end(0));
    expect(ended).not.toHaveBeenCalled();
    stopped[0]();
    expect(ended).toHaveBeenCalledOnce();
  });
  it('supersedes only older animations from the same side and rejects duplicate stops', () => {
    const { presenter, stopped, settled } = setup();
    presenter.spin(spin('player', 1)); presenter.spin(spin('rival', 1));
    presenter.spin(spin('rival', 15, 1200));
    expect(presenter.spin(spin('rival', 14))).toBe(false);
    expect(presenter.spin(spin('rival', 15))).toBe(false);
    stopped[1]();
    expect(settled).not.toHaveBeenCalled();
    stopped[0](); stopped[2](false); stopped[2]();
    expect(settled).toHaveBeenCalledTimes(2);
    expect(settled.mock.calls[1][1]).toBe(false);
    expect(presenter.scores).toEqual({ player: 120, rival: 1200 });
  });
  it('reset cancels both old callbacks and results and accepts a fresh first spin', () => {
    const { presenter, stopped, ended, settled } = setup();
    presenter.spin(spin('player', 4)); presenter.spin(spin('rival', 30));
    presenter.end(end()); presenter.reset(); stopped[0](); stopped[1]();
    expect(ended).not.toHaveBeenCalled(); expect(settled).not.toHaveBeenCalled();
    expect(presenter.scores).toEqual({ player: 0, rival: 0 });
    expect(presenter.spin(spin('rival', 1))).toBe(true);
    stopped[2]();
    expect(settled).toHaveBeenCalledOnce();
  });
});
