import { describe, expect, it } from 'vitest';
import type { UpgradeId } from '../../shared/protocol';
import { planTravel, settledOffset, symbolAtOffset, SYMBOLS, travelAt } from './ReelMotion';
import { buildReelStrip, MAX_REEL_STRIP_LENGTH } from './ReelStrip';

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

  it('displays the public symbol counts after either or both upgrades', () => {
    const builds: [UpgradeId[], number[]][] = [
      [[], [4, 3, 2]],
      [['steady'], [10, 3, 2]],
      [['jackpot'], [4, 3, 3]],
      [['steady', 'steady'], [16, 3, 2]],
      [['steady', 'jackpot'], [10, 3, 3]],
      [['jackpot', 'steady'], [10, 3, 3]],
      [['jackpot', 'jackpot'], [4, 3, 4]],
    ];
    for (const [upgrades, expected] of builds) {
      const strip = buildReelStrip(Object.freeze(upgrades));
      expect(strip.length).toBeLessThanOrEqual(MAX_REEL_STRIP_LENGTH);
      const displayed = strip.map((_, index) => symbolAtOffset(-index, strip));
      expect(SYMBOLS.map(symbol => displayed.filter(cell => cell === symbol).length)).toEqual(expected);
      for (const symbol of SYMBOLS) expect(symbolAtOffset(settledOffset(symbol, strip), strip)).toBe(symbol);
    }
  });

  it('chooses the nearest matching stop after seven cells without full-strip laps', () => {
    const builds: UpgradeId[][] = [[], ['steady'], ['jackpot'], ['steady', 'steady'], ['steady', 'jackpot'], ['jackpot', 'jackpot']];
    for (const upgrades of builds) {
      const strip = buildReelStrip(upgrades);
      for (const from of [0, .7, 2, 12.42, 1000]) for (const symbol of SYMBOLS) {
        const plan = planTravel(from, symbol, 0, strip);
        expect(plan.to - from).toBeGreaterThanOrEqual(7);
        expect(plan.to - from).toBeLessThanOrEqual(18);
        expect(symbolAtOffset(plan.to, strip)).toBe(symbol);
        for (let offset = Math.ceil(from + 7); offset < plan.to; offset += 1) {
          expect(symbolAtOffset(offset, strip)).not.toBe(symbol);
        }
        expect(travelAt(plan, 0)).toBe(from);
        expect(travelAt(plan, plan.duration)).toBeCloseTo(plan.to);
      }
    }
  });
});
