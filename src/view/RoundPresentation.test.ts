import { describe, expect, it, vi } from 'vitest';
import type { MatchSnapshot, SpinView } from '../../shared/protocol';
import { RoundPresentation } from './RoundPresentation';

const spin = (round: number, total = 120): SpinView => ({ round, total, side: 'player', payout: 120, symbols: ['cherry', 'cherry', 'cherry'] });
const end = (round = 30): MatchSnapshot => ({ matchId: 'test', status: 'result', elapsed: 60, remaining: 0, round, scores: { player: 3600, rival: 3480 }, upgrades: { player: ['steady', 'jackpot'], rival: ['steady', 'steady'] }, winner: 'player', eventSeq: 70 });

function setup() {
  const stopped: Array<(celebrate?: boolean) => void> = [];
  const settled = vi.fn(), ended = vi.fn();
  const presenter = new RoundPresentation({ play: (_p, _r, done) => { stopped.push(done); }, settled, ended });
  return { presenter, stopped, settled, ended };
}

describe('round presentation', () => {
  it('keeps both scores until the stop, then reveals them atomically', () => {
    const { presenter, stopped, settled } = setup();
    const p = spin(1, 1200), r = spin(1, 1320);
    presenter.spin(p, r);
    expect(presenter.scores).toEqual({ player: 0, rival: 0 });
    expect(settled).not.toHaveBeenCalled();
    stopped[0]();
    expect(presenter.scores).toEqual({ player: 1200, rival: 1320 });
    expect(settled).toHaveBeenCalledWith(p, r, true);
  });
  it('holds the 60-second result until round 30 stops, then emits it only once', () => {
    const { presenter, stopped, ended } = setup();
    presenter.spin(spin(30, 3600), spin(30, 3480));
    presenter.end(end());
    expect(ended).not.toHaveBeenCalled();
    stopped[0]();
    expect(ended).toHaveBeenCalledExactlyOnceWith(end());
    presenter.end(end());
    stopped[0]();
    expect(ended).toHaveBeenCalledOnce();
    expect(presenter.spin(spin(31), spin(31))).toBe(false);
  });
  it('discards delayed callbacks and invalid or repeated round pairs', () => {
    const { presenter, stopped, settled } = setup();
    presenter.spin(spin(1), spin(1));
    presenter.spin(spin(15, 3000), spin(15, 1200));
    expect(presenter.spin(spin(14), spin(14))).toBe(false);
    expect(presenter.spin(spin(15), spin(15))).toBe(false);
    expect(presenter.spin(spin(16), spin(17))).toBe(false);
    stopped[0]();
    expect(settled).not.toHaveBeenCalled();
    stopped[1](false);
    expect(settled).toHaveBeenCalledOnce();
    expect(settled.mock.calls[0][2]).toBe(false);
    expect(presenter.scores).toEqual({ player: 3000, rival: 1200 });
  });
  it('reset cancels old wins/results and allows a fresh round 1', () => {
    const { presenter, stopped, ended, settled } = setup();
    presenter.spin(spin(30), spin(30));
    presenter.end(end());
    presenter.reset();
    stopped[0]();
    expect(ended).not.toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();
    expect(presenter.scores).toEqual({ player: 0, rival: 0 });
    expect(presenter.spin(spin(1), spin(1))).toBe(true);
    stopped[1]();
    expect(settled).toHaveBeenCalledOnce();
  });
});
