import { describe, expect, it } from 'vitest';
import type { ServerEnvelope, ServerMessage } from '../../shared/protocol';
import { parseServerEnvelope } from '../../shared/wire';
import { LiveSync } from './LiveSync';

const wrap = (message: ServerMessage, streamSeq: number, sessionId = 'match-a'): ServerEnvelope => ({ ...message, sessionId, streamSeq, serverTime: 1000 });
const hello = wrap({ type: 'hello', sessionId: 'match-a', live: true }, 1);
const spin = { player: { side: 'player' as const, round: 30, symbols: ['seven', 'seven', 'seven'] as ['seven', 'seven', 'seven'], payout: 1200 as const, total: 3600 }, rival: { side: 'rival' as const, round: 30, symbols: ['cherry', 'bell', 'seven'] as ['cherry', 'bell', 'seven'], payout: 0 as const, total: 3240 } };
const result: ServerMessage = { type: 'snapshot', snapshot: { matchId: 'match-a', status: 'result', elapsed: 60, remaining: 0, round: 30, scores: { player: 3600, rival: 3240 }, upgrades: { player: [], rival: [] }, eventSeq: 38, winner: 'player' }, lastSpin: spin };

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
});
