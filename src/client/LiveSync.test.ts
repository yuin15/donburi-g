import { describe, expect, it } from 'vitest';
import type { ServerEnvelope, ServerMessage } from '../../shared/protocol';
import { parseServerEnvelope } from '../../shared/wire';
import { advanceMatch, createMatch, getSnapshot, startMatch } from '../domain/game';
import { LiveSync } from './LiveSync';

const wrap = (message: ServerMessage, streamSeq: number, sessionId = 'match-a'): ServerEnvelope => ({ ...message, sessionId, streamSeq, serverTime: 1000 });
const hello = wrap({ type: 'hello', sessionId: 'match-a', live: true }, 1);
const spin = { player: { side: 'player' as const, round: 30, symbols: ['seven', 'seven', 'seven'] as ['seven', 'seven', 'seven'], payout: 1200 as const, total: 3600 }, rival: { side: 'rival' as const, round: 30, symbols: ['cherry', 'bell', 'seven'] as ['cherry', 'bell', 'seven'], payout: 0 as const, total: 3240 } };
const result: ServerMessage = { type: 'snapshot', snapshot: { matchId: 'match-a', status: 'result', elapsed: 60, remaining: 0, round: 30, scores: { player: 3600, rival: 3240 }, stats: { player: { wins: { cherry: 0, bell: 0, seven: 3 }, bestSpin: { round: 10, payout: 1200 } }, rival: { wins: { cherry: 1, bell: 3, seven: 2 }, bestSpin: { round: 12, payout: 1200 } } }, upgrades: { player: [], rival: [] }, eventSeq: 38, winner: 'player' }, lastSpin: spin };

describe('live wire validation and recovery', () => {
  it('requests one snapshot for a gap and recovers the exact final reels and result', () => {
    const sync = new LiveSync();
    expect(sync.accept(hello).message?.type).toBe('hello');
    expect(sync.accept(wrap({ type: 'spin', ...spin }, 3))).toEqual({ message: null, requestSnapshot: true });
    expect(sync.accept(wrap({ type: 'rival_line', text: 'late', reason: 'old' }, 4))).toEqual({ message: null, requestSnapshot: false });
    const recovered = parseServerEnvelope(JSON.stringify(wrap(result, 5)))!;
    expect(sync.accept(recovered)).toEqual({ message: result, requestSnapshot: false });
    expect(sync.accept(recovered)).toEqual({ message: null, requestSnapshot: false });
    expect(sync.accept(wrap({ type: 'spin', ...spin }, 3)).message).toBeNull();
  });
  it('recovers a complete 30-round breakdown after missed domain events', () => {
    const state = createMatch(123, 'match-a');
    startMatch(state);
    const events = advanceMatch(state, 60);
    const last = events.filter(event => event.type === 'spin').at(-1)!;
    const authoritative: ServerMessage = { type: 'snapshot', snapshot: getSnapshot(state), lastSpin: { player: last.player, rival: last.rival } };
    const sync = new LiveSync();
    sync.accept(hello);
    expect(sync.accept(wrap({ type: 'spin', player: last.player, rival: last.rival }, 3)).requestSnapshot).toBe(true);
    const parsed = parseServerEnvelope(JSON.stringify(wrap(authoritative, 4)));
    expect(parsed).not.toBeNull();
    const recovered = sync.accept(parsed!).message;
    expect(recovered).toEqual(authoritative);
    if (recovered?.type !== 'snapshot') throw new Error('missing_recovery');
    expect(recovered.snapshot.stats).toEqual(state.stats);
    expect(recovered.snapshot.round).toBe(30);
    expect(recovered.snapshot.scores).toEqual(state.scores);
  });
  it('uses a complete snapshot directly across a gap and preserves media shutdown', () => {
    const sync = new LiveSync(); sync.accept(hello);
    expect(sync.accept(wrap(result, 8))).toEqual({ message: result, requestSnapshot: false });
    const error = { type: 'voice_status' as const, status: 'error' as const };
    expect(sync.accept(wrap(error, 10))).toEqual({ message: error, requestSnapshot: true });
  });
  it('does not mix connections or accept a stream without its hello', () => {
    expect(() => new LiveSync().accept(wrap(result, 2))).toThrow('missing_hello');
    const a = new LiveSync(); const b = new LiveSync();
    a.accept(hello); b.accept(wrap({ type: 'hello', live: true, sessionId: 'match-b' }, 1, 'match-b'));
    expect(() => a.accept(wrap({ type: 'voice_status', status: 'ready' }, 2, 'match-b'))).toThrow('wrong_match');
    expect(b.accept(wrap({ type: 'voice_status', status: 'ready' }, 2, 'match-b')).message?.type).toBe('voice_status');
  });
  it('rejects malformed, oversized, mismatched and incomplete outcomes before rendering', () => {
    expect(parseServerEnvelope('not json')).toBeNull();
    expect(parseServerEnvelope(' '.repeat(100001))).toBeNull();
    expect(parseServerEnvelope(JSON.stringify({ type: 'match_ended', snapshot: { status: 'result' } }))).toBeNull();
    expect(parseServerEnvelope(JSON.stringify(wrap(result, 2, 'wrong')))).toBeNull();
    expect(parseServerEnvelope(JSON.stringify(wrap({ ...result, lastSpin: undefined } as ServerMessage, 2)))).toBeNull();
    expect(parseServerEnvelope(JSON.stringify(wrap({ type: 'spin', player: spin.player, rival: { ...spin.rival, round: 29 } }, 2)))).toBeNull();
    expect(parseServerEnvelope(JSON.stringify(wrap(result, 2)))).not.toBeNull();
  });
  it('rejects a snapshot that omits its required result breakdown', () => {
    const missing = { ...wrap(result, 2), snapshot: { ...result.snapshot, stats: undefined } };
    expect(parseServerEnvelope(JSON.stringify(missing))).toBeNull();
  });
  it.each([
    { name: 'negative wins', stats: { wins: { cherry: -1, bell: 0, seven: 3 }, bestSpin: { round: 10, payout: 1200 } } },
    { name: 'fractional wins', stats: { wins: { cherry: 0, bell: 0, seven: 2.5 }, bestSpin: { round: 10, payout: 1200 } } },
    { name: 'more than 30 wins', stats: { wins: { cherry: 0, bell: 0, seven: 31 }, bestSpin: { round: 1, payout: 1200 } } },
    { name: 'score mismatch', stats: { wins: { cherry: 1, bell: 0, seven: 3 }, bestSpin: { round: 10, payout: 1200 } } },
    { name: 'missing winning symbol', stats: { wins: { cherry: 0, bell: 0 }, bestSpin: { round: 10, payout: 1200 } } },
    { name: 'missing highest hit', stats: { wins: { cherry: 0, bell: 0, seven: 3 }, bestSpin: null } },
    { name: 'incorrect highest payout', stats: { wins: { cherry: 0, bell: 0, seven: 3 }, bestSpin: { round: 10, payout: 240 } } },
    { name: 'unsupported highest payout', stats: { wins: { cherry: 0, bell: 0, seven: 3 }, bestSpin: { round: 10, payout: 1000 } } },
    { name: 'zero highest round', stats: { wins: { cherry: 0, bell: 0, seven: 3 }, bestSpin: { round: 0, payout: 1200 } } },
    { name: 'future highest round', stats: { wins: { cherry: 0, bell: 0, seven: 3 }, bestSpin: { round: 31, payout: 1200 } } },
    { name: 'impossible first highest tie', stats: { wins: { cherry: 0, bell: 0, seven: 3 }, bestSpin: { round: 29, payout: 1200 } } },
  ])('rejects $name in the authoritative breakdown', ({ stats }) => {
    const invalid = { ...wrap(result, 2), snapshot: { ...result.snapshot, stats: { ...result.snapshot.stats, player: stats } } };
    expect(parseServerEnvelope(JSON.stringify(invalid))).toBeNull();
  });
  it('rejects more winning spins than completed rounds even when the score adds up', () => {
    const invalid = { ...wrap(result, 2), snapshot: { ...result.snapshot, status: 'playing', elapsed: 4, remaining: 56, round: 2, scores: { player: 360, rival: 0 }, stats: { player: { wins: { cherry: 3, bell: 0, seven: 0 }, bestSpin: { round: 1, payout: 120 } }, rival: { wins: { cherry: 0, bell: 0, seven: 0 }, bestSpin: null } } }, lastSpin: { player: { ...spin.player, round: 2, symbols: ['cherry', 'cherry', 'cherry'], payout: 120, total: 360 }, rival: { ...spin.rival, round: 2, total: 0 } } };
    expect(parseServerEnvelope(JSON.stringify(invalid))).toBeNull();
  });
  it('rejects a highest hit when no winning spins were recorded', () => {
    const invalid = { ...wrap(result, 2), snapshot: { ...result.snapshot, scores: { ...result.snapshot.scores, player: 0 }, stats: { ...result.snapshot.stats, player: { wins: { cherry: 0, bell: 0, seven: 0 }, bestSpin: { round: 5, payout: 120 } } } }, lastSpin: { ...spin, player: { ...spin.player, symbols: ['cherry', 'bell', 'seven'], payout: 0, total: 0 } } };
    expect(parseServerEnvelope(JSON.stringify(invalid))).toBeNull();
  });
});
