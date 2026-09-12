import type { SymbolId } from '../../shared/protocol';

export const SYMBOLS: SymbolId[] = ['cherry', 'bell', 'seven'];
export const STOP_TIMES = [820, 940, 1060] as const;
export interface ReelTravel { from: number; to: number; duration: number }

/** Display strip only. It never draws an outcome or changes the game's pool. */
export function planTravel(from: number, symbol: SymbolId, column: number): ReelTravel {
  const target = SYMBOLS.indexOf(symbol);
  return { from, to: Math.ceil((from + 7 + target) / 3) * 3 - target, duration: STOP_TIMES[column] };
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

export function settledOffset(symbol: SymbolId): number {
  return (3 - SYMBOLS.indexOf(symbol)) % 3;
}
