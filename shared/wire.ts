import { z } from 'zod';
import type { ServerEnvelope } from './protocol.js';
import { MANUAL_SPIN_INTERVAL, MATCH_SECONDS } from './protocol.js';

const MAX_WIRE_MATCH_SECONDS = 10000;
const MAX_WIRE_MATCH_ROUNDS = Math.ceil(MAX_WIRE_MATCH_SECONDS / MANUAL_SPIN_INTERVAL);

const id = z.string().min(1).max(100);
const upgrade = z.enum(['steady', 'jackpot']);
const index = z.union([z.literal(0), z.literal(1)]);
const score = z.number().int().min(-10000).max(10000);
const symbols = z.enum(['cherry', 'bell', 'seven']);
const basePool = ['cherry', 'bell', 'seven', 'cherry', 'bell', 'cherry', 'bell', 'cherry', 'seven'] as const;
const upgradeEntries = {
  steady: Array<z.infer<typeof symbols>>(6).fill('cherry'),
  jackpot: Array<z.infer<typeof symbols>>(1).fill('seven'),
} as const;
const lineRows = { top: [0, 0, 0], middle: [1, 1, 1], bottom: [2, 2, 2], diagonalDown: [0, 1, 2], diagonalUp: [2, 1, 0] } as const;
const activeLines = { 1: ['middle'], 3: ['top', 'middle', 'bottom'], 5: ['top', 'middle', 'bottom', 'diagonalDown', 'diagonalUp'] } as const;
const payout = { cherry: 3, bell: 6, seven: 30 } as const;
const winCount = z.number().int().min(0).max(MAX_WIRE_MATCH_ROUNDS * 5);
const sideStats = z.object({
  wins: z.object({ cherry: winCount, bell: winCount, seven: winCount }),
  bestSpin: z.object({ round: z.number().int().min(1).max(MAX_WIRE_MATCH_ROUNDS), payout: z.number().int().min(1).max(150) }).nullable(),
});
const spin = z.object({
  side: z.enum(['player', 'rival']), round: z.number().int().min(1).max(MAX_WIRE_MATCH_ROUNDS),
  symbols: z.tuple([symbols, symbols, symbols]),
  grid: z.tuple([
    z.tuple([symbols, symbols, symbols]),
    z.tuple([symbols, symbols, symbols]),
    z.tuple([symbols, symbols, symbols]),
  ]).optional(),
  stops: z.tuple([z.number().int().min(0).max(29), z.number().int().min(0).max(29), z.number().int().min(0).max(29)]).optional(),
  bet: z.union([z.literal(1), z.literal(3), z.literal(5)]).optional(),
  winningLines: z.array(z.enum(['middle', 'top', 'bottom', 'diagonalDown', 'diagonalUp'])).max(5).optional(),
  payout: z.number().int().min(0).max(150), total: score,
  upgrades: z.array(upgrade).max(6).optional(),
  upgradeSpent: z.number().int().min(0).max(90).optional(),
}).refine(value => {
  const fields = [value.grid, value.stops, value.bet, value.winningLines];
  if (fields.every(field => field === undefined)) return true;
  if (fields.some(field => field === undefined)) return false;
  const { grid, stops, bet, winningLines } = value as Required<Pick<typeof value, 'grid' | 'stops' | 'bet' | 'winningLines'>> & typeof value;
  if (grid[1][0] !== value.symbols[0] || grid[1][1] !== value.symbols[1] || grid[1][2] !== value.symbols[2]) return false;
  const pool = [...basePool, ...(value.upgrades ?? []).flatMap(id => upgradeEntries[id])];
  if (stops.some(stop => stop >= pool.length)) return false;
  if (!grid.every((row, rowIndex) => row.every((symbol, column) => symbol === pool[(stops[column] + rowIndex - 1 + pool.length) % pool.length]))) return false;
  if (new Set(winningLines).size !== winningLines.length || !winningLines.every(line => (activeLines[bet] as readonly string[]).includes(line))) return false;
  const total = winningLines.reduce((sum, line) => {
    const [a, b, c] = lineRows[line];
    const symbol = grid[a][0];
    return grid[a][0] === grid[b][1] && grid[b][1] === grid[c][2] ? sum + payout[symbol] : Number.NaN;
  }, 0);
  return total === value.payout;
});
const pair = z.object({ player: spin, rival: spin }).refine(v => v.player.side === 'player' && v.rival.side === 'rival' && v.player.round === v.rival.round);
const lastSpins = z.object({ player: spin.optional(), rival: spin.optional() });
const rounds = z.number().int().min(0).max(MAX_WIRE_MATCH_ROUNDS);
const snapshot = z.object({
  matchId: id, status: z.enum(['ready', 'countdown', 'playing', 'result', 'aborted']),
  elapsed: z.number().min(0).max(MAX_WIRE_MATCH_SECONDS), remaining: z.number().min(0).max(MAX_WIRE_MATCH_SECONDS), duration: z.number().min(MATCH_SECONDS).max(MAX_WIRE_MATCH_SECONDS).optional(), round: z.number().int().min(0).max(MAX_WIRE_MATCH_ROUNDS),
  rounds: z.object({ player: rounds, rival: rounds }),
  balances: z.object({ player: score, rival: score }),
  bets: z.object({ player: z.union([z.literal(1), z.literal(3), z.literal(5)]), rival: z.union([z.literal(1), z.literal(3), z.literal(5)]) }),
  scores: z.object({ player: score, rival: score }),
  stats: z.object({ player: sideStats, rival: sideStats }),
  upgrades: z.object({ player: z.array(upgrade).max(6), rival: z.array(upgrade).max(2) }),
  rivalDistraction: z.object({ untilElapsed: z.number().min(0).max(MAX_WIRE_MATCH_SECONDS), seconds: z.union([z.literal(2), z.literal(4)]) }).optional(),
  upgradeSpent: z.number().int().min(0).max(90).optional(),
  winner: z.enum(['player', 'rival', 'draw']).optional(), eventSeq: z.number().int().min(0),
}).refine(v => v.round === v.rounds.player)
  .refine(v => {
    const maxRoundsForDuration = Math.ceil((v.duration ?? MATCH_SECONDS) / MANUAL_SPIN_INTERVAL);
    return v.round <= maxRoundsForDuration && v.rounds.player <= maxRoundsForDuration && v.rounds.rival <= maxRoundsForDuration;
  })
  .refine(v => v.status !== 'result' || (v.elapsed === (v.duration ?? MATCH_SECONDS) && v.remaining === 0 && v.winner !== undefined))
  .refine(v => (['player', 'rival'] as const).every(side => {
    const { wins, bestSpin } = v.stats[side];
    const count = wins.cherry + wins.bell + wins.seven;
    if (count > v.rounds[side] * 5) return false;
    if (count === 0) return bestSpin === null;
    return bestSpin !== null && bestSpin.round <= v.rounds[side] && bestSpin.payout <= 150;
  }));

const payload = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), live: z.literal(true), sessionId: id }),
  z.object({ type: z.literal('voice_audio'), audio: z.string().min(4).max(64000).regex(/^[A-Za-z0-9+/]+={0,2}$/).refine(value => value.length % 4 === 0), speechId: id.optional() }),
  z.object({ type: z.literal('voice_speech_end'), speechId: id }),
  z.object({ type: z.literal('voice_interrupt') }),
  z.object({ type: z.literal('voice_route'), route: z.literal('audio'), transitionId: id }),
  z.object({ type: z.literal('avatar'), livekitUrl: z.string().min(1).max(2048), livekitToken: z.string().min(1).max(16000) }),
  z.object({ type: z.literal('provider_status'), provider: z.enum(['gptLive', 'liveAvatar']), state: z.enum(['connecting', 'connected', 'failed', 'closed']) }),
  z.object({ type: z.literal('voice_status'), status: z.enum(['connecting', 'ready', 'closed', 'error']), message: z.string().max(1000).optional() }),
  z.object({ type: z.literal('snapshot'), snapshot, lastSpin: pair.optional(), lastSpins: lastSpins.optional() }),
  z.object({ type: z.literal('spin'), player: spin, rival: spin }),
  z.object({ type: z.literal('side_spin'), spin }),
  z.object({ type: z.literal('spin_status'), commandId: id, accepted: z.boolean(), retryAfterMs: z.number().int().min(0).max(MANUAL_SPIN_INTERVAL * 1000) }),
  z.object({ type: z.literal('bet_status'), commandId: id, accepted: z.boolean(), bet: z.union([z.literal(1), z.literal(3), z.literal(5)]) }),
  z.object({ type: z.literal('upgrade_offer'), offerIndex: index, closesAtElapsed: z.union([z.literal(24), z.literal(44)]) }),
  z.object({ type: z.literal('upgrade_applied'), offerIndex: index, player: upgrade, rival: upgrade }),
  z.object({ type: z.literal('rival_line'), text: z.string().max(1000), reason: z.string().max(100) }),
  z.object({ type: z.literal('time_extension'), decision: z.enum(['accepted', 'rejected']), before: snapshot, after: snapshot, line: z.string().min(1).max(1000) }).refine(v => v.before.matchId === v.after.matchId && (v.decision === 'accepted' ? v.after.duration === (v.before.duration ?? MATCH_SECONDS) + 10 && Math.abs(v.after.remaining - (v.before.remaining + 10)) < 1e-6 : JSON.stringify(v.before) === JSON.stringify(v.after))),
  z.object({ type: z.literal('loan_transfer'), direction: z.enum(['rival_to_player', 'player_to_rival']), amount: z.literal(5), before: snapshot, after: snapshot, line: z.string().min(1).max(1000) }).refine(v => {
    if (v.before.matchId !== v.after.matchId || v.before.status !== 'playing' || v.after.status !== 'playing') return false;
    const lender = v.direction === 'rival_to_player' ? 'rival' : 'player';
    const borrower = lender === 'rival' ? 'player' : 'rival';
    return (['player', 'rival'] as const).every(side => v.before.balances[side] === v.before.scores[side] && v.after.balances[side] === v.after.scores[side])
      && v.before.scores[lender] - v.after.scores[lender] === 5
      && v.after.scores[borrower] - v.before.scores[borrower] === 5;
  }),
  z.object({ type: z.literal('rival_distraction'), state: z.enum(['started', 'ended']), seconds: z.union([z.literal(2), z.literal(4)]), line: z.string().min(1).max(1000) }),
  z.object({ type: z.literal('transcript'), role: z.enum(['user', 'assistant']), delta: z.string().max(16000) }),
  z.object({ type: z.literal('match_ended'), snapshot }),
  z.object({ type: z.literal('error'), code: z.string().max(100), message: z.string().max(1000), recoverable: z.boolean() }),
]);
const envelope = z.intersection(payload, z.object({ sessionId: id, streamSeq: z.number().int().positive(), serverTime: z.number().int().nonnegative() }));

export function parseServerEnvelope(raw: string): ServerEnvelope | null {
  if (raw.length > 100000) return null;
  try {
    const result = envelope.safeParse(JSON.parse(raw));
    if (!result.success) return null;
    const message = result.data;
    if (message.type === 'spin' && !pair.safeParse(message).success) return null;
    if (message.type === 'snapshot' || message.type === 'match_ended') {
      if (message.snapshot.matchId !== message.sessionId) return null;
      if (message.type === 'snapshot') {
        const latest = message.lastSpins ?? message.lastSpin;
        for (const side of ['player', 'rival'] as const) {
          const last = latest?.[side];
          const count = message.snapshot.rounds[side];
          const spentSinceSpin = side === 'player' ? (message.snapshot.upgradeSpent ?? 0) - (last?.upgradeSpent ?? 0) : 0;
          if (spentSinceSpin < 0 || (count === 0 ? !!last : !last || last.side !== side || last.round !== count || last.total - spentSinceSpin !== message.snapshot.scores[side])) return null;
        }
      }
    }
    return message as ServerEnvelope;
  } catch { return null; }
}
