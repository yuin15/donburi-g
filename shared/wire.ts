import { z } from 'zod';
import type { ServerEnvelope } from './protocol.js';

const id = z.string().min(1).max(100);
const upgrade = z.enum(['steady', 'jackpot']);
const index = z.union([z.literal(0), z.literal(1)]);
const score = z.number().int().min(0).max(36000);
const spin = z.object({
  side: z.enum(['player', 'rival']), round: z.number().int().min(1).max(30),
  symbols: z.tuple([z.enum(['cherry', 'bell', 'seven']), z.enum(['cherry', 'bell', 'seven']), z.enum(['cherry', 'bell', 'seven'])]),
  payout: z.union([z.literal(0), z.literal(120), z.literal(240), z.literal(1200)]), total: score,
});
const pair = z.object({ player: spin, rival: spin }).refine(v => v.player.side === 'player' && v.rival.side === 'rival' && v.player.round === v.rival.round);
const snapshot = z.object({
  matchId: id, status: z.enum(['ready', 'countdown', 'playing', 'result', 'aborted']),
  elapsed: z.number().min(0).max(60), remaining: z.number().min(0).max(60), round: z.number().int().min(0).max(30),
  scores: z.object({ player: score, rival: score }),
  upgrades: z.object({ player: z.array(upgrade).max(2), rival: z.array(upgrade).max(2) }),
  winner: z.enum(['player', 'rival', 'draw']).optional(), eventSeq: z.number().int().min(0),
}).refine(v => v.status !== 'result' || (v.round === 30 && v.elapsed === 60 && v.remaining === 0 && v.winner !== undefined));

const payload = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), live: z.literal(true), sessionId: id }),
  z.object({ type: z.literal('avatar'), livekitUrl: z.string().min(1).max(2048), livekitToken: z.string().min(1).max(16000) }),
  z.object({ type: z.literal('voice_status'), status: z.enum(['connecting', 'ready', 'closed', 'error']), message: z.string().max(1000).optional() }),
  z.object({ type: z.literal('snapshot'), snapshot, lastSpin: pair.optional() }),
  z.object({ type: z.literal('spin'), player: spin, rival: spin }),
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
      if (message.type === 'snapshot' && message.snapshot.round > 0) {
        if (!message.lastSpin || message.lastSpin.player.round !== message.snapshot.round || message.lastSpin.player.total !== message.snapshot.scores.player || message.lastSpin.rival.total !== message.snapshot.scores.rival) return null;
      }
    }
    return message as ServerEnvelope;
  } catch { return null; }
}
