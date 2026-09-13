import { describe, expect, it } from 'vitest';
import type { Bet, MatchSnapshot, ServerEnvelope, ServerMessage, SpinView } from './protocol';
import { parseServerEnvelope } from './wire';
import { evaluateGrid, gridFromStops } from '../src/domain/game';

function envelope(message: ServerMessage): ServerEnvelope {
  return {
    ...message, sessionId: 'wire-grid', streamSeq: 1, serverTime: 0,
  };
}

describe('bankroll reel wire', () => {
  it.each([1, 3, 5] as const)('round-trips every contiguous 3x3 outcome for BET $%s', bet => {
    for (let first = 0; first < 9; first += 1) for (let second = 0; second < 9; second += 1) for (let third = 0; third < 9; third += 1) {
      const stops: [number, number, number] = [first, second, third];
      const grid = gridFromStops(stops);
      const outcome = evaluateGrid(grid, bet as Bet);
      const spin: SpinView = {
        side: 'player', round: 1, symbols: grid[1], grid, stops, bet,
        winningLines: outcome.winningLines, payout: outcome.payout, total: 30 - bet + outcome.payout,
      };
      const message: ServerMessage = { type: 'side_spin', spin };
      expect(parseServerEnvelope(JSON.stringify(envelope(message)))).toEqual(envelope(message));
    }
  });

  it('rejects a grid or payout that does not match the confirmed stops and lines', () => {
    const grid = gridFromStops([0, 0, 0]);
    const outcome = evaluateGrid(grid, 5);
    const spin: SpinView = {
      side: 'rival', round: 1, symbols: grid[1], grid, stops: [0, 0, 0], bet: 5,
      winningLines: outcome.winningLines, payout: outcome.payout, total: 25 + outcome.payout,
    };
    expect(parseServerEnvelope(JSON.stringify(envelope({ type: 'side_spin', spin: { ...spin, payout: spin.payout + 3 } })))).toBeNull();
    expect(parseServerEnvelope(JSON.stringify(envelope({ type: 'side_spin', spin: { ...spin, grid: [grid[0], grid[2], grid[1]] } })))).toBeNull();
    expect(parseServerEnvelope(JSON.stringify(envelope({ type: 'side_spin', spin: { ...spin, stops: [9, 0, 0] } })))).toBeNull();
  });

  it('round-trips an upgraded strip using its confirmed draw order', () => {
    const upgrades = ['steady', 'jackpot'] as const;
    const pool = [...['cherry', 'bell', 'seven', 'cherry', 'bell', 'cherry', 'bell', 'cherry', 'seven'] as const, ...Array(6).fill('cherry'), 'seven'] as SpinView['symbols'][number][];
    const stops: [number, number, number] = [14, 15, 0];
    const grid = gridFromStops(stops, pool);
    const outcome = evaluateGrid(grid, 3);
    const spin: SpinView = {
      side: 'player', round: 12, symbols: grid[1], grid, stops, bet: 3,
      winningLines: outcome.winningLines, payout: outcome.payout, total: 30, upgrades: [...upgrades],
    };
    const message: ServerMessage = { type: 'side_spin', spin };
    expect(parseServerEnvelope(JSON.stringify(envelope(message)))).toEqual(envelope(message));
  });

  it('round-trips a snapshot whose statistics include all simultaneous winning lines in one round', () => {
    const stops: [number, number, number] = [0, 0, 0];
    const grid = gridFromStops(stops);
    const outcome = evaluateGrid(grid, 5);
    expect(outcome.winningLines).toHaveLength(3);
    const spin: SpinView = {
      side: 'player', round: 1, symbols: grid[1], grid, stops, bet: 5,
      winningLines: outcome.winningLines, payout: outcome.payout, total: 25 + outcome.payout,
    };
    const snapshot: MatchSnapshot = {
      matchId: 'wire-grid', status: 'result', elapsed: 60, remaining: 0, round: 1,
      rounds: { player: 1, rival: 0 }, balances: { player: spin.total, rival: 30 }, bets: { player: 5, rival: 3 }, scores: { player: spin.total, rival: 30 },
      stats: { player: { wins: { cherry: 3, bell: 0, seven: 0 }, bestSpin: { round: 1, payout: outcome.payout } }, rival: { wins: { cherry: 0, bell: 0, seven: 0 }, bestSpin: null } },
      upgrades: { player: [], rival: [] }, winner: 'player', eventSeq: 1,
    };
    const message: ServerMessage = { type: 'snapshot', snapshot, lastSpins: { player: spin } };
    expect(parseServerEnvelope(JSON.stringify(envelope(message)))).toEqual(envelope(message));
  });

  it('accepts only an exact conserved $5 loan transfer', () => {
    const before: MatchSnapshot = {
      matchId: 'wire-grid', status: 'playing', elapsed: 20, remaining: 40, round: 0,
      rounds: { player: 0, rival: 0 }, balances: { player: 0, rival: 8 }, bets: { player: 1, rival: 1 }, scores: { player: 0, rival: 8 },
      stats: { player: { wins: { cherry: 0, bell: 0, seven: 0 }, bestSpin: null }, rival: { wins: { cherry: 0, bell: 0, seven: 0 }, bestSpin: null } },
      upgrades: { player: [], rival: [] }, eventSeq: 3,
    };
    const after = { ...before, balances: { player: 5, rival: 3 }, scores: { player: 5, rival: 3 }, eventSeq: 4 };
    const message: ServerMessage = { type: 'loan_transfer', direction: 'rival_to_player', amount: 5, before, after, line: 'Fine. Don’t waste it.' };
    expect(parseServerEnvelope(JSON.stringify(envelope(message)))).toEqual(envelope(message));
    const invalidAmount = { ...message, amount: 6 };
    const invalidBalances = { ...message, after: { ...after, scores: { player: 6, rival: 2 } } };
    expect(parseServerEnvelope(JSON.stringify(envelope(invalidAmount as never)))).toBeNull();
    expect(parseServerEnvelope(JSON.stringify(envelope(invalidBalances)))).toBeNull();
  });
});
