import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';
import type { LiveEvents } from './gptLive';
import type { ServerMessage } from '../shared/protocol';
import { parseServerEnvelope } from '../shared/wire';

const provider = vi.hoisted(() => ({
  start: vi.fn(), stop: vi.fn(), mediaStart: vi.fn(), mediaClose: vi.fn(),
  mediaFailures: [] as Array<() => void>,
  gptConnect: vi.fn(), gptClose: vi.fn(), events: null as LiveEvents | null, bridges: [] as LiveEvents[],
  context: vi.fn(), reaction: vi.fn(), confirmedLine: vi.fn(), delegationResult: vi.fn(), delegationThinking: vi.fn(), suppress: vi.fn(), mic: vi.fn(),
  speak: vi.fn(), interrupt: vi.fn(), interruptWait: vi.fn(), openingContexts: [] as string[],
  seed: [1, 0, 0, 0] as [number, number, number, number],
}));
// A reproducible normal bell win at 14s, without a new leader or jackpot reaction.
vi.mock('node:crypto', () => ({ randomBytes: () => Buffer.from(provider.seed), randomUUID: () => 'extension-speech-id' }));
vi.mock('./liveavatar', () => ({ startAvatarSession: provider.start, stopAvatarSession: provider.stop }));
vi.mock('./mediaServer', () => ({ MediaServerLeg: class {
  constructor(_url: string, onFailure: () => void) { provider.mediaFailures.push(onFailure); }
  start = provider.mediaStart;
  close = provider.mediaClose;
  speak = provider.speak;
  interrupt = provider.interrupt;
  interruptAndWait = provider.interruptWait;
  completeSpeechInput = vi.fn();
} }));
vi.mock('./gptLive', () => ({ GptLiveBridge: class {
  constructor(events: LiveEvents, context = '') { provider.events = events; provider.bridges.push(events); provider.openingContexts.push(context); }
  connect = provider.gptConnect;
  close = provider.gptClose;
  updateGameContext = provider.context;
  requestReaction = provider.reaction;
  requestConfirmedLine = provider.confirmedLine;
  requestDelegationResult = provider.delegationResult;
  requestDelegationThinking = provider.delegationThinking;
  suppressOutput = provider.suppress;
  sendMic = provider.mic;
} }));
vi.mock('./rivalBrain', () => ({
  chooseRivalUpgrade: vi.fn(async () => ({ upgradeId: 'steady', source: 'fallback' })),
  chooseTimeExtension: vi.fn(async () => 'reject_extension'),
}));
import { MatchSession } from './matchSession';
import { chooseTimeExtension } from './rivalBrain';

const avatar = { sessionId: 'test-session', livekitUrl: 'test-url', livekitToken: 'test-token', mediaWsUrl: 'test-media' };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function finishAudioExtension(session: MatchSession): void {
  const speechId = provider.delegationResult.mock.calls.at(-1)?.[2];
  expect(speechId).toBeTypeOf('string');
  provider.events?.onSpeechAudioEnded(speechId);
  session.handleRaw(JSON.stringify({ type: 'voice_speech_done', speechId }));
}
// All live sessions use the bankroll rules; automatic mode remains useful for lifecycle timing.
function setup(id = 'test-match', spinMode: 'automatic' | 'manual' = 'automatic', voiceMode: 'audio' | 'avatar' = 'avatar', random: () => number = () => 1) {
  const messages: ServerMessage[] = [];
  const close = vi.fn();
  const socket = { readyState: 1, close, send: (data: string) => messages.push(JSON.parse(data)) } as unknown as WebSocket;
  const release = vi.fn(async () => undefined);
  return { session: new MatchSession(socket, id, release, { spinMode, voiceMode, random }), messages, release, close };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  provider.seed = [1, 0, 0, 0];
  provider.bridges.length = 0;
  provider.openingContexts.length = 0;
  provider.mediaFailures.length = 0;
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network disabled in lifecycle tests'); }));
  provider.start.mockResolvedValue(avatar);
  provider.stop.mockResolvedValue(undefined);
  provider.mediaStart.mockResolvedValue(true);
  provider.interruptWait.mockResolvedValue(true);
  provider.gptConnect.mockImplementation(async () => { provider.events?.onReady(); return true; });
  provider.gptClose.mockResolvedValue(undefined);
  vi.mocked(chooseTimeExtension).mockResolvedValue('reject_extension');
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('provider status lifecycle', () => {
  const providerMessages = (messages: ServerMessage[]) => messages
    .filter((message): message is Extract<ServerMessage, { type: 'provider_status' }> => message.type === 'provider_status')
    .map(({ type, provider, state }) => ({ type, provider, state }));

  it('reports only GPT-Live for a successful audio session and closes it normally', async () => {
    const { session, messages } = setup('audio-status', 'manual', 'audio');
    await session.initialize();
    expect(providerMessages(messages)).toEqual([
      { type: 'provider_status', provider: 'gptLive', state: 'connecting' },
      { type: 'provider_status', provider: 'gptLive', state: 'connected' },
    ]);
    await session.shutdown('normal_close');
    expect(providerMessages(messages)).toEqual([
      { type: 'provider_status', provider: 'gptLive', state: 'connecting' },
      { type: 'provider_status', provider: 'gptLive', state: 'connected' },
      { type: 'provider_status', provider: 'gptLive', state: 'closed' },
    ]);
  });

  it('reports GPT-Live failure without inventing avatar activity for audio', async () => {
    provider.gptConnect.mockResolvedValue(false);
    const { session, messages } = setup('audio-failure', 'manual', 'audio');
    await session.initialize();
    await vi.runAllTimersAsync();
    expect(providerMessages(messages)).toEqual([
      { type: 'provider_status', provider: 'gptLive', state: 'connecting' },
      { type: 'provider_status', provider: 'gptLive', state: 'failed' },
    ]);
  });

  it.each([
    ['avatar_start', () => provider.start.mockRejectedValueOnce(new Error('avatar_start_failed'))],
    ['media_leg', () => provider.mediaStart.mockResolvedValueOnce(false)],
  ])('reports a failed LiveAvatar %s without starting GPT-Live', async (_stage, arrange) => {
    arrange();
    const { session, messages } = setup('avatar-failure', 'manual', 'avatar');
    await session.initialize();
    await vi.runAllTimersAsync();
    expect(providerMessages(messages)).toEqual([
      { type: 'provider_status', provider: 'liveAvatar', state: 'connecting' },
      { type: 'provider_status', provider: 'liveAvatar', state: 'failed' },
    ]);
    expect(provider.gptConnect).not.toHaveBeenCalled();
  });

  it('reports both providers without any token, URL, or session id in status messages', async () => {
    const { session, messages } = setup('avatar-status', 'manual', 'avatar');
    await session.initialize();
    const statuses = providerMessages(messages);
    expect(statuses).toEqual([
      { type: 'provider_status', provider: 'liveAvatar', state: 'connecting' },
      { type: 'provider_status', provider: 'liveAvatar', state: 'connected' },
      { type: 'provider_status', provider: 'gptLive', state: 'connecting' },
      { type: 'provider_status', provider: 'gptLive', state: 'connected' },
    ]);
    expect(JSON.stringify(statuses)).not.toContain('test-token');
    expect(JSON.stringify(statuses)).not.toContain('test-url');
    expect(JSON.stringify(statuses)).not.toContain('test-session');
    await session.shutdown('normal_close');
  });

  it('marks only GPT-Live failed after its post-connect runtime error', async () => {
    const { session, messages, release, close } = setup('gpt-runtime-failure', 'automatic', 'avatar');
    await session.initialize();
    provider.events?.onError('transport_closed');
    await vi.advanceTimersByTimeAsync(1);
    const statuses = providerMessages(messages);
    expect(statuses).toContainEqual({ type: 'provider_status', provider: 'gptLive', state: 'failed' });
    expect(statuses).toContainEqual({ type: 'provider_status', provider: 'liveAvatar', state: 'closed' });
    expect(statuses).not.toContainEqual({ type: 'provider_status', provider: 'liveAvatar', state: 'failed' });
    expect(provider.stop).toHaveBeenCalledWith('test-session');
    expect(release).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    session.handleRaw('{"type":"start"}');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(messages.some(message => message.type === 'match_ended')).toBe(true);
  });

  it('marks only LiveAvatar failed after its post-connect media runtime error', async () => {
    const { session, messages, release, close } = setup('avatar-runtime-failure', 'automatic', 'avatar');
    await session.initialize();
    expect(provider.mediaFailures).toHaveLength(1);
    provider.mediaFailures[0]!();
    await vi.advanceTimersByTimeAsync(1);
    const statuses = providerMessages(messages);
    expect(statuses).toContainEqual({ type: 'provider_status', provider: 'liveAvatar', state: 'failed' });
    expect(statuses).toContainEqual({ type: 'provider_status', provider: 'gptLive', state: 'closed' });
    expect(statuses).not.toContainEqual({ type: 'provider_status', provider: 'gptLive', state: 'failed' });
    expect(provider.stop).toHaveBeenCalledWith('test-session');
    expect(release).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    session.handleRaw('{"type":"start"}');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(messages.some(message => message.type === 'match_ended')).toBe(true);
  });

  it('closes connected providers for a browser voice_close and lets the CPU match finish', async () => {
    const { session, messages } = setup('voice-close-status', 'automatic', 'avatar');
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    session.handleRaw('{"type":"voice_close"}');
    await vi.advanceTimersByTimeAsync(1);
    const statuses = providerMessages(messages);
    expect(statuses).toContainEqual({ type: 'provider_status', provider: 'gptLive', state: 'closed' });
    expect(statuses).toContainEqual({ type: 'provider_status', provider: 'liveAvatar', state: 'closed' });
    expect(statuses.some(status => status.state === 'failed')).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(messages.some(message => message.type === 'match_ended')).toBe(true);
  });

  it('closes connected providers when the voice session reaches its deadline', async () => {
    const { session, messages } = setup('voice-deadline-status', 'automatic', 'avatar');
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    (session as unknown as { expireVoice(): void }).expireVoice();
    await vi.advanceTimersByTimeAsync(1);
    const statuses = providerMessages(messages);
    expect(statuses).toContainEqual({ type: 'provider_status', provider: 'gptLive', state: 'closed' });
    expect(statuses).toContainEqual({ type: 'provider_status', provider: 'liveAvatar', state: 'closed' });
    expect(statuses.some(status => status.state === 'failed')).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(messages.some(message => message.type === 'match_ended')).toBe(true);
  });

  it('marks only GPT-Live failed when closing the old bridge for the result fails', async () => {
    provider.gptClose.mockRejectedValueOnce(new Error('old_bridge_close_failed'));
    const { session, messages } = setup('result-gpt-close-failure', 'automatic', 'avatar');
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    await vi.advanceTimersByTimeAsync(60_001);
    const statuses = providerMessages(messages);
    expect(statuses).toContainEqual({ type: 'provider_status', provider: 'gptLive', state: 'failed' });
    expect(statuses).toContainEqual({ type: 'provider_status', provider: 'liveAvatar', state: 'closed' });
    expect(statuses).not.toContainEqual({ type: 'provider_status', provider: 'liveAvatar', state: 'failed' });
  });

  it('marks only LiveAvatar failed when clearing avatar media for the result fails', async () => {
    provider.interruptWait.mockResolvedValueOnce(false);
    const { session, messages } = setup('result-avatar-clear-failure', 'automatic', 'avatar');
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    await vi.advanceTimersByTimeAsync(60_001);
    const statuses = providerMessages(messages);
    expect(statuses).toContainEqual({ type: 'provider_status', provider: 'liveAvatar', state: 'failed' });
    expect(statuses).toContainEqual({ type: 'provider_status', provider: 'gptLive', state: 'closed' });
    expect(statuses).not.toContainEqual({ type: 'provider_status', provider: 'gptLive', state: 'failed' });
  });

  it('closes the audio-only GPT session without a false failure when browser audio clear fails', async () => {
    const { session, messages } = setup('result-browser-clear-failure', 'automatic', 'audio');
    (session as unknown as { clearBrowserAudio(): Promise<boolean> }).clearBrowserAudio = async () => false;
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    await vi.advanceTimersByTimeAsync(60_001);
    const statuses = providerMessages(messages);
    expect(statuses).toContainEqual({ type: 'provider_status', provider: 'gptLive', state: 'closed' });
    expect(statuses).not.toContainEqual({ type: 'provider_status', provider: 'gptLive', state: 'failed' });
  });
});

describe('live match cleanup', () => {
  it('keeps a manual match on base reels and rejects disabled upgrade messages', async () => {
    const { session, messages } = setup('base-only', 'manual');
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    let previous = 0;
    for (const at of [0, 20000, 40000, 59000]) {
      await vi.advanceTimersByTimeAsync(at - previous);
      previous = at;
      session.handleRaw(JSON.stringify({ type: 'upgrade', matchId: 'base-only', commandId: `old-upgrade-${at}`, offerIndex: at < 40000 ? 0 : 1, upgradeId: 'jackpot' }));
      session.handleRaw(JSON.stringify({ type: 'spin', matchId: 'base-only', commandId: `spin-${at}` }));
    }
    await vi.advanceTimersByTimeAsync(1000);
    expect(messages.find(message => message.type === 'match_ended')).toMatchObject({ snapshot: { status: 'result', round: 4, upgrades: { player: [], rival: [] } } });
    expect(messages.some(message => message.type === 'upgrade_offer' || message.type === 'upgrade_applied')).toBe(false);
    expect(messages.filter(message => message.type === 'error' && message.code === 'upgrade_rejected')).toHaveLength(4);
    expect(provider.context.mock.calls.every(([text]) => !text.includes('プレイヤー改造'))).toBe(true);
    await session.shutdown('test_finished');
  });

  it('runs independent rival spins and requested player spins and acknowledges cooldowns, invalid matches and replayed commands', async () => {
    const { session, messages } = setup('test-match', 'manual');
    const spin = (commandId: string, matchId = 'test-match') => session.handleRaw(JSON.stringify({ type: 'spin', commandId, matchId }));
    const status = () => messages.filter(message => message.type === 'spin_status').at(-1);
    await session.initialize();
    spin('before-start');
    expect(status()).toMatchObject({ commandId: 'before-start', accepted: false, retryAfterMs: 0 });
    session.handleRaw('{"type":"start"}');
    await vi.advanceTimersByTimeAsync(4000);
    expect(messages.filter(message => message.type === 'side_spin' && message.spin.side === 'player')).toHaveLength(0);
    spin('wrong-match', 'another-match');
    expect(status()).toMatchObject({ commandId: 'wrong-match', accepted: false });
    session.handleRaw('{"type":"spin","commandId":"invalid-match","matchId":42}');
    expect(status()).toMatchObject({ commandId: 'invalid-match', accepted: false });
    spin('first');
    expect(status()).toMatchObject({ commandId: 'first', accepted: true, retryAfterMs: 1100 });
    const first = messages.find(message => message.type === 'side_spin' && message.spin.side === 'player');
    if (first?.type !== 'side_spin') throw new Error('missing manual spin');
    expect(first.spin.round).toBe(1);
    expect(messages.filter(message => message.type === 'side_spin' && message.spin.side === 'rival')).toHaveLength(2);
    expect(provider.context.mock.calls.at(-1)?.[0]).toContain(`プレイヤー1回目、BET $${first.spin.bet}、配当$${first.spin.payout}`);
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
    expect(messages.filter(message => message.type === 'side_spin' && message.spin.side === 'player')).toHaveLength(2);
    session.handleRaw('{"type":"snapshot"}');
    expect(messages.at(-1)).toMatchObject({ type: 'snapshot', snapshot: { rounds: { player: 2, rival: 3 } }, lastSpins: { player: { round: 2 }, rival: { round: 3 } } });
    await session.shutdown('test');
  });

  it('applies a selected bet to the next spin and rejects it after the bankroll is exhausted', async () => {
    provider.seed = [0, 0, 0, 1];
    const { session, messages } = setup('bankroll-match', 'manual');
    const spin = (commandId: string) => session.handleRaw(JSON.stringify({ type: 'spin', commandId, matchId: 'bankroll-match' }));
    await session.initialize();
    session.handleRaw('{"type":"set_bet","matchId":"bankroll-match","commandId":"bet-five","bet":5}');
    expect(messages.filter(message => message.type === 'bet_status').at(-1)).toMatchObject({ commandId: 'bet-five', accepted: true, bet: 5 });
    session.handleRaw('{"type":"start"}');
    spin('drain-1');
    expect(messages.filter(message => message.type === 'side_spin' && message.spin.side === 'player').at(-1)).toMatchObject({ spin: { round: 1, bet: 5 } });
    let drained = false;
    for (let round = 2; round <= 53; round += 1) {
      await vi.advanceTimersByTimeAsync(1100);
      spin(`drain-${round}`);
      const status = messages.filter(message => message.type === 'spin_status').at(-1);
      expect(status).toMatchObject({ commandId: `drain-${round}` });
      if (status?.type === 'spin_status' && !status.accepted) { drained = true; break; }
    }
    expect(drained).toBe(true);
    session.handleRaw('{"type":"set_bet","matchId":"bankroll-match","commandId":"insufficient","bet":5}');
    expect(messages.filter(message => message.type === 'bet_status').at(-1)).toMatchObject({ commandId: 'insufficient', accepted: false, bet: 5 });
    session.handleRaw('{"type":"snapshot"}');
    expect(messages.filter(message => message.type === 'snapshot').at(-1)).toMatchObject({ snapshot: { balances: { player: 3 }, bets: { player: 5 }, scores: { player: 3 } } });
    await session.shutdown('test');
  });

  it('settles an overdue manual match before answering a last-second click, without a player draw or reopening the result', async () => {
    const { session, messages } = setup('test-match', 'manual');
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    // Leave interval callbacks delayed: the arriving command must enforce the deadline.
    vi.setSystemTime(Date.now() + 60_000);
    session.handleRaw('{"type":"spin","commandId":"at-deadline","matchId":"test-match"}');
    expect(messages.filter(message => message.type === 'side_spin' && message.spin.side === 'player')).toHaveLength(0);
    expect(messages.find(message => message.type === 'match_ended')).toMatchObject({ snapshot: { status: 'result', rounds: { player: 0, rival: 26 }, remaining: 0, winner: 'player' } });
    expect(messages.at(-1)).toMatchObject({ type: 'spin_status', commandId: 'at-deadline', accepted: false, retryAfterMs: 0 });
    session.handleRaw('{"type":"spin","commandId":"after-result","matchId":"test-match"}');
    session.handleRaw('{"type":"spin","commandId":"at-deadline","matchId":"test-match"}');
    expect(messages.filter(message => message.type === 'match_ended')).toHaveLength(1);
    expect(messages.filter(message => message.type === 'spin_status')).toHaveLength(3);
    expect(messages.filter(message => message.type === 'side_spin' && message.spin.side === 'player')).toHaveLength(0);
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

  it.each(['audio', 'avatar'] as const)('keeps the full manual duel after the %s voice deadline', async voiceMode => {
    const { session, messages, release, close } = setup('late-match', 'manual', voiceMode);
    await session.initialize();
    await vi.advanceTimersByTimeAsync(80_000);
    session.handleRaw('{"type":"start"}');
    session.handleRaw('{"type":"spin","matchId":"late-match","commandId":"before-limit"}');
    await vi.advanceTimersByTimeAsync(40_000);
    expect(provider.gptClose).toHaveBeenCalledOnce();
    expect(provider.stop).toHaveBeenCalledTimes(voiceMode === 'avatar' ? 1 : 0);
    expect(close).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(messages.filter(m => m.type === 'voice_status' && m.status === 'closed')).toHaveLength(1);
    session.handleRaw('{"type":"mic","audio":"AAAA"}');
    session.handleRaw('{"type":"spin","matchId":"late-match","commandId":"after-limit"}');
    await vi.advanceTimersByTimeAsync(20_001);
    expect(messages.filter(m => m.type === 'match_ended')).toMatchObject([{
      snapshot: { matchId: 'late-match', status: 'result', elapsed: 60, remaining: 0, rounds: { player: 2, rival: 26 } },
    }]);
    expect(provider.mic).not.toHaveBeenCalled();
    expect(provider.gptConnect).toHaveBeenCalledOnce();
    expect(provider.gptClose).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['timer', 'late-start'])('closes the idle lobby at 90 seconds via %s without starting a shortened game', async trigger => {
    const { session, messages, release, close } = setup();
    await session.initialize();
    if (trigger === 'timer') await vi.advanceTimersByTimeAsync(90_000);
    else {
      vi.setSystemTime(Date.now() + 90_000);
      session.handleRaw('{"type":"start"}');
    }
    await session.shutdown('test_finished');
    expect(messages.some(m => m.type === 'snapshot' && m.snapshot.status === 'playing')).toBe(false);
    expect(messages.filter(m => m.type === 'voice_status' && m.status === 'closed')).toMatchObject([{ message: 'lobby_timeout' }]);
    expect(provider.stop).toHaveBeenCalledOnce();
    expect(provider.gptClose).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
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
    expect(provider.context).toHaveBeenLastCalledWith(expect.stringContaining('首位=同点'));
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
    expect(provider.context).toHaveBeenLastCalledWith(expect.stringContaining('時間延長: 現在は確定不可。委任しない。'));
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
    expect(latestSpin).toMatchObject({ player: { round: 7, symbols: ['bell', 'bell', 'bell'], bet: 1, payout: 6, total: 65 }, rival: { round: 7, bet: 1, payout: 0, total: 23 } });
    if (latestSpin?.type !== 'spin') throw new Error('missing ordinary win');
    // The boundary tick must include the just-confirmed spin, not wait for the next tick.
    expect(provider.context).toHaveBeenCalledTimes(16);
    expect(provider.context).toHaveBeenLastCalledWith(expect.stringContaining('プレイヤー7回目、BET $1、配当$6'));
    expect(provider.context).toHaveBeenLastCalledWith(expect.stringContaining('あなた7回目、BET $1、配当$0'));
    session.handleRaw('{"type":"mic","audio":"AAAA"}');
    expect(provider.context.mock.invocationCallOrder.at(-1)).toBeLessThan(provider.mic.mock.invocationCallOrder[0]);
    expect(provider.context).toHaveBeenCalledTimes(16);
    await vi.advanceTimersByTimeAsync(1000);
    expect(provider.context).toHaveBeenLastCalledWith(expect.stringContaining('残り45秒、プレイヤー$65(BET $1)、あなた$23(BET $1)'));
    expect(provider.context).toHaveBeenLastCalledWith(expect.stringContaining('首位=プレイヤー'));
    expect(provider.reaction).toHaveBeenCalledTimes(reactionsBefore);
    // Ready + start + one changed context per elapsed second, not every 100ms tick.
    expect(provider.context).toHaveBeenCalledTimes(17);
    await session.shutdown('test_finished');
  });

  it('catches up a stalled tick and sends current bankroll context before microphone audio', async () => {
    const { session, messages } = setup();
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    await vi.advanceTimersByTimeAsync(20000);
    session.handleRaw(JSON.stringify({ type: 'set_bet', matchId: 'test-match', commandId: 'context-bet', bet: 5 }));
    expect(messages.filter(message => message.type === 'bet_status').at(-1)).toMatchObject({ commandId: 'context-bet', accepted: true, bet: 5 });
    const previousContextCount = provider.context.mock.calls.length;
    vi.setSystemTime(Date.now() + 4100);
    session.handleRaw('{"type":"mic","audio":"AAAA"}');
    const latest = messages.filter(m => m.type === 'snapshot').at(-1);
    expect(latest).toMatchObject({ snapshot: { elapsed: 24.1, round: 12, bets: { player: 5 }, upgrades: { player: [], rival: [] } } });
    if (latest?.type !== 'snapshot') throw new Error('missing caught-up snapshot');
    expect(provider.context).toHaveBeenCalledTimes(previousContextCount + 1);
    expect(provider.context).toHaveBeenLastCalledWith(expect.stringContaining(`残り36秒、プレイヤー$${latest.snapshot.balances.player}(BET $5)、あなた$${latest.snapshot.balances.rival}(BET $1)`));
    if (!latest.lastSpin) throw new Error('missing caught-up spin');
    for (const [side, label] of [['player', 'プレイヤー'], ['rival', 'あなた']] as const) {
      expect(latest.lastSpin[side].round).toBe(12);
      expect(provider.context).toHaveBeenLastCalledWith(expect.stringContaining(`${label}12回目、BET $${latest.lastSpin[side].bet}、配当$${latest.lastSpin[side].payout}`));
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
    expect(provider.context).toHaveBeenLastCalledWith(expect.stringContaining(`残り0秒、プレイヤー$${final.snapshot.balances.player}(BET $1)、あなた$${final.snapshot.balances.rival}(BET $1)`));
    expect(provider.context).toHaveBeenLastCalledWith(expect.stringContaining(`状態=result,勝者=${final.snapshot.winner}`));
    const finalSpin = messages.filter(m => m.type === 'spin').at(-1);
    if (finalSpin?.type !== 'spin') throw new Error('missing final spin');
    for (const [side, label, round] of [['player', 'プレイヤー', 30], ['rival', 'あなた', 30]] as const) {
      expect(provider.context).toHaveBeenLastCalledWith(expect.stringContaining(`${label}${round}回目、BET $${finalSpin[side].bet}、配当$${finalSpin[side].payout}`));
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

  it('uses one Live delegation to suppress the ordinary reply and apply a confirmed +10 second decision', async () => {
    vi.mocked(chooseTimeExtension).mockResolvedValueOnce('accept_extension_10s');
    const { session, messages } = setup('extension-match', 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    await vi.advanceTimersByTimeAsync(52_000);
    expect(provider.context).toHaveBeenLastCalledWith(expect.stringContaining('時間延長: 今この試合で未使用。サーバーは+10秒を一度だけ確定できる。'));
    provider.events?.onUserSpeech();
    provider.events?.onTranscript('user', '延長', { startMs: 0, endMs: 400 });
    expect(chooseTimeExtension).not.toHaveBeenCalled();
    provider.events?.onUserSpeechEnd();
    provider.events?.onTranscript('user', 'して', { startMs: 401, endMs: 900 });
    provider.events?.onTranscript('assistant', '先に受け入れると言ってしまう返答');
    provider.events?.onDelegation({ id: 'item-extension', offsetMs: 1000 });
    await vi.advanceTimersByTimeAsync(150);
    expect(chooseTimeExtension).toHaveBeenCalledWith(expect.objectContaining({ remaining: expect.any(Number), scores: { player: expect.any(Number), rival: expect.any(Number) } }), '延長して', expect.stringContaining('P:延長'), expect.any(AbortSignal), false);
    expect(provider.suppress).toHaveBeenCalledOnce();
    expect(messages.some(message => message.type === 'transcript' && message.role === 'assistant' && message.delta.includes('先に受け入れる'))).toBe(true);
    expect(messages.some(message => message.type === 'time_extension')).toBe(false);
    expect(provider.delegationResult).toHaveBeenCalledWith('item-extension', expect.stringContaining('しょうがないな、10秒伸ばしてあげる。まだ諦めないでよ？'), expect.any(String));
    await vi.advanceTimersByTimeAsync(7_300);
    session.handleRaw(JSON.stringify({ type: 'spin', matchId: 'extension-match', commandId: 'pre-deadline-spin' }));
    expect(messages.some(message => message.type === 'match_ended')).toBe(false);
    await vi.advanceTimersByTimeAsync(600);
    session.handleRaw('{"type":"snapshot"}');
    expect(messages.filter((message): message is Extract<ServerMessage, { type: 'snapshot' }> => message.type === 'snapshot').at(-1)).toMatchObject({ snapshot: { status: 'playing', remaining: 0, elapsed: 60 } });
    expect(messages.some(message => message.type === 'match_ended')).toBe(false);
    const speechId = provider.delegationResult.mock.calls.at(-1)?.[2] as string;
    provider.events?.onSpeechAudioEnded(speechId);
    expect(messages.some(message => message.type === 'time_extension')).toBe(false);
    session.handleRaw(JSON.stringify({ type: 'voice_speech_done', speechId }));
    const extension = messages.find((message): message is Extract<ServerMessage, { type: 'time_extension' }> => message.type === 'time_extension');
    expect(extension).toMatchObject({ decision: 'accepted', before: { duration: 60 }, after: { duration: 70 }, line: 'しょうがないな、10秒伸ばしてあげる。まだ諦めないでよ？' });
    session.handleRaw(JSON.stringify({ type: 'voice_speech_done', speechId }));
    expect(messages.filter(message => message.type === 'time_extension')).toHaveLength(1);
    session.handleRaw('{"type":"snapshot"}');
    expect(messages.filter(message => message.type === 'time_extension')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(18_000);
    expect(messages.find(message => message.type === 'match_ended')).toMatchObject({ snapshot: { elapsed: 70, duration: 70, remaining: 0 } });
    await session.shutdown('test_finished');
  });

  it('interrupts an unacknowledged acceptance line before the 15-second fallback extends a held match', async () => {
    vi.mocked(chooseTimeExtension).mockResolvedValueOnce('accept_extension_10s');
    const { session, messages } = setup('extension-fallback', 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    await vi.advanceTimersByTimeAsync(52_000);
    provider.events?.onTranscript('user', '延長して', { startMs: 0, endMs: 300 });
    provider.events?.onDelegation({ id: 'item-fallback', offsetMs: 400 });
    await vi.advanceTimersByTimeAsync(150);
    expect(messages.some(message => message.type === 'time_extension')).toBe(false);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(messages.find(message => message.type === 'time_extension')).toMatchObject({ decision: 'accepted', after: { duration: 70 } });
    expect(messages.filter(message => message.type === 'voice_interrupt')).not.toHaveLength(0);
    await session.shutdown('test_finished');
  });

  it.each(['あと10秒で終わるね', '時間延長はいらない'])('does not reserve a negotiation for a completed non-request: %s', async (transcript) => {
    const { session } = setup('not-an-extension', 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    await vi.advanceTimersByTimeAsync(52_000);
    provider.events?.onUserSpeech();
    provider.events?.onTranscript('user', transcript);
    provider.events?.onUserSpeechEnd();
    await vi.advanceTimersByTimeAsync(300);
    expect(chooseTimeExtension).not.toHaveBeenCalled();
    expect(provider.suppress).not.toHaveBeenCalled();
    await session.shutdown('test_finished');
  });

  it('does not reserve or suppress an extension request spoken before the final 15 seconds', async () => {
    const { session, messages } = setup('early-extension', 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    await vi.advanceTimersByTimeAsync(40_000);
    provider.events?.onUserSpeech();
    provider.events?.onTranscript('user', '延長して');
    provider.events?.onUserSpeechEnd();
    await vi.advanceTimersByTimeAsync(500);
    expect(chooseTimeExtension).not.toHaveBeenCalled();
    expect(provider.suppress).not.toHaveBeenCalled();
    provider.events?.onAudio('AAAA');
    expect(messages.some(message => message.type === 'voice_audio' && message.audio === 'AAAA')).toBe(true);
    await session.shutdown('test_finished');
  });

  it('offers once in the final 15 seconds and delegates an explicit reply for the server decision', async () => {
    vi.mocked(chooseTimeExtension).mockResolvedValueOnce('accept_extension_10s');
    const { session, messages } = setup('rival-offer', 'manual', 'audio', () => 0);
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    await vi.advanceTimersByTimeAsync(45_000);
    expect(provider.confirmedLine).toHaveBeenCalledWith('もう少し時間が欲しい？ 伸ばしてあげようか？');
    expect(messages.some(message => message.type === 'time_extension')).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(provider.context).toHaveBeenLastCalledWith(expect.stringContaining('ライバルは時間延長を提案済み。プレイヤーの短い同意は delegation して受諾候補にし、拒否は延長しない。'));
    provider.events?.onUserSpeech();
    provider.events?.onTranscript('user', 'うん', { startMs: 0, endMs: 200 });
    provider.events?.onUserSpeechEnd();
    provider.events?.onDelegation({ id: 'item-offer', offsetMs: 300 });
    await vi.advanceTimersByTimeAsync(150);
    expect(chooseTimeExtension).toHaveBeenCalledWith(expect.anything(), 'うん', expect.any(String), expect.any(AbortSignal), true);
    finishAudioExtension(session);
    expect(messages.find(message => message.type === 'time_extension')).toMatchObject({
      decision: 'accepted', before: { duration: 60 }, after: { duration: 70 }, line: 'しょうがないな、10秒伸ばしてあげる。まだ諦めないでよ？',
    });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(provider.confirmedLine.mock.calls.filter(([line]) => line === 'もう少し時間が欲しい？ 伸ばしてあげようか？')).toHaveLength(1);
    await session.shutdown('test_finished');
  });

  it('does not consume the extension after no_request and ignores a duplicate delegation ID', async () => {
    vi.mocked(chooseTimeExtension).mockResolvedValueOnce('no_request').mockResolvedValueOnce('accept_extension_10s');
    const { session, messages } = setup('delegation-no-request', 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    await vi.advanceTimersByTimeAsync(52_000);
    provider.events?.onTranscript('user', 'まだ負けたくない', { startMs: 0, endMs: 300 });
    provider.events?.onDelegation({ id: 'item-no-request', offsetMs: 400 });
    await vi.advanceTimersByTimeAsync(150);
    expect(chooseTimeExtension).toHaveBeenCalledOnce();
    expect(messages.some(message => message.type === 'time_extension')).toBe(false);
    expect(provider.delegationThinking).toHaveBeenCalledWith('item-no-request', expect.stringContaining('No extension request'));
    provider.events?.onDelegation({ id: 'item-no-request', offsetMs: 400 });
    await vi.advanceTimersByTimeAsync(150);
    expect(chooseTimeExtension).toHaveBeenCalledOnce();
    provider.events?.onDelegation({ id: 'item-accepted', offsetMs: 400 });
    await vi.advanceTimersByTimeAsync(150);
    finishAudioExtension(session);
    expect(messages.find(message => message.type === 'time_extension')).toMatchObject({ decision: 'accepted', after: { duration: 70 } });
    await session.shutdown('test_finished');
  });

  it('orders reverse-arriving transcript deltas by their Live timestamps before asking Responses', async () => {
    const { session } = setup('ordered-delegation', 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    await vi.advanceTimersByTimeAsync(52_000);
    provider.events?.onTranscript('user', 'して', { startMs: 401, endMs: 900 });
    provider.events?.onTranscript('user', '延長', { startMs: 0, endMs: 400 });
    provider.events?.onDelegation({ id: 'item-ordered', offsetMs: 1000 });
    await vi.advanceTimersByTimeAsync(150);
    expect(chooseTimeExtension).toHaveBeenCalledWith(expect.anything(), '延長して', expect.stringContaining('P:延長P:して'), expect.any(AbortSignal), false);
    await session.shutdown('test_finished');
  });

  it('sends only the delegated user turn while retaining earlier speech as conversation context', async () => {
    const { session } = setup('delegated-turn', 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    await vi.advanceTimersByTimeAsync(52_000);
    provider.events?.onUserSpeech();
    provider.events?.onTranscript('user', 'さっきの話', { startMs: 0, endMs: 300 });
    provider.events?.onUserSpeechEnd();
    provider.events?.onUserSpeech();
    provider.events?.onTranscript('user', 'うん', { startMs: 500, endMs: 700 });
    provider.events?.onDelegation({ id: 'item-turn', offsetMs: 800 });
    await vi.advanceTimersByTimeAsync(150);
    expect(chooseTimeExtension).toHaveBeenCalledWith(expect.anything(), 'うん', expect.stringContaining('P:さっきの話P:うん'), expect.any(AbortSignal), false);
    await session.shutdown('test_finished');
  });

  it('does not call Responses for a delegation before the final 15 seconds', async () => {
    const { session } = setup('early-delegation', 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    await vi.advanceTimersByTimeAsync(40_000);
    provider.events?.onTranscript('user', 'まだ負けたくない', { startMs: 0, endMs: 300 });
    provider.events?.onDelegation({ id: 'item-early', offsetMs: 400 });
    await vi.advanceTimersByTimeAsync(150);
    expect(chooseTimeExtension).not.toHaveBeenCalled();
    expect(provider.delegationThinking).toHaveBeenCalledWith('item-early', expect.stringContaining('No time-extension action'));
    await session.shutdown('test_finished');
  });

  it.each(['いや', 'no'])('does not extend after an explicit declined offer: %s', async transcript => {
    const { session, messages } = setup('declined-rival-offer', 'manual', 'audio', () => 0);
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    await vi.advanceTimersByTimeAsync(46_000);
    provider.events?.onUserSpeech();
    provider.events?.onTranscript('user', transcript);
    provider.events?.onUserSpeechEnd();
    await vi.advanceTimersByTimeAsync(300);
    expect(messages.some(message => message.type === 'time_extension')).toBe(false);
    provider.events?.onUserSpeech();
    provider.events?.onTranscript('user', '延長して');
    provider.events?.onUserSpeechEnd();
    await vi.advanceTimersByTimeAsync(300);
    expect(chooseTimeExtension).not.toHaveBeenCalled();
    await session.shutdown('test_finished');
  });

  it('does not extend or repeat its offer after no reply', async () => {
    const { session, messages } = setup('ignored-rival-offer', 'manual', 'audio', () => 0);
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    await vi.advanceTimersByTimeAsync(52_000);
    expect(messages.some(message => message.type === 'time_extension')).toBe(false);
    expect(provider.confirmedLine.mock.calls.filter(([line]) => line === 'もう少し時間が欲しい？ 伸ばしてあげようか？')).toHaveLength(1);
    await session.shutdown('test_finished');
  });

  it('keeps the clock moving and rejects a delayed decision after the match ends', async () => {
    const late = deferred<'accept_extension_10s'>();
    vi.mocked(chooseTimeExtension).mockReturnValueOnce(late.promise);
    const { session, messages } = setup('late-extension', 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    await vi.advanceTimersByTimeAsync(52_000);
    provider.events?.onTranscript('user', 'more time', { startMs: 0, endMs: 300 });
    provider.events?.onDelegation({ id: 'item-late', offsetMs: 400 });
    await vi.advanceTimersByTimeAsync(150);
    expect(chooseTimeExtension).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(8_100);
    late.resolve('accept_extension_10s');
    await late.promise;
    await vi.advanceTimersByTimeAsync(1);
    expect(messages.find(message => message.type === 'match_ended')).toMatchObject({ snapshot: { elapsed: 60, duration: 60 } });
    expect(messages.some(message => message.type === 'time_extension')).toBe(false);
    await session.shutdown('test_finished');
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
    const command = { type: 'set_bet' as const, commandId: 'same-id', bet: 5 as const, matchId: 'match-b' };
    a.session.handleRaw(JSON.stringify(command));
    a.session.handleRaw(JSON.stringify({ ...command, matchId: 'match-a' }));
    a.session.handleRaw(JSON.stringify({ ...command, matchId: 'match-a', bet: 1 }));
    b.session.handleRaw(JSON.stringify(command));
    await vi.advanceTimersByTimeAsync(40_000);
    expect(a.messages.find(m => m.type === 'match_ended')).toMatchObject({ snapshot: { matchId: 'match-a', round: 30, bets: { player: 5 }, upgrades: { player: [] } } });
    expect(b.messages.find(m => m.type === 'match_ended')).toMatchObject({ snapshot: { matchId: 'match-b', round: 30, bets: { player: 5 }, upgrades: { player: [] } } });
    expect(a.messages.some(m => m.type === 'error' && m.code === 'wrong_match')).toBe(true);
    expect(a.messages.filter(m => m.type === 'transcript')).toMatchObject([{ delta: 'reaction-a' }]);
    expect(b.messages.filter(m => m.type === 'transcript')).toMatchObject([{ delta: 'reaction-b' }]);
    for (const [session, matchId] of [[a, 'match-a'], [b, 'match-b']] as const) {
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
    expect(messages.find(m => m.type === 'snapshot')).toMatchObject({ snapshot: { status: 'ready', round: 0, balances: { player: 30, rival: 30 }, scores: { player: 30, rival: 30 }, bets: { player: 1, rival: 1 } } });
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
  it('rejects a disabled upgrade command without mutating a stalled match', async () => {
    const { session, messages } = setup();
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    await vi.advanceTimersByTimeAsync(20_000);
    vi.setSystemTime(Date.now() + 4_100);
    session.handleRaw('{"type":"upgrade","matchId":"test-match","commandId":"legacy-after-stall","offerIndex":0,"upgradeId":"jackpot"}');
    expect(messages.filter(m => m.type === 'error' && m.code === 'upgrade_rejected')).toHaveLength(1);
    session.handleRaw('{"type":"snapshot"}');
    expect(messages.filter(m => m.type === 'snapshot').at(-1)).toMatchObject({ snapshot: { elapsed: 24.1, upgrades: { player: [], rival: [] } } });
    await session.shutdown('test_finished');
  });
  it('keeps an ended match settled when a disabled upgrade command arrives after the deadline', async () => {
    const { session, messages } = setup();
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    vi.setSystemTime(Date.now() + 60_000);
    session.handleRaw(JSON.stringify({ type: 'upgrade', matchId: 'test-match', commandId: crypto.randomUUID(), offerIndex: 0, upgradeId: 'jackpot' }));
    expect(messages.some(m => m.type === 'error' && m.code === 'upgrade_rejected')).toBe(true);
    session.handleRaw('{"type":"snapshot"}');
    expect(messages.find(m => m.type === 'match_ended')).toMatchObject({ snapshot: { status: 'result', elapsed: 60, remaining: 0, upgrades: { player: [], rival: [] } } });
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
    session.handleRaw(JSON.stringify({ type: 'set_bet', matchId: 'test-match', commandId: 'after-voice-failure', bet: 5 }));
    await vi.advanceTimersByTimeAsync(20_000);
    const final = messages.find(m => m.type === 'match_ended');
    expect(final).toMatchObject({ snapshot: { matchId: 'test-match', status: 'result', elapsed: 60, round: 30, bets: { player: 5 }, upgrades: { player: [] } } });
    expect(messages.filter(m => m.type === 'spin')).toHaveLength(30);
    if (before?.type === 'snapshot' && final?.type === 'match_ended') {
      expect(final.snapshot.scores).toEqual(final.snapshot.balances);
      expect(final.snapshot.rounds.player).toBeGreaterThan(before.snapshot.rounds.player);
    }
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
it('runs a complete voice-only duel and its final reply without creating any avatar session', async () => {
  const { session, messages, release } = setup('audio-game', 'manual', 'audio');
  await session.initialize();
  expect(provider.start).not.toHaveBeenCalled();
  expect(provider.mediaStart).not.toHaveBeenCalled();
  expect(messages.some(m => m.type === 'avatar')).toBe(false);
  const playBridge = provider.events!;
  playBridge.onAudio('AAAA');
  expect(messages.at(-1)).toMatchObject({ type: 'voice_audio', audio: 'AAAA' });
  playBridge.onUserSpeech();
  expect(messages.at(-1)).toMatchObject({ type: 'voice_interrupt' });
  session.handleRaw('{"type":"start"}');
  session.handleRaw('{"type":"spin","matchId":"audio-game","commandId":"press"}');
  await vi.advanceTimersByTimeAsync(60_000);
  expect(messages.find(m => m.type === 'match_ended')).toMatchObject({
    snapshot: { status: 'result', rounds: { player: 1, rival: 26 } },
  });
  const count = messages.filter(m => m.type === 'voice_audio').length;
  playBridge.onAudio('AAAA');
  expect(messages.filter(m => m.type === 'voice_audio')).toHaveLength(count);
  provider.events!.onAudio('AAAA');
  expect(messages.filter(m => m.type === 'voice_audio')).toHaveLength(count + 1);
  await vi.advanceTimersByTimeAsync(8000);
  expect(provider.gptClose).toHaveBeenCalledTimes(2);
  expect(provider.stop).not.toHaveBeenCalled();
  expect(provider.mediaClose).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalledOnce();
});
