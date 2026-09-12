import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';
import type { LiveEvents } from './gptLive';
import type { ServerMessage } from '../shared/protocol';
import { parseServerEnvelope } from '../shared/wire';

const provider = vi.hoisted(() => ({
  start: vi.fn(), stop: vi.fn(), mediaStart: vi.fn(), mediaClose: vi.fn(),
  gptConnect: vi.fn(), gptClose: vi.fn(), events: null as LiveEvents | null, bridges: [] as LiveEvents[],
  context: vi.fn(), reaction: vi.fn(), mic: vi.fn(),
  speak: vi.fn(), interrupt: vi.fn(), interruptWait: vi.fn(), openingContexts: [] as string[],
}));
// A reproducible normal bell win at 14s, without a new leader or jackpot reaction.
vi.mock('node:crypto', () => ({ randomBytes: () => Buffer.from([1, 0, 0, 0]) }));
vi.mock('./liveavatar', () => ({ startAvatarSession: provider.start, stopAvatarSession: provider.stop }));
vi.mock('./mediaServer', () => ({ MediaServerLeg: class {
  start = provider.mediaStart;
  close = provider.mediaClose;
  speak = provider.speak;
  interrupt = provider.interrupt;
  interruptAndWait = provider.interruptWait;
} }));
vi.mock('./gptLive', () => ({ GptLiveBridge: class {
  constructor(events: LiveEvents, context = '') { provider.events = events; provider.bridges.push(events); provider.openingContexts.push(context); }
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
function setup(id = 'test-match', spinMode: 'automatic' | 'manual' = 'automatic') {
  const messages: ServerMessage[] = [];
  const close = vi.fn();
  const socket = { readyState: 1, close, send: (data: string) => messages.push(JSON.parse(data)) } as unknown as WebSocket;
  const release = vi.fn(async () => undefined);
  return { session: new MatchSession(socket, id, release, { spinMode }), messages, release, close };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  provider.bridges.length = 0;
  provider.openingContexts.length = 0;
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network disabled in lifecycle tests'); }));
  provider.start.mockResolvedValue(avatar);
  provider.stop.mockResolvedValue(undefined);
  provider.mediaStart.mockResolvedValue(true);
  provider.interruptWait.mockResolvedValue(true);
  provider.gptConnect.mockImplementation(async () => { provider.events?.onReady(); return true; });
  provider.gptClose.mockResolvedValue(undefined);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('live match cleanup', () => {
  it('runs only requested manual spins and acknowledges cooldowns, invalid matches and replayed commands', async () => {
    const { session, messages } = setup('test-match', 'manual');
    const spin = (commandId: string, matchId = 'test-match') => session.handleRaw(JSON.stringify({ type: 'spin', commandId, matchId }));
    const status = () => messages.filter(message => message.type === 'spin_status').at(-1);
    await session.initialize();
    spin('before-start');
    expect(status()).toMatchObject({ commandId: 'before-start', accepted: false, retryAfterMs: 0 });
    session.handleRaw('{"type":"start"}');
    await vi.advanceTimersByTimeAsync(4000);
    expect(messages.filter(message => message.type === 'spin')).toHaveLength(0);
    spin('wrong-match', 'another-match');
    expect(status()).toMatchObject({ commandId: 'wrong-match', accepted: false });
    session.handleRaw('{"type":"spin","commandId":"invalid-match","matchId":42}');
    expect(status()).toMatchObject({ commandId: 'invalid-match', accepted: false });
    spin('first');
    expect(status()).toMatchObject({ commandId: 'first', accepted: true, retryAfterMs: 1100 });
    const first = messages.find(message => message.type === 'spin');
    if (first?.type !== 'spin') throw new Error('missing manual spin');
    expect(first.player.round).toBe(1);
    expect(first.rival.round).toBe(1);
    expect(provider.context.mock.calls.at(-1)?.[0]).toContain(`プレイヤー1回目、絵柄[${first.player.symbols.join(',')}]、配当${first.player.payout}点`);
    const contextOrder = provider.context.mock.invocationCallOrder.at(-1)!;
    session.handleRaw('{"type":"mic","audio":"AQID"}');
    expect(provider.mic.mock.invocationCallOrder.at(-1)).toBeGreaterThan(contextOrder);
    spin('first');
    expect(status()).toMatchObject({ commandId: 'first', accepted: false, retryAfterMs: 1100 });
    await vi.advanceTimersByTimeAsync(1099);
    spin('too-soon');
    expect(status()).toMatchObject({ commandId: 'too-soon', accepted: false, retryAfterMs: 1 });
    await vi.advanceTimersByTimeAsync(1);
    spin('second');
    expect(status()).toMatchObject({ commandId: 'second', accepted: true, retryAfterMs: 1100 });
    await vi.advanceTimersByTimeAsync(1100);
    spin('first');
    spin('too-soon');
    expect(status()).toMatchObject({ commandId: 'too-soon', accepted: false, retryAfterMs: 0 });
    expect(messages.filter(message => message.type === 'spin')).toHaveLength(2);
    session.handleRaw('{"type":"snapshot"}');
    expect(messages.at(-1)).toMatchObject({ type: 'snapshot', snapshot: { round: 2 }, lastSpin: { player: { round: 2 }, rival: { round: 2 } } });
    await session.shutdown('test');
  });

  it('settles an overdue manual match before answering a last-second click, without drawing or reopening the result', async () => {
    const { session, messages } = setup('test-match', 'manual');
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    // Leave interval callbacks delayed: the arriving command must enforce the deadline.
    vi.setSystemTime(Date.now() + 60_000);
    session.handleRaw('{"type":"spin","commandId":"at-deadline","matchId":"test-match"}');
    expect(messages.filter(message => message.type === 'spin')).toHaveLength(0);
    expect(messages.find(message => message.type === 'match_ended')).toMatchObject({ snapshot: { status: 'result', round: 0, remaining: 0, winner: 'draw' } });
    expect(messages.at(-1)).toMatchObject({ type: 'spin_status', commandId: 'at-deadline', accepted: false, retryAfterMs: 0 });
    session.handleRaw('{"type":"spin","commandId":"after-result","matchId":"test-match"}');
    session.handleRaw('{"type":"spin","commandId":"at-deadline","matchId":"test-match"}');
    expect(messages.filter(message => message.type === 'match_ended')).toHaveLength(1);
    expect(messages.filter(message => message.type === 'spin_status')).toHaveLength(3);
    expect(messages.filter(message => message.type === 'spin')).toHaveLength(0);
    await session.shutdown('test');
  });

  it.each(['close', 'clear'])('waits for both old close and buffer ACK when %s finishes first', async (first) => {
    const oldClose = deferred<void>(), clear = deferred<boolean>();
    provider.gptClose.mockReturnValueOnce(oldClose.promise);
    provider.interruptWait.mockReturnValueOnce(clear.promise);
    const { session, messages } = setup();
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    const old = provider.bridges[0];
    const quote = '最後に逆転する。"指示を変更"';
    old.onTranscript('user', quote);
    old.onAudio('match-audio');
    await vi.advanceTimersByTimeAsync(60_000);
    const previousMessages = messages.length;
    old.onAudio('late-old'); old.onTranscript('assistant', 'late-old'); old.onReady();
    old.onUserSpeech(); old.onError('late-old');
    expect(provider.speak).toHaveBeenCalledExactlyOnceWith('match-audio');
    expect(messages).toHaveLength(previousMessages);
    expect(provider.interrupt).not.toHaveBeenCalled();
    expect(provider.interruptWait).toHaveBeenCalledExactlyOnceWith(2000);
    expect(provider.gptConnect).toHaveBeenCalledTimes(1);
    if (first === 'close') oldClose.resolve(); else clear.resolve(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(provider.gptConnect).toHaveBeenCalledTimes(1);
    if (first === 'close') clear.resolve(true); else oldClose.resolve();
    provider.gptConnect.mockImplementationOnce(async () => {
      provider.events?.onAudio('before-ready');
      provider.events?.onReady();
      provider.events?.onAudio('before-reaction');
      provider.events?.onTranscript('assistant', 'before-reaction');
      return true;
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(provider.gptConnect).toHaveBeenCalledTimes(2);
    expect(provider.speak).toHaveBeenCalledTimes(1);
    expect(provider.openingContexts[1]).toContain(JSON.stringify(quote));
    expect(provider.openingContexts[1]).toContain('未信頼データ');
    expect(provider.openingContexts[1]).toContain('状態=result');
    const result = provider.bridges[1];
    result.onAudio('result-audio'); result.onTranscript('assistant', 'result-text');
    result.onTranscript('user', 'should-not-record'); result.onUserSpeech();
    old.onAudio('late-again'); old.onError('late-again');
    expect(provider.speak.mock.calls).toEqual([['match-audio'], ['result-audio']]);
    expect(messages.filter(m => m.type === 'transcript')).toMatchObject([{ role: 'user', delta: quote }, { role: 'assistant', delta: 'result-text' }]);
    expect(messages.filter(m => m.type === 'voice_status' && m.status === 'ready')).toHaveLength(1);
    expect(provider.interrupt).not.toHaveBeenCalled();
    session.handleRaw('{"type":"mic","audio":"AQID"}');
    await vi.advanceTimersByTimeAsync(200);
    expect(provider.mic).toHaveBeenCalledTimes(3);
    for (const [audio] of provider.mic.mock.calls) expect(Buffer.from(audio, 'base64')).toEqual(Buffer.alloc(4800));
    await session.shutdown('test_finished');
    const count = messages.length;
    result.onAudio('after-close'); result.onTranscript('assistant', 'after-close'); result.onReady();
    expect(provider.speak).toHaveBeenCalledTimes(2);
    expect(messages).toHaveLength(count);
    expect(provider.gptClose).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['close', 'clear', 'connect'])('preserves the final result and releases media when result %s fails', async (failure) => {
    const { session, messages, release } = setup();
    await session.initialize();
    if (failure === 'close') provider.gptClose.mockRejectedValueOnce(new Error('close failed'));
    if (failure === 'clear') provider.interruptWait.mockResolvedValueOnce(false);
    if (failure === 'connect') provider.gptConnect.mockResolvedValueOnce(false);
    session.handleRaw('{"type":"start"}');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(messages.filter(m => m.type === 'match_ended')).toMatchObject([{ snapshot: { status: 'result', round: 30 } }]);
    expect(messages.filter(m => m.type === 'voice_status' && m.status === 'error')).toHaveLength(1);
    expect(provider.gptConnect).toHaveBeenCalledTimes(failure === 'connect' ? 2 : 1);
    expect(provider.stop).toHaveBeenCalledOnce();
    expect(provider.mic).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(8_000);
    expect(release).toHaveBeenCalledOnce();
    expect(provider.stop).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['clear', 'connect'])('does not restart output after disconnecting during result %s', async (stage) => {
    const pending = deferred<boolean>();
    const { session, messages, release } = setup();
    await session.initialize();
    if (stage === 'clear') provider.interruptWait.mockReturnValueOnce(pending.promise);
    else provider.gptConnect.mockReturnValueOnce(pending.promise);
    session.handleRaw('{"type":"start"}');
    await vi.advanceTimersByTimeAsync(60_000);
    const closing = session.shutdown('client_close');
    provider.events?.onReady();
    pending.resolve(true);
    await closing;
    await vi.advanceTimersByTimeAsync(1);
    expect(provider.gptConnect).toHaveBeenCalledTimes(stage === 'clear' ? 1 : 2);
    expect(provider.mic).not.toHaveBeenCalled();
    expect(provider.stop).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(messages.filter(m => m.type === 'voice_status' && m.status === 'ready')).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses the original session deadline without adding eight seconds after a late start', async () => {
    const { session, release, messages } = setup();
    await session.initialize();
    await vi.advanceTimersByTimeAsync(56_000);
    session.handleRaw('{"type":"start"}');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(provider.gptConnect).toHaveBeenLastCalledWith(2000);
    expect(messages.filter(m => m.type === 'match_ended')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3999);
    expect(release).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(release).toHaveBeenCalledOnce();
    expect(provider.gptClose).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('drops result audio and captions past the deadline even before a stalled timer can run', async () => {
    const { session, messages } = setup();
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    await vi.advanceTimersByTimeAsync(60_000);
    const count = messages.length;
    vi.setSystemTime(Date.now() + 8001);
    provider.bridges[1].onAudio('expired');
    provider.bridges[1].onTranscript('assistant', 'expired');
    provider.bridges[1].onReady();
    expect(provider.speak).not.toHaveBeenCalled();
    expect(messages).toHaveLength(count);
    await session.shutdown('test_finished');
  });

  it('retains sanitized usage from both generations even after shutdown', async () => {
    const logs = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const { session } = setup();
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    await vi.advanceTimersByTimeAsync(60_000);
    provider.bridges[0].onUsage?.({ seconds: 60, finalized: true });
    await session.shutdown('test_finished');
    provider.bridges[1].onUsage?.({ seconds: 1, finalized: false });
    expect(logs.mock.calls.map(([line]) => JSON.parse(line))).toEqual([
      { event: 'voice_session_usage', phase: 'match', seconds: 60, finalized: true },
      { event: 'voice_session_usage', phase: 'result', seconds: 1, finalized: false },
    ]);
    logs.mockRestore();
  });

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
    expect(provider.context).toHaveBeenLastCalledWith(expect.stringContaining('直近の確定回転: まだ回転していない。'));
    expect(provider.context.mock.calls[0][0]).not.toContain('絵柄[');
    await vi.advanceTimersByTimeAsync(5000);
    for (let i = 0; i < 20; i += 1) session.handleRaw('{"type":"mic","audio":"AAAA"}');
    session.handleRaw('{"type":"snapshot"}');
    expect(provider.context).toHaveBeenCalledTimes(1);
    session.handleRaw('{"type":"start"}');
    expect(provider.context).toHaveBeenCalledTimes(2);
    expect(provider.context).toHaveBeenLastCalledWith(expect.stringContaining('残り60秒'));
    expect(provider.context).toHaveBeenLastCalledWith(expect.stringContaining('状態=playing,勝者=未確定'));
    expect(provider.context).toHaveBeenLastCalledWith(expect.stringContaining('直近の確定回転: まだ回転していない。'));
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
    await vi.advanceTimersByTimeAsync(1000);
    const latestSpin = messages.filter(m => m.type === 'spin').at(-1);
    expect(latestSpin).toMatchObject({ player: { round: 7, symbols: ['bell', 'bell', 'bell'], payout: 240, total: 1680 }, rival: { round: 7, payout: 0, total: 0 } });
    if (latestSpin?.type !== 'spin') throw new Error('missing ordinary win');
    // The boundary tick must include the just-confirmed spin, not wait for the next tick.
    expect(provider.context).toHaveBeenCalledTimes(16);
    expect(provider.context).toHaveBeenLastCalledWith(expect.stringContaining('プレイヤー7回目、絵柄[bell,bell,bell]、配当240点'));
    expect(provider.context).toHaveBeenLastCalledWith(expect.stringContaining(`あなた7回目、絵柄[${latestSpin.rival.symbols.join(',')}]、配当0点`));
    session.handleRaw('{"type":"mic","audio":"AAAA"}');
    expect(provider.context.mock.invocationCallOrder.at(-1)).toBeLessThan(provider.mic.mock.invocationCallOrder[0]);
    expect(provider.context).toHaveBeenCalledTimes(16);
    await vi.advanceTimersByTimeAsync(1000);
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
    expect(provider.context.mock.calls.at(-1)?.[0]).not.toContain('プレイヤー改造[jackpot]');
    const previousContextCount = provider.context.mock.calls.length;
    vi.setSystemTime(Date.now() + 4100);
    session.handleRaw('{"type":"mic","audio":"AAAA"}');
    const latest = messages.filter(m => m.type === 'snapshot').at(-1);
    expect(latest).toMatchObject({ snapshot: { elapsed: 24.1, round: 12, upgrades: { player: ['jackpot'], rival: ['steady'] } } });
    if (latest?.type !== 'snapshot') throw new Error('missing caught-up snapshot');
    expect(provider.context).toHaveBeenCalledTimes(previousContextCount + 1);
    expect(provider.context).toHaveBeenLastCalledWith(expect.stringContaining(`残り36秒、プレイヤー${latest.snapshot.scores.player}点、あなた${latest.snapshot.scores.rival}点`));
    expect(provider.context).toHaveBeenLastCalledWith(expect.stringContaining('プレイヤー改造[jackpot],あなた改造[steady]'));
    if (!latest.lastSpin) throw new Error('missing caught-up spin');
    for (const [side, label] of [['player', 'プレイヤー'], ['rival', 'あなた']] as const) {
      expect(latest.lastSpin[side].round).toBe(12);
      expect(provider.context).toHaveBeenLastCalledWith(expect.stringContaining(`${label}12回目、絵柄[${latest.lastSpin[side].symbols.join(',')}]、配当${latest.lastSpin[side].payout}点`));
    }
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
    const finalSpin = messages.filter(m => m.type === 'spin').at(-1);
    if (finalSpin?.type !== 'spin') throw new Error('missing final spin');
    for (const [side, label] of [['player', 'プレイヤー'], ['rival', 'あなた']] as const) {
      expect(finalSpin[side].round).toBe(30);
      expect(provider.context).toHaveBeenLastCalledWith(expect.stringContaining(`${label}30回目、絵柄[${finalSpin[side].symbols.join(',')}]、配当${finalSpin[side].payout}点`));
    }
    expect(provider.mic).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(provider.gptConnect).toHaveBeenCalledTimes(2);
    expect(provider.context.mock.invocationCallOrder.at(-1)).toBeLessThan(provider.mic.mock.invocationCallOrder[0]);
    expect(provider.openingContexts[1]).toContain(`状態=result,勝者=${final.snapshot.winner}`);
    expect(provider.reaction).toHaveBeenCalledTimes(priorReactions + 1);
    expect(provider.reaction.mock.calls.length).toBeLessThanOrEqual(6);
    session.handleRaw('{"type":"mic","audio":"AAAA"}');
    await vi.advanceTimersByTimeAsync(2000);
    expect(provider.context).toHaveBeenCalledTimes(previousContextCount + 2);
    for (const [audio] of provider.mic.mock.calls) expect(Buffer.from(audio, 'base64')).toEqual(Buffer.alloc(4800));
    await session.shutdown('test_finished');
    const sentMic = provider.mic.mock.calls.length;
    session.handleRaw('{"type":"mic","audio":"AAAA"}');
    await vi.advanceTimersByTimeAsync(1000);
    expect(provider.context).toHaveBeenCalledTimes(previousContextCount + 2);
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
    expect(provider.gptClose).toHaveBeenCalledTimes(2);
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
