import { z } from 'zod';
import type { ServerEnvelope } from './protocol.js';
import { MANUAL_SPIN_INTERVAL, MATCH_SECONDS, MAX_MATCH_ROUNDS } from './protocol.js';

const id = z.string().min(1).max(100);
const upgrade = z.enum(['steady', 'jackpot']);
const index = z.union([z.literal(0), z.literal(1)]);
const STARTING_BALANCE = 30;
const SPIN_COST = 1;
const score = z.number().int().min(0).max(STARTING_BALANCE + MAX_MATCH_ROUNDS * (30 - SPIN_COST));
const winCount = z.number().int().min(0).max(MAX_MATCH_ROUNDS);
const payout = z.union([z.literal(0), z.literal(3), z.literal(6), z.literal(30)]);
const sideStats = z.object({
  wins: z.object({ cherry: winCount, bell: winCount, seven: winCount }),
  bestSpin: z.object({ round: z.number().int().min(1).max(MAX_MATCH_ROUNDS), payout: z.union([z.literal(3), z.literal(6), z.literal(30)]) }).nullable(),
});
const spin = z.object({
  side: z.enum(['player', 'rival']), round: z.number().int().min(1).max(MAX_MATCH_ROUNDS),
  symbols: z.tuple([z.enum(['cherry', 'bell', 'seven']), z.enum(['cherry', 'bell', 'seven']), z.enum(['cherry', 'bell', 'seven'])]),
  payout, total: score,
  upgrades: z.array(upgrade).max(2).optional(),
});
const pair = z.object({ player: spin, rival: spin }).refine(v => v.player.side === 'player' && v.rival.side === 'rival' && v.player.round === v.rival.round);
const lastSpins = z.object({ player: spin.optional(), rival: spin.optional() });
const rounds = z.number().int().min(0).max(MAX_MATCH_ROUNDS);
const snapshot = z.object({
  matchId: id, status: z.enum(['ready', 'countdown', 'playing', 'result', 'aborted']),
  elapsed: z.number().min(0).max(MATCH_SECONDS), remaining: z.number().min(0).max(MATCH_SECONDS), round: z.number().int().min(0).max(MAX_MATCH_ROUNDS),
  rounds: z.object({ player: rounds, rival: rounds }),
  scores: z.object({ player: score, rival: score }),
  stats: z.object({ player: sideStats, rival: sideStats }),
  upgrades: z.object({ player: z.array(upgrade).max(2), rival: z.array(upgrade).max(2) }),
  winner: z.enum(['player', 'rival', 'draw']).optional(), eventSeq: z.number().int().min(0),
}).refine(v => v.round === v.rounds.player)
  .refine(v => v.status !== 'result' || (v.elapsed === MATCH_SECONDS && v.remaining === 0 && v.winner !== undefined))
  .refine(v => (['player', 'rival'] as const).every(side => {
    const { wins, bestSpin } = v.stats[side];
    const count = wins.cherry + wins.bell + wins.seven;
    const total = wins.cherry * 3 + wins.bell * 6 + wins.seven * 30;
    const expectedBalance = STARTING_BALANCE - v.rounds[side] * SPIN_COST + total;
    if (expectedBalance !== v.scores[side] || count > v.rounds[side]) return false;
    if (count === 0) return bestSpin === null;
    const highestPayout = wins.seven > 0 ? 30 : wins.bell > 0 ? 6 : 3;
    const highestCount = wins.seven > 0 ? wins.seven : wins.bell > 0 ? wins.bell : wins.cherry;
    // The first highest-paying hit must leave enough later rounds for its remaining ties.
    return bestSpin !== null && bestSpin.payout === highestPayout && bestSpin.round + highestCount - 1 <= v.rounds[side];
  }));

const payload = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), live: z.literal(true), sessionId: id }),
  z.object({ type: z.literal('voice_audio'), audio: z.string().min(4).max(64000).regex(/^[A-Za-z0-9+/]+={0,2}$/).refine(value => value.length % 4 === 0) }),
  z.object({ type: z.literal('voice_interrupt') }),
  z.object({ type: z.literal('avatar'), livekitUrl: z.string().min(1).max(2048), livekitToken: z.string().min(1).max(16000) }),
  z.object({ type: z.literal('provider_status'), provider: z.enum(['gptLive', 'liveAvatar']), state: z.enum(['connecting', 'connected', 'failed', 'closed']) }),
  z.object({ type: z.literal('voice_status'), status: z.enum(['connecting', 'ready', 'closed', 'error']), message: z.string().max(1000).optional() }),
  z.object({ type: z.literal('snapshot'), snapshot, lastSpin: pair.optional(), lastSpins: lastSpins.optional() }),
  z.object({ type: z.literal('spin'), player: spin, rival: spin }),
  z.object({ type: z.literal('side_spin'), spin }),
  z.object({ type: z.literal('spin_status'), commandId: id, accepted: z.boolean(), retryAfterMs: z.number().int().min(0).max(MANUAL_SPIN_INTERVAL * 1000) }),
  z.object({ type: z.literal('upgrade_offer'), offerIndex: index, closesAtElapsed: z.union([z.literal(24), z.literal(44)]) }),
  z.object({ type: z.literal('upgrade_applied'), offerIndex: index, player: upgrade, rival: upgrade }),
  z.object({ type: z.literal('rival_line'), text: z.string().max(1000), reason: z.string().max(100) }),
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
          if (count === 0 ? !!last : !last || last.side !== side || last.round !== count || last.total !== message.snapshot.scores[side]) return null;
        }
      }
    }
    return message as ServerEnvelope;
  } catch { return null; }
}
