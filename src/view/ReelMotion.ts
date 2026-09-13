import type { SymbolId } from '../../shared/protocol';

export const SYMBOLS: SymbolId[] = ['cherry', 'bell', 'seven'];
export const STOP_TIMES = [820, 940, 1060] as const;
export interface ReelTravel { from: number; to: number; duration: number }

/** Display strip only. It never draws an outcome or changes the game's pool. */
export function planTravel(from: number, symbol: SymbolId, column: number, strip: readonly SymbolId[] = SYMBOLS): ReelTravel {
  let to = Infinity;
  strip.forEach((candidate, index) => {
    if (candidate === symbol) to = Math.min(to, Math.ceil((from + 7 + index) / strip.length) * strip.length - index);
  });
  if (!Number.isFinite(to)) throw new Error('Requested symbol is missing from the display strip.');
  return { from, to, duration: STOP_TIMES[column] };
}

/** Stop on the authoritative strip index, so the visible neighbours match the scored grid. */
export function planTravelToStop(from: number, stop: number, column: number, strip: readonly SymbolId[]): ReelTravel {
  let to = -stop;
  while (to < from + 7) to += strip.length;
  return { from, to, duration: STOP_TIMES[column] };
}

/** Positive travel means screen-down; acceleration, cruise, then a soft stop. */
export function travelAt(travel: ReelTravel, elapsed: number): number {
  const t = Math.min(1, Math.max(0, elapsed / travel.duration));
  const acceleration = 0.16;
  const deceleration = 0.48;
  const area = 1 - (acceleration + deceleration) / 2;
  const distance = t < acceleration ? t * t / (2 * acceleration)
    : t < 1 - deceleration ? t - acceleration / 2
      : area - (1 - t) ** 2 / (2 * deceleration);
  return travel.from + (travel.to - travel.from) * distance / area;
}

export function settledOffset(symbol: SymbolId, strip: readonly SymbolId[] = SYMBOLS): number {
  return (strip.length - strip.indexOf(symbol)) % strip.length;
}

export function symbolAtOffset(offset: number, strip: readonly SymbolId[] = SYMBOLS): SymbolId {
  const index = Math.floor(-offset + .5);
  return strip[((index % strip.length) + strip.length) % strip.length];
}
