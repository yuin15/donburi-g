import { describe, expect, it } from 'vitest';
import { planTravel, settledOffset, SYMBOLS, travelAt } from './ReelMotion';

describe('continuous downward reel motion', () => {
  it.each([30, 60, 120])('moves only down at %i Hz and settles on every requested symbol', hz => {
    for (const from of [0, 0.7, 2, 12.42]) for (const symbol of SYMBOLS) for (const column of [0, 1, 2]) {
      const travel = planTravel(from, symbol, column);
      let previous = from;
      for (let elapsed = 0; elapsed <= 1300; elapsed += 1000 / hz) {
        const position = travelAt(travel, elapsed);
        expect(position).toBeGreaterThanOrEqual(previous - 1e-10);
        previous = position;
      }
      expect(previous).toBeCloseTo(travel.to);
      expect(((travel.to % 3) + 3) % 3).toBe(settledOffset(symbol));
    }
  });
  it('accelerates, cruises, decelerates, and stops left to right', () => {
    const plans = [0, 1, 2].map(i => planTravel(0, 'seven', i));
    expect(plans.map(p => p.duration)).toEqual([820, 940, 1060]);
    const p = plans[0];
    const speed = (t: number) => travelAt(p, t + 1) - travelAt(p, t);
    expect(speed(10)).toBeLessThan(speed(100));
    expect(speed(200)).toBeCloseTo(speed(300));
    expect(speed(750)).toBeLessThan(speed(600));
    expect(speed(819)).toBeLessThan(0.001);
    expect(travelAt(p, -5)).toBe(0);
    expect(travelAt(p, 5000)).toBe(p.to);
  });
});
