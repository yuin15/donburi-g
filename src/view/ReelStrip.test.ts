import { describe, expect, it } from 'vitest';
import { BASE_POOL, gridFromStops } from '../domain/game';
import { buildReelStrip } from './ReelStrip';

describe('authoritative normal reel strip', () => {
  it('preserves BASE_POOL order and every stop window used by the domain grid', () => {
    const strip = buildReelStrip([]);
    expect(strip).toEqual(BASE_POOL);
    for (let first = 0; first < strip.length; first += 1) for (let second = 0; second < strip.length; second += 1) for (let third = 0; third < strip.length; third += 1) {
      const stops: [number, number, number] = [first, second, third];
      const visible = ([0, 1, 2] as const).map(row => ([first, second, third] as const).map(stop => strip[(stop + row - 1 + strip.length) % strip.length]));
      expect(visible).toEqual(gridFromStops(stops));
    }
  });

  it('keeps every upgraded strip window aligned with the domain', () => {
    for (const upgrades of [['steady'], ['jackpot'], ['steady', 'jackpot']] as const) {
      const strip = buildReelStrip(upgrades);
      for (let first = 0; first < strip.length; first += 1) for (let second = 0; second < strip.length; second += 1) for (let third = 0; third < strip.length; third += 1) {
        const stops: [number, number, number] = [first, second, third];
        const visible = ([0, 1, 2] as const).map(row => ([first, second, third] as const).map(stop => strip[(stop + row - 1 + strip.length) % strip.length]));
        expect(visible).toEqual(gridFromStops(stops, strip));
      }
    }
  });
});
