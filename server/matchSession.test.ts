import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';
import type { LiveEvents } from './gptLive';
import type { ServerMessage } from '../shared/protocol';
import { parseServerEnvelope } from '../shared/wire';

const provider = vi.hoisted(() => ({
  start: vi.fn(), stop: vi.fn(), mediaStart: vi.fn(), mediaClose: vi.fn(),
  gptConnect: vi.fn(), gptClose: vi.fn(), events: null as LiveEvents | null, bridges: [] as LiveEvents[],
  context: vi.fn(), reaction: vi.fn(), mic: vi.fn(),
}));
// A reproducible normal bell win at 14s, without a new leader or jackpot reaction.
vi.mock('node:crypto', () => ({ randomBytes: () => Buffer.from([1, 0, 0, 0]) }));
vi.mock('./liveavatar', () => ({ startAvatarSession: provider.start, stopAvatarSession: provider.stop }));
vi.mock('./mediaServer', () => ({ MediaServerLeg: class {
  start = provider.mediaStart;
  close = provider.mediaClose;
  speak = vi.fn();
  interrupt = vi.fn();
} }));
vi.mock('./gptLive', () => ({ GptLiveBridge: class {
  constructor(events: LiveEvents) { provider.events = events; provider.bridges.push(events); }
  connect = provider.gptConnect;
  close = provider.gptClose;
  updateGameContext = provider.context;
  requestReaction = provider.reaction;
  sendMic = provider.mic;
} }));
vi.mock('./rivalBrain', () => ({ chooseRivalUpgrade: vi.fn(async () => ({ upgradeId: 'steady', source: 'fallback' })) }));
import { MatchSession } from './matchSession';
import { chooseRivalUpgrade } from './rivalBrain';

const avatar = { sessionId: 'test-session', livekitUrl: 'test-url', livekitToken: 'test-token', mediaWsUrl: 'test-media' };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function setup(id = 'test-match') {
  const messages: ServerMessage[] = [];
  const close = vi.fn();
  const socket = { readyState: 1, close, send: (data: string) => messages.push(JSON.parse(data)) } as unknown as WebSocket;
  const release = vi.fn(async () => undefined);
  return { session: new MatchSession(socket, id, release), messages, release, close };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  provider.bridges.length = 0;
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network disabled in lifecycle tests'); }));
  provider.start.mockResolvedValue(avatar);
  provider.stop.mockResolvedValue(undefined);
  provider.mediaStart.mockResolvedValue(true);
  provider.gptConnect.mockImplementation(async () => { provider.events?.onReady(); return true; });
  provider.gptClose.mockResolvedValue(undefined);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('live match cleanup', () => {
  it('shares ready and playing context once, deduplicating unchanged clock ticks and microphone chunks', async () => {
    const connecting = deferred<boolean>();
    provider.gptConnect.mockReturnValue(connecting.promise);
    const { session } = setup();
    const initialized = session.initialize();
    await vi.waitFor(() => expect(provider.gptConnect).toHaveBeenCalled());
    session.handleRaw('{"type":"mic","audio":"AAAA"}');
    expect(provider.context).not.toHaveBeenCalled();
    expect(provider.mic).not.toHaveBeenCalled();
    provider.events?.onReady();
    connecting.resolve(true);
    await initialized;
    expect(provider.context).toHaveBeenCalledTimes(1);
    expect(provider.context).toHaveBeenLastCalledWith(expect.stringContaining('状態=ready,勝者=未確定'));
    await vi.advanceTimersByTimeAsync(5000);
    for (let i = 0; i < 20; i += 1) session.handleRaw('{"type":"mic","audio":"AAAA"}');
    session.handleRaw('{"type":"snapshot"}');
    expect(provider.context).toHaveBeenCalledTimes(1);
    session.handleRaw('{"type":"start"}');
    expect(provider.context).toHaveBeenCalledTimes(2);
    expect(provider.context).toHaveBeenLastCalledWith(expect.stringContaining('残り60秒'));
    expect(provider.context).toHaveBeenLastCalledWith(expect.stringContaining('状態=playing,勝者=未確定'));
    await vi.advanceTimersByTimeAsync(900);
    for (let i = 0; i < 20; i += 1) session.handleRaw('{"type":"mic","audio":"AAAA"}');
    expect(provider.context).toHaveBeenCalledTimes(2);
    expect(provider.reaction).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(provider.context).toHaveBeenCalledTimes(3);
    expect(provider.context).toHaveBeenLastCalledWith(expect.stringContaining('残り59秒'));
    await session.shutdown('test_finished');
  });

  it('updates ordinary wins and time even when no new spontaneous reaction is requested', async () => {
    const { session, messages } = setup();
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    await vi.advanceTimersByTimeAsync(13000);
    const reactionsBefore = provider.reaction.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2000);
    session.handleRaw('{"type":"snapshot"}');
    expect(messages.filter(m => m.type === 'spin').at(-1)).toMatchObject({ player: { round: 7, payout: 240, total: 1680 }, rival: { total: 0 } });
    expect(provider.context).toHaveBeenLastCalledWith(expect.stringContaining('残り45秒、プレイヤー1680点、あなた0点'));
    expect(provider.reaction).toHaveBeenCalledTimes(reactionsBefore);
    // Ready + start + one changed context per elapsed second, not every 100ms tick.
    expect(provider.context).toHaveBeenCalledTimes(17);
    await session.shutdown('test_finished');
  });

  it('catches up a stalled tick and sends current scores and applied upgrades before microphone audio', async () => {
    const { session, messages } = setup();
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    await vi.advanceTimersByTimeAsync(20000);
    session.handleRaw(JSON.stringify({ type: 'upgrade', matchId: 'test-match', commandId: 'context-upgrade', offerIndex: 0, upgradeId: 'jackpot' }));
    const previousContextCount = provider.context.mock.calls.length;
    vi.setSystemTime(Date.now() + 4100);
    session.handleRaw('{"type":"mic","audio":"AAAA"}');
    const latest = messages.filter(m => m.type === 'snapshot').at(-1);
    expect(latest).toMatchObject({ snapshot: { elapsed: 24.1, round: 12, upgrades: { player: ['jackpot'], rival: ['steady'] } } });
    if (latest?.type !== 'snapshot') throw new Error('missing caught-up snapshot');
    expect(provider.context).toHaveBeenCalledTimes(previousContextCount + 1);
    expect(provider.context).toHaveBeenLastCalledWith(expect.stringContaining(`残り36秒、プレイヤー${latest.snapshot.scores.player}点、あなた${latest.snapshot.scores.rival}点`));
    expect(provider.context).toHaveBeenLastCalledWith(expect.stringContaining('プレイヤー改造[jackpot],あなた改造[steady]'));
    expect(provider.mic).toHaveBeenCalledExactlyOnceWith('AAAA');
    expect(provider.context.mock.invocationCallOrder.at(-1)).toBeLessThan(provider.mic.mock.invocationCallOrder[0]);
    session.handleRaw('{"type":"mic","audio":"AAAA"}');
    expect(provider.context).toHaveBeenCalledTimes(previousContextCount + 1);
    await session.shutdown('test_finished');
  });

  it('shares a caught-up final result before audio without repeating it or exceeding the reaction limit', async () => {
    const { session, messages } = setup();
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    await vi.advanceTimersByTimeAsync(59000);
    expect(provider.reaction.mock.calls.length).toBeLessThanOrEqual(5);
    const previousContextCount = provider.context.mock.calls.length;
    const priorReactions = provider.reaction.mock.calls.length;
    vi.setSystemTime(Date.now() + 1500);
    session.handleRaw('{"type":"mic","audio":"AAAA"}');
    const final = messages.find(m => m.type === 'match_ended');
    if (final?.type !== 'match_ended') throw new Error('missing final result');
    expect(provider.context).toHaveBeenCalledTimes(previousContextCount + 1);
    expect(provider.context).toHaveBeenLastCalledWith(expect.stringContaining(`残り0秒、プレイヤー${final.snapshot.scores.player}点、あなた${final.snapshot.scores.rival}点`));
    expect(provider.context).toHaveBeenLastCalledWith(expect.stringContaining(`状態=result,勝者=${final.snapshot.winner}`));
    expect(provider.context.mock.invocationCallOrder.at(-1)).toBeLessThan(provider.mic.mock.invocationCallOrder[0]);
    await vi.advanceTimersByTimeAsync(1);
    expect(provider.reaction).toHaveBeenCalledTimes(priorReactions + 1);
    expect(provider.reaction.mock.calls.length).toBeLessThanOrEqual(6);
    session.handleRaw('{"type":"mic","audio":"AAAA"}');
    await vi.advanceTimersByTimeAsync(2000);
    expect(provider.context).toHaveBeenCalledTimes(previousContextCount + 1);
    await session.shutdown('test_finished');
    const sentMic = provider.mic.mock.calls.length;
    session.handleRaw('{"type":"mic","audio":"AAAA"}');
    await vi.advanceTimersByTimeAsync(1000);
    expect(provider.context).toHaveBeenCalledTimes(previousContextCount + 1);
    expect(provider.mic).toHaveBeenCalledTimes(sentMic);
  });

  it('stops context and microphone sends when optional voice is disabled while the match continues', async () => {
    const { session, messages } = setup();
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    await vi.advanceTimersByTimeAsync(5000);
    session.handleRaw('{"type":"voice_close"}');
    const contextCount = provider.context.mock.calls.length;
    const reactionCount = provider.reaction.mock.calls.length;
    session.handleRaw('{"type":"mic","audio":"AAAA"}');
    await vi.advanceTimersByTimeAsync(55000);
    expect(messages.find(m => m.type === 'match_ended')).toMatchObject({ snapshot: { status: 'result', round: 30 } });
    expect(provider.context).toHaveBeenCalledTimes(contextCount);
    expect(provider.reaction).toHaveBeenCalledTimes(reactionCount);
    expect(provider.mic).not.toHaveBeenCalled();
    await session.shutdown('test_finished');
  });

  it('keeps two sessions, duplicate commands, transcripts and teardown isolated for a full match', async () => {
    provider.start.mockResolvedValueOnce({ ...avatar, sessionId: 'avatar-a', livekitToken: 'token-a' }).mockResolvedValueOnce({ ...avatar, sessionId: 'avatar-b', livekitToken: 'token-b' });
    const a = setup('match-a'), b = setup('match-b');
    await a.session.initialize(); await b.session.initialize();
    a.session.handleRaw('{"type":"start"}'); b.session.handleRaw('{"type":"start"}');
    provider.bridges[0].onTranscript('assistant', 'reaction-a');
    provider.bridges[1].onTranscript('assistant', 'reaction-b');
    await vi.advanceTimersByTimeAsync(20_000);
    const command = { type: 'upgrade', commandId: 'same-id', offerIndex: 0, upgradeId: 'jackpot', matchId: 'match-b' };
    a.session.handleRaw(JSON.stringify(command));
    a.session.handleRaw(JSON.stringify({ ...command, matchId: 'match-a' }));
    a.session.handleRaw(JSON.stringify({ ...command, matchId: 'match-a', upgradeId: 'steady' }));
    b.session.handleRaw(JSON.stringify({ ...command, upgradeId: 'steady' }));
    await vi.advanceTimersByTimeAsync(40_000);
    expect(a.messages.find(m => m.type === 'match_ended')).toMatchObject({ snapshot: { matchId: 'match-a', round: 30, upgrades: { player: ['jackpot', 'steady'] } } });
    expect(b.messages.find(m => m.type === 'match_ended')).toMatchObject({ snapshot: { matchId: 'match-b', round: 30, upgrades: { player: ['steady', 'steady'] } } });
    expect(a.messages.some(m => m.type === 'error' && m.code === 'wrong_match')).toBe(true);
    expect(a.messages.filter(m => m.type === 'transcript')).toMatchObject([{ delta: 'reaction-a' }]);
    expect(b.messages.filter(m => m.type === 'transcript')).toMatchObject([{ delta: 'reaction-b' }]);
    for (const [session, matchId] of [[a, 'match-a'], [b, 'match-b']] as const) {
      expect(vi.mocked(chooseRivalUpgrade).mock.calls.filter(([snapshot]) => snapshot.matchId === matchId)).toHaveLength(2);
      expect(session.messages.filter(m => m.type === 'spin')).toHaveLength(30);
      session.messages.forEach((message, i) => expect(parseServerEnvelope(JSON.stringify(message))).toMatchObject({ streamSeq: i + 1, sessionId: matchId }));
    }
    await a.session.shutdown('test_finished');
    expect(provider.stop).toHaveBeenCalledWith('avatar-a');
    expect(provider.stop).not.toHaveBeenCalledWith('avatar-b');
    expect(b.release).not.toHaveBeenCalled();
    await b.session.shutdown('test_finished');
    expect(a.release).toHaveBeenCalledOnce(); expect(b.release).toHaveBeenCalledOnce();
  });
  it('bounds message floods and rejects invented score commands without mutating a ready game', async () => {
    const { session, messages, release, close } = setup();
    await session.initialize();
    session.handleRaw('{"type":"set_score","player":36000}');
    session.handleRaw('{"type":"upgrade","matchId":"test-match","commandId":"bad","offerIndex":0,"upgradeId":"always-seven"}');
    session.handleRaw('{"type":"mic","audio":"not base64"}');
    session.handleRaw('{"type":"snapshot"}');
    expect(messages.find(m => m.type === 'snapshot')).toMatchObject({ snapshot: { status: 'ready', round: 0, scores: { player: 0, rival: 0 } } });
    expect(messages.filter(m => m.type === 'error')).toHaveLength(3);
    for (let i = 0; i < 130; i += 1) session.handleRaw('{"type":"snapshot"}');
    await vi.advanceTimersByTimeAsync(1);
    expect(release).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('bounds audio bytes even when the message count is below its limit', async () => {
    const { session, release, close } = setup();
    await session.initialize();
    session.handleRaw(JSON.stringify({ type: 'mic', audio: 'A'.repeat(100000) }));
    expect(close).not.toHaveBeenCalled();
    session.handleRaw(JSON.stringify({ type: 'mic', audio: 'A'.repeat(100000) }));
    await vi.advanceTimersByTimeAsync(1);
    expect(close).toHaveBeenCalledOnce(); expect(release).toHaveBeenCalledOnce();
  });
  it('discards a rival answer returned after its deadline while the interval is stalled', async () => {
    const late = deferred<{ upgradeId: 'jackpot'; source: 'ai' }>();
    vi.mocked(chooseRivalUpgrade).mockReturnValueOnce(late.promise);
    const { session, messages } = setup();
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    await vi.advanceTimersByTimeAsync(20_000);
    vi.setSystemTime(Date.now() + 4_100);
    late.resolve({ upgradeId: 'jackpot', source: 'ai' });
    await late.promise;
    await vi.advanceTimersByTimeAsync(100);
    expect(messages.some(m => m.type === 'rival_line' && m.reason === 'upgrade_ai')).toBe(false);
    expect(messages.find(m => m.type === 'upgrade_applied' && m.offerIndex === 0)).toMatchObject({ rival: 'steady' });
    await session.shutdown('test_finished');
  });
  it('rejects upgrades arriving after the deadline while the interval tick is delayed', async () => {
    const { session, messages } = setup();
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    await vi.advanceTimersByTimeAsync(20_000);
    vi.setSystemTime(Date.now() + 4_100);
    session.handleRaw(JSON.stringify({ type: 'upgrade', matchId: 'test-match', commandId: crypto.randomUUID(), offerIndex: 0, upgradeId: 'jackpot' }));
    expect(messages.some(m => m.type === 'error' && m.code === 'upgrade_rejected')).toBe(true);
    expect(messages.find(m => m.type === 'upgrade_applied' && m.offerIndex === 0)).toMatchObject({ player: 'steady' });
    await session.shutdown('test_finished');
  });
  it('stops an avatar returned after the browser has disconnected', async () => {
    const late = deferred<typeof avatar>();
    provider.start.mockReturnValue(late.promise);
    const { session, release, messages, close } = setup();
    const initializing = session.initialize();
    const stopping = session.shutdown('socket_closed');
    late.resolve(avatar);
    await Promise.all([initializing, stopping]);
    expect(provider.stop).toHaveBeenCalledWith('test-session');
    expect(provider.mediaStart).not.toHaveBeenCalled();
    expect(provider.gptConnect).not.toHaveBeenCalled();
    expect(messages.some(m => m.type === 'avatar')).toBe(false);
    expect(release).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('does not open OpenAI after disconnecting during media setup', async () => {
    const late = deferred<boolean>();
    provider.mediaStart.mockReturnValue(late.promise);
    const { session, release } = setup();
    const initializing = session.initialize();
    await vi.waitFor(() => expect(provider.mediaStart).toHaveBeenCalled());
    const stopping = session.shutdown('socket_closed');
    late.resolve(true);
    await Promise.all([initializing, stopping]);
    expect(provider.gptConnect).not.toHaveBeenCalled();
    expect(provider.stop).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('ignores a late voice-ready callback after shutdown', async () => {
    const late = deferred<boolean>();
    provider.gptConnect.mockReturnValue(late.promise);
    const { session, messages } = setup();
    const initializing = session.initialize();
    await vi.waitFor(() => expect(provider.gptConnect).toHaveBeenCalled());
    const stopping = session.shutdown('socket_closed');
    provider.events?.onReady();
    late.resolve(true);
    await Promise.all([initializing, stopping]);
    expect(messages.some(m => m.type === 'voice_status' && m.status === 'ready')).toBe(false);
  });

  it('releases all resources once after the result reaction window', async () => {
    const { session, release, messages, close } = setup();
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(messages.filter(m => m.type === 'match_ended')).toHaveLength(1);
    expect(release).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(8_000);
    await Promise.all([session.shutdown('socket_closed'), session.shutdown('client_close')]);
    expect(provider.stop).toHaveBeenCalledTimes(1);
    expect(provider.gptClose).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['provider', 'browser'])('finishes the same 30-spin match after %s voice failure', async (source) => {
    const { session, release, messages, close } = setup();
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    await vi.advanceTimersByTimeAsync(25_000);
    const before = messages.filter(m => m.type === 'snapshot').at(-1);
    if (source === 'provider') provider.events?.onError('transport_closed');
    else session.handleRaw('{"type":"voice_close"}');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(provider.stop).toHaveBeenCalledTimes(1);
    expect(provider.gptClose).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(messages.some(m => m.type === 'error' && !m.recoverable)).toBe(false);
    await vi.advanceTimersByTimeAsync(14_000);
    session.handleRaw(JSON.stringify({ type: 'upgrade', matchId: 'test-match', commandId: 'after-voice-failure', offerIndex: 1, upgradeId: 'jackpot' }));
    await vi.advanceTimersByTimeAsync(20_000);
    const final = messages.find(m => m.type === 'match_ended');
    expect(final).toMatchObject({ snapshot: { matchId: 'test-match', status: 'result', elapsed: 60, round: 30, upgrades: { player: ['steady', 'jackpot'] } } });
    expect(messages.filter(m => m.type === 'spin')).toHaveLength(30);
    if (before?.type === 'snapshot' && final?.type === 'match_ended') {
      expect(final.snapshot.scores.player).toBeGreaterThanOrEqual(before.snapshot.scores.player);
      expect(final.snapshot.scores.rival).toBeGreaterThanOrEqual(before.snapshot.scores.rival);
    }
    expect(chooseRivalUpgrade).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(provider.stop).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('allows starting after optional media fails in the ready lobby', async () => {
    const { session, messages } = setup();
    await session.initialize();
    provider.events?.onError('transport_closed');
    provider.events?.onReady();
    session.handleRaw('{"type":"start"}');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(messages.filter(m => m.type === 'match_ended')).toHaveLength(1);
    expect(chooseRivalUpgrade).not.toHaveBeenCalled();
    expect(messages.filter(m => m.type === 'voice_status' && m.status === 'ready')).toHaveLength(1);
    await session.shutdown('test_finished');
  });

  it('cleans up an initialization failure and repeated initialize calls', async () => {
    provider.mediaStart.mockResolvedValue(false);
    const { session, release } = setup();
    await Promise.all([session.initialize(), session.initialize()]);
    await session.shutdown('test_finished');
    expect(provider.start).toHaveBeenCalledTimes(1);
    expect(provider.stop).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });
});
