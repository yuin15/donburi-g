import type { SpinView, SymbolId } from '../../shared/protocol';
import { PAYOUT } from '../domain/game';

/** Presentation timing only. Never used to gate a spin or settle the bankroll. */
export const VICTORY_DURATION = 3000;
export function rewardSymbol(spin: SpinView): SymbolId | null {
  const firstRow = { top: 0, middle: 1, bottom: 2, diagonalDown: 0, diagonalUp: 2 } as const;
  const symbols = spin.grid && spin.winningLines?.length
    ? spin.winningLines.map(line => spin.grid![firstRow[line]][0])
    : spin.symbols.every(symbol => symbol === spin.symbols[0]) ? [spin.symbols[0]] : [];
  return symbols.reduce<SymbolId | null>((best, symbol) => !best || PAYOUT[symbol] > PAYOUT[best] ? symbol : best, null);
}

export function rewardDuration(payout: number, symbol: SymbolId | null): number {
  return symbol === 'seven' || payout >= PAYOUT.seven ? 1700 : symbol === 'bell' || (!symbol && payout >= PAYOUT.bell) ? 900 : 650;
}
