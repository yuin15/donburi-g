import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';
import type { LiveEvents } from './gptLive';
import type { ServerMessage, SpinView } from '../shared/protocol';
import type { MatchState } from '../src/domain/game';
import { parseServerEnvelope } from '../shared/wire';

const provider = vi.hoisted(() => ({
  start: vi.fn(), stop: vi.fn(), mediaStart: vi.fn(), mediaClose: vi.fn(),
  mediaFailures: [] as Array<() => void>,
  gptConnect: vi.fn(), gptClose: vi.fn(), events: null as LiveEvents | null, bridges: [] as LiveEvents[], bridgeLanguages: [] as Array<'ja' | 'en'>,
  context: vi.fn(), reaction: vi.fn(), confirmedLine: vi.fn(), cancelConfirmedSpeech: vi.fn(), delegationResult: vi.fn(), delegationThinking: vi.fn(), suppress: vi.fn(), mic: vi.fn(), language: vi.fn(), beginUserSpeech: vi.fn(),
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
  private language: 'ja' | 'en';
  constructor(events: LiveEvents, context = '', language: 'ja' | 'en' = 'ja') {
    provider.events = events;
    provider.bridges.push(events);
    provider.openingContexts.push(context);
    provider.bridgeLanguages.push(language);
    this.language = language;
  }
  connect = provider.gptConnect;
  close = provider.gptClose;
  updateGameContext = provider.context;
  requestReaction = provider.reaction;
  requestConfirmedLine = (line: string | { ja: string; en?: string }, speechId?: string) => {
    const value = typeof line === 'string' ? line : line[this.language] ?? line.ja;
    if (speechId) provider.confirmedLine(value, speechId);
    else provider.confirmedLine(value);
  };
  cancelConfirmedSpeech = provider.cancelConfirmedSpeech;
  requestDelegationResult = (id: string, line: string | { ja: string; en?: string }, speechId: string) => provider.delegationResult(
    id,
    typeof line === 'string' ? line : this.language === 'en'
      ? `Speak only this confirmed English line exactly: ${JSON.stringify(line.en ?? line.ja)}`
      : `Say only this Japanese line: ${JSON.stringify(line.ja)}`,
    speechId,
  );
  requestDelegationThinking = provider.delegationThinking;
  suppressOutput = provider.suppress;
  suppressOutputAfterTaggedSpeech = provider.suppress;
  setConversationLanguage = (language: 'ja' | 'en') => {
    this.language = language;
    provider.language(language);
  };
  beginUserSpeech = provider.beginUserSpeech;
  sendMic = provider.mic;
} }));
vi.mock('./rivalBrain', async importOriginal => ({
  ...(await importOriginal<typeof import('./rivalBrain')>()),
  chooseRivalUpgrade: vi.fn(async () => ({ upgradeId: 'steady', source: 'fallback' })),
  chooseTimeExtension: vi.fn(async () => 'reject_extension'),
  chooseLoanDecision: vi.fn(async () => 'no_request'),
}));
import { MatchSession } from './matchSession';
import { chooseLoanDecision, chooseTimeExtension } from './rivalBrain';

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
function startLoanOffer(): string {
  const [line, speechId] = provider.confirmedLine.mock.calls.at(-1) ?? [];
  expect(line).toBe('お金がなくなっちゃった。5ドル貸してくれない？');
  expect(speechId).toEqual(expect.any(String));
  provider.events?.onAudio(Buffer.alloc(4800, 4).toString('base64'), speechId as string);
  return speechId as string;
}
function finishLoanOffer(session: MatchSession, speechId: string): void {
  provider.events?.onSpeechAudioEnded(speechId);
  session.handleRaw(JSON.stringify({ type: 'voice_speech_done', speechId }));
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  provider.seed = [1, 0, 0, 0];
  provider.bridges.length = 0;
  provider.bridgeLanguages.length = 0;
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
  vi.mocked(chooseLoanDecision).mockResolvedValue('no_request');
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('provider status lifecycle', () => {
  it('settles a complete English turn before preserving English for the rest of the match', async () => {
    const { session } = setup('english-turn', 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    provider.events?.onUserSpeech();
    provider.events?.onTranscript('user', 'これは ABC の話', { startMs: 0, endMs: 100 });
    provider.events?.onUserSpeechEnd();
    await vi.advanceTimersByTimeAsync(250);
    expect(provider.language).toHaveBeenLastCalledWith('ja');
    provider.events?.onUserSpeech();
    provider.events?.onUserSpeechEnd();
    await vi.advanceTimersByTimeAsync(200);
    provider.events?.onTranscript('user', 'Absolutely!', { startMs: 0, endMs: 300 });
    await vi.advanceTimersByTimeAsync(249);
    expect(provider.language).not.toHaveBeenCalledWith('en');
    await vi.advanceTimersByTimeAsync(1);
    expect(provider.language).toHaveBeenLastCalledWith('en');
    provider.events?.onUserSpeech();
    provider.events?.onTranscript('user', '日本語に ABC が混ざる返答', { startMs: 400, endMs: 700 });
    provider.events?.onUserSpeechEnd();
    await vi.advanceTimersByTimeAsync(250);
    expect(provider.language).toHaveBeenLastCalledWith('en');
    await session.shutdown('test_finished');
  });

  it.each([
    ['Hello', 'en', '今すぐEnglishで'],
    ['これは ABC の話', 'ja', '今すぐJapaneseで'],
  ] as const)('settles a delayed completed %s turn before the result bridge starts', async (transcript, language, resultLanguage) => {
    const { session } = setup(`final-language-${language}`, 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    await vi.advanceTimersByTimeAsync(59_800);
    provider.events?.onUserSpeech();
    provider.events?.onUserSpeechEnd();
    await vi.advanceTimersByTimeAsync(100);
    provider.events?.onTranscript('user', transcript, { startMs: 0, endMs: 300 });
    await vi.advanceTimersByTimeAsync(250);
    expect(provider.bridgeLanguages.at(-1)).toBe(language);
    expect(provider.openingContexts.at(-1)).toContain(resultLanguage);
    await session.shutdown('test_finished');
  });

  it.each([
    ['Hello', 'en', 'English'],
    ['これは ABC の話', 'ja', 'Japanese'],
    ['Hello、これは日本語', 'ja', 'Japanese'],
  ] as const)('carries a final delayed %s delta through match end before creating the result bridge', async (transcript, language, resultLanguage) => {
    const { session } = setup(`post-end-language-${language}`, 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    await vi.advanceTimersByTimeAsync(59_900);
    const matchBridge = provider.bridges[0];
    matchBridge.onUserSpeech();
    matchBridge.onUserSpeechEnd();
    await vi.advanceTimersByTimeAsync(100);
    expect(provider.bridges).toHaveLength(1);
    matchBridge.onTranscript('user', transcript, { startMs: 0, endMs: 300 });
    await vi.advanceTimersByTimeAsync(149);
    expect(provider.bridges).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(provider.bridgeLanguages.at(-1)).toBe(language);
    expect(provider.openingContexts.at(-1)).toContain(resultLanguage);
    await session.shutdown('test_finished');
  });

  it('cancels a pending final-turn language handoff during shutdown', async () => {
    const { session } = setup('post-end-language-shutdown', 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    await vi.advanceTimersByTimeAsync(59_900);
    const matchBridge = provider.bridges[0];
    matchBridge.onUserSpeech();
    matchBridge.onUserSpeechEnd();
    await vi.advanceTimersByTimeAsync(100);
    await session.shutdown('test_finished');
    matchBridge.onTranscript('user', 'Hello', { startMs: 0, endMs: 300 });
    await vi.advanceTimersByTimeAsync(300);
    expect(provider.bridges).toHaveLength(1);
  });

  it('drops a post-result speech turn instead of treating it as the final transcript', async () => {
    const { session } = setup('post-end-new-turn', 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    await vi.advanceTimersByTimeAsync(59_900);
    const matchBridge = provider.bridges[0];
    matchBridge.onUserSpeech();
    matchBridge.onUserSpeechEnd();
    await vi.advanceTimersByTimeAsync(100);
    matchBridge.onUserSpeech();
    matchBridge.onTranscript('user', 'Hello', { startMs: 0, endMs: 300 });
    await vi.advanceTimersByTimeAsync(150);
    expect(provider.bridgeLanguages.at(-1)).toBe('ja');
    expect(provider.openingContexts.at(-1)).toContain('Japanese');
    await session.shutdown('test_finished');
  });

  it('clears a pending final-turn handoff when voice closes without closing the match session', async () => {
    const { session } = setup('post-end-language-voice-close', 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    await vi.advanceTimersByTimeAsync(59_900);
    const matchBridge = provider.bridges[0];
    matchBridge.onUserSpeech();
    matchBridge.onUserSpeechEnd();
    await vi.advanceTimersByTimeAsync(100);
    session.handleRaw('{"type":"voice_close"}');
    matchBridge.onTranscript('user', 'Hello', { startMs: 0, endMs: 300 });
    await vi.advanceTimersByTimeAsync(300);
    expect(provider.bridges).toHaveLength(1);
    await session.shutdown('test_finished');
  });

  it('starts the result bridge immediately when English was already settled', async () => {
    const { session } = setup('post-end-language-already-english', 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    provider.events?.onUserSpeech();
    provider.events?.onTranscript('user', 'Hello', { startMs: 0, endMs: 100 });
    provider.events?.onUserSpeechEnd();
    await vi.advanceTimersByTimeAsync(250);
    await vi.advanceTimersByTimeAsync(59_650);
    const matchBridge = provider.bridges[0];
    matchBridge.onUserSpeech();
    matchBridge.onUserSpeechEnd();
    await vi.advanceTimersByTimeAsync(100);
    expect(provider.bridgeLanguages.at(-1)).toBe('en');
    expect(provider.openingContexts.at(-1)).toContain('English');
    await session.shutdown('test_finished');
  });

  it('uses English fixed lines for loans, extensions, and the result bridge after an English turn', async () => {
    vi.mocked(chooseLoanDecision).mockResolvedValueOnce('accept_loan');
    vi.mocked(chooseTimeExtension).mockResolvedValueOnce('accept_extension_10s');
    const { session, messages } = setup('english-fixed-lines', 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    provider.events?.onUserSpeech();
    provider.events?.onTranscript('user', 'Hello!', { startMs: 0, endMs: 100 });
    provider.events?.onUserSpeechEnd();
    await vi.advanceTimersByTimeAsync(250);
    const state = (session as unknown as { state: MatchState }).state;
    state.scores.player = 0;
    state.scores.rival = 10;
    provider.events?.onUserSpeech();
    provider.events?.onTranscript('user', 'Can you lend me money?', { startMs: 200, endMs: 300 });
    provider.events?.onDelegation({ id: 'english-loan', offsetMs: 400 });
    await vi.advanceTimersByTimeAsync(150);
    expect(provider.delegationResult).toHaveBeenCalledWith('english-loan', expect.stringContaining('All right, I will lend you $5.'), expect.any(String));
    expect(messages.find(message => message.type === 'loan_transfer')).toMatchObject({ line: 'All right, I will lend you $5. Do not waste it.' });
    provider.events?.onUserSpeechEnd();
    state.scores.player = 5;
    state.scores.rival = 5;
    await vi.advanceTimersByTimeAsync(52_000);
    provider.events?.onUserSpeech();
    provider.events?.onTranscript('user', 'Please extend the time.', { startMs: 500, endMs: 700 });
    provider.events?.onUserSpeechEnd();
    await vi.advanceTimersByTimeAsync(150);
    const [line, speechId] = provider.confirmedLine.mock.calls.find(([line]) => line === 'All right, I will give you 10 more seconds. Do not give up yet.') ?? [];
    expect(line).toBe('All right, I will give you 10 more seconds. Do not give up yet.');
    provider.events?.onSpeechAudioEnded(speechId as string);
    session.handleRaw(JSON.stringify({ type: 'voice_speech_done', speechId }));
    expect(messages.find(message => message.type === 'time_extension')).toMatchObject({ line: 'All right, I will give you 10 more seconds. Do not give up yet.' });
    await vi.advanceTimersByTimeAsync(18_000);
    expect(provider.bridgeLanguages.at(-1)).toBe('en');
    expect(provider.openingContexts.at(-1)).toContain('今すぐEnglishで');
    expect(provider.reaction).toHaveBeenLastCalledWith(expect.stringContaining('You '));
    await session.shutdown('test_finished');
  });

  it.each([
    ['Can you lend me money?', 'en', 'All right, I will lend you $5. Do not waste it.', false],
    ['Can you lend me money? 日本語', 'ja', 'しょうがないな、$5だけ貸すよ。無駄にしないで。', false],
  ] as const)('keeps an initial %s loan decision UI aligned with its settled language', async (transcript, language, line, emittedBeforeSpeechEnd) => {
    vi.mocked(chooseLoanDecision).mockResolvedValueOnce('accept_loan');
    const { session, messages } = setup(`initial-language-loan-${language}`, 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    const state = (session as unknown as { state: MatchState }).state;
    state.scores.player = 0;
    state.scores.rival = 10;
    provider.events?.onUserSpeech();
    provider.events?.onTranscript('user', transcript, { startMs: 0, endMs: 300 });
    provider.events?.onDelegation({ id: `initial-language-loan-${language}`, offsetMs: 400 });
    await vi.advanceTimersByTimeAsync(150);
    expect(messages.some(message => message.type === 'loan_transfer')).toBe(emittedBeforeSpeechEnd);
    provider.events?.onUserSpeechEnd();
    await vi.advanceTimersByTimeAsync(250);
    expect(provider.language).toHaveBeenLastCalledWith(language);
    expect(messages.find(message => message.type === 'loan_transfer')).toMatchObject({ line });
    await session.shutdown('test_finished');
  });

  it('deduplicates purchases, preserves spin totals, and sends valid recovery snapshots', async () => {
    const { session, messages } = setup('shop', 'manual', 'audio');
    await session.initialize();
    session.handleRaw(JSON.stringify({ type: 'start' }));
    session.handleRaw(JSON.stringify({ type: 'spin', commandId: 'spin1', matchId: 'shop' }));
    const purchase = { type: 'purchase', matchId: 'shop', commandId: 'buy1', upgradeId: 'steady', expectedCount: 0 };
    session.handleRaw(JSON.stringify(purchase));
    session.handleRaw(JSON.stringify(purchase));
    session.handleRaw(JSON.stringify({ ...purchase, commandId: 'buy2' }));
    const snapshots = messages.filter(m => m.type === 'snapshot');
    const last = snapshots.at(-1)!;
    expect(last.snapshot.upgrades.player).toEqual(['steady']);
    expect(last.snapshot.upgrades.rival).toEqual([]);
    expect(last.snapshot.upgradeSpent).toBe(10);
    expect(last.lastSpins?.player?.upgradeSpent).toBe(0);
    for (const message of snapshots) expect(parseServerEnvelope(JSON.stringify(message))).not.toBeNull();
    await session.shutdown('normal_close');
  });
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

  it('reserves an audio play window after a late start through extension fallback and final reaction', async () => {
    vi.mocked(chooseTimeExtension).mockResolvedValueOnce('accept_extension_10s');
    const { session, messages, release } = setup('late-audio-extension', 'manual', 'audio');
    await session.initialize();
    await vi.advanceTimersByTimeAsync(74_000);
    session.handleRaw('{"type":"start"}');

    // This crosses the old initialization-based 120s deadline. The existing
    // bridge must observe the re-armed play deadline rather than a captured one.
    await vi.advanceTimersByTimeAsync(46_000);
    expect(provider.gptClose).not.toHaveBeenCalled();
    provider.events?.onAudio('after-old-deadline');
    expect(messages).toContainEqual(expect.objectContaining({ type: 'voice_audio', audio: 'after-old-deadline' }));

    await vi.advanceTimersByTimeAsync(6_000);
    provider.events?.onTranscript('user', '延長して', { startMs: 0, endMs: 300 });
    provider.events?.onDelegation({ id: 'late-audio-extension', offsetMs: 400 });
    await vi.advanceTimersByTimeAsync(150);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(messages.some(message => message.type === 'match_ended')).toBe(false);

    // The bounded 15s spoken-line fallback holds the clock, then all ten
    // granted seconds and the result reaction still fit before the 170s cap.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(messages.find(message => message.type === 'time_extension')).toMatchObject({ decision: 'accepted', after: { duration: 70 } });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(messages.find(message => message.type === 'match_ended')).toMatchObject({ snapshot: { elapsed: 70, duration: 70, remaining: 0 } });
    await vi.advanceTimersByTimeAsync(8_000);
    expect(release).toHaveBeenCalledOnce();
    expect(provider.gptClose).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ends an avatar-ready lobby before its provider-issued 120-second token could shorten a full extended duel', async () => {
    const { session, messages, release, close } = setup('avatar-lobby', 'manual', 'avatar');
    await session.initialize();
    await vi.advanceTimersByTimeAsync(25_000);
    expect(messages.some(message => message.type === 'snapshot' && message.snapshot.status === 'playing')).toBe(false);
    expect(messages).toContainEqual(expect.objectContaining({
      type: 'error', code: 'lobby_timeout', recoverable: false,
      message: 'Live video waited too long. Reconnect AI voice without live video to start a full duel.',
    }));
    expect(messages.filter(message => message.type === 'voice_status' && message.status === 'closed')).toMatchObject([{ message: 'lobby_timeout' }]);
    expect(provider.stop).toHaveBeenCalledOnce();
    expect(provider.gptClose).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ['audio', 75_000],
    ['avatar', 25_000],
  ] as const)('closes the unused %s lobby before a shortened game can start', async (voiceMode, lobbyMs) => {
    const { session, messages, release, close } = setup(`idle-${voiceMode}`, 'manual', voiceMode);
    await session.initialize();
    await vi.advanceTimersByTimeAsync(lobbyMs);
    expect(messages.some(message => message.type === 'snapshot' && message.snapshot.status === 'playing')).toBe(false);
    expect(messages.filter(m => m.type === 'error')).toContainEqual(expect.objectContaining({ type: 'error', code: 'lobby_timeout', recoverable: false }));
    expect(messages.filter(m => m.type === 'voice_status' && m.status === 'closed')).toMatchObject([{ message: 'lobby_timeout' }]);
    expect(provider.stop).toHaveBeenCalledTimes(voiceMode === 'avatar' ? 1 : 0);
    expect(provider.gptClose).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ['audio', 75_000],
    ['avatar', 25_000],
  ] as const)('rejects a late %s PLAY even when its lobby timer has not run yet', async (voiceMode, lobbyMs) => {
    const { session, messages, release, close } = setup(`late-${voiceMode}`, 'manual', voiceMode);
    await session.initialize();
    vi.setSystemTime(Date.now() + lobbyMs);
    session.handleRaw('{"type":"start"}');
    await vi.advanceTimersByTimeAsync(0);
    expect(messages.some(message => message.type === 'snapshot' && message.snapshot.status === 'playing')).toBe(false);
    expect(messages.filter(m => m.type === 'error')).toContainEqual(expect.objectContaining({ type: 'error', code: 'lobby_timeout', recoverable: false }));
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
    expect(provider.context).toHaveBeenLastCalledWith(expect.stringContaining('時間延長: 現在は確定不可。委任しない。通常の会話を続ける。'));
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
    expect(provider.context).toHaveBeenLastCalledWith(expect.stringContaining('時間延長: 今この試合で未使用。+10秒は一度だけ確定できる。'));
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
    await vi.advanceTimersByTimeAsync(250);
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

  it('routes a clear late-game extension transcript without a Live delegation and applies it after tagged playback', async () => {
    vi.mocked(chooseTimeExtension).mockResolvedValueOnce('accept_extension_10s');
    const { session, messages } = setup('direct-extension', 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    await vi.advanceTimersByTimeAsync(52_000);
    provider.events?.onUserSpeech();
    provider.events?.onUserSpeechEnd();
    provider.events?.onTranscript('user', '延長して', { startMs: 0, endMs: 300 });
    await vi.advanceTimersByTimeAsync(150);
    expect(chooseTimeExtension).toHaveBeenCalledWith(expect.objectContaining({ remaining: expect.any(Number) }), '延長して', expect.any(String), expect.any(AbortSignal), false);
    expect(provider.delegationResult).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    const [line, speechId] = provider.confirmedLine.mock.calls.at(-1) ?? [];
    expect(line).toBe('しょうがないな、10秒伸ばしてあげる。まだ諦めないでよ？');
    expect(speechId).toEqual(expect.any(String));
    expect(messages.some(message => message.type === 'time_extension')).toBe(false);
    provider.events?.onSpeechAudioEnded(speechId as string);
    session.handleRaw(JSON.stringify({ type: 'voice_speech_done', speechId }));
    expect(messages.find(message => message.type === 'time_extension')).toMatchObject({ decision: 'accepted', after: { duration: 70 } });
    await session.shutdown('test_finished');
  });

  it('speaks a clarification without consuming a direct extension request when the decision is no_request', async () => {
    vi.mocked(chooseTimeExtension).mockResolvedValueOnce('no_request');
    const { session, messages } = setup('direct-extension-clarification', 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    await vi.advanceTimersByTimeAsync(52_000);
    provider.events?.onUserSpeech();
    provider.events?.onUserSpeechEnd();
    provider.events?.onTranscript('user', '延長して', { startMs: 0, endMs: 300 });
    await vi.advanceTimersByTimeAsync(150);
    await vi.advanceTimersByTimeAsync(250);
    expect(provider.confirmedLine).toHaveBeenCalledWith('もう一度、延長してって言ってくれる？');
    expect(messages.some(message => message.type === 'time_extension')).toBe(false);
    provider.events?.onDelegation({ id: 'late-direct-extension', offsetMs: 400 });
    await vi.advanceTimersByTimeAsync(150);
    expect(chooseTimeExtension).toHaveBeenCalledOnce();
    expect(provider.delegationThinking).toHaveBeenCalledWith('late-direct-extension', expect.stringContaining('Continue the ordinary conversation'));
    await session.shutdown('test_finished');
  });

  it('waits after speech end for a later withdrawal of a direct extension request', async () => {
    const { session, messages } = setup('withdrawn-direct-extension', 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    await vi.advanceTimersByTimeAsync(52_000);
    provider.events?.onUserSpeech();
    provider.events?.onTranscript('user', '延長して', { startMs: 0, endMs: 100 });
    provider.events?.onUserSpeechEnd();
    await vi.advanceTimersByTimeAsync(100);
    provider.events?.onTranscript('user', '、やっぱりやめる', { startMs: 101, endMs: 300 });
    await vi.advanceTimersByTimeAsync(150);
    expect(chooseTimeExtension).not.toHaveBeenCalled();
    expect(messages.some(message => message.type === 'time_extension')).toBe(false);
    await session.shutdown('test_finished');
  });

  it('invalidates a pending direct extension acceptance after a same-turn withdrawal', async () => {
    const pending = deferred<'accept_extension_10s' | 'reject_extension' | 'no_request'>();
    vi.mocked(chooseTimeExtension).mockReturnValueOnce(pending.promise);
    const { session, messages } = setup('pending-withdrawn-direct-extension', 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    await vi.advanceTimersByTimeAsync(52_000);
    provider.events?.onUserSpeech();
    provider.events?.onTranscript('user', '延長して', { startMs: 0, endMs: 100 });
    provider.events?.onUserSpeechEnd();
    await vi.advanceTimersByTimeAsync(251);
    expect(chooseTimeExtension).toHaveBeenCalledOnce();
    const confirmedBefore = provider.confirmedLine.mock.calls.length;
    provider.events?.onTranscript('user', '、やっぱりやめる', { startMs: 101, endMs: 300 });
    pending.resolve('accept_extension_10s');
    await pending.promise;
    await vi.advanceTimersByTimeAsync(1);
    expect(provider.confirmedLine).toHaveBeenCalledTimes(confirmedBefore);
    expect(messages.some(message => message.type === 'time_extension')).toBe(false);
    await session.shutdown('test_finished');
  });

  it('cancels an accepted direct extension before its old speech ACK or fallback can apply it', async () => {
    vi.mocked(chooseTimeExtension).mockResolvedValueOnce('accept_extension_10s');
    const { session, messages } = setup('cancel-accepted-direct-extension', 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    await vi.advanceTimersByTimeAsync(52_000);
    provider.events?.onUserSpeech();
    provider.events?.onTranscript('user', '延長して', { startMs: 0, endMs: 100 });
    provider.events?.onUserSpeechEnd();
    await vi.advanceTimersByTimeAsync(251);
    const [, speechId] = provider.confirmedLine.mock.calls.at(-1) ?? [];
    expect(speechId).toEqual(expect.any(String));
    expect(messages.some(message => message.type === 'time_extension')).toBe(false);
    provider.events?.onTranscript('user', '、やっぱりやめる', { startMs: 101, endMs: 300 });
    expect(provider.cancelConfirmedSpeech).toHaveBeenCalledWith(speechId);
    provider.events?.onSpeechAudioEnded(speechId as string);
    session.handleRaw(JSON.stringify({ type: 'voice_speech_done', speechId }));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(messages.some(message => message.type === 'time_extension')).toBe(false);
    await session.shutdown('test_finished');
  });

  it('re-evaluates a pending direct extension with a same-turn positive supplement only once', async () => {
    const first = deferred<'accept_extension_10s' | 'reject_extension' | 'no_request'>();
    const second = deferred<'accept_extension_10s' | 'reject_extension' | 'no_request'>();
    vi.mocked(chooseTimeExtension).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { session } = setup('supplemented-direct-extension', 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    await vi.advanceTimersByTimeAsync(52_000);
    provider.events?.onUserSpeech();
    provider.events?.onTranscript('user', '延長して', { startMs: 0, endMs: 100 });
    provider.events?.onUserSpeechEnd();
    await vi.advanceTimersByTimeAsync(251);
    const confirmedBefore = provider.confirmedLine.mock.calls.length;
    provider.events?.onTranscript('user', '、お願い', { startMs: 101, endMs: 300 });
    await vi.advanceTimersByTimeAsync(150);
    expect(chooseTimeExtension).toHaveBeenCalledTimes(2);
    expect(chooseTimeExtension).toHaveBeenLastCalledWith(expect.anything(), '延長して、お願い', expect.any(String), expect.any(AbortSignal), false);
    first.resolve('accept_extension_10s');
    await first.promise;
    expect(provider.confirmedLine).toHaveBeenCalledTimes(confirmedBefore);
    second.resolve('accept_extension_10s');
    await second.promise;
    await vi.advanceTimersByTimeAsync(250);
    expect(provider.confirmedLine).toHaveBeenCalledTimes(confirmedBefore + 1);
    await session.shutdown('test_finished');
  });

  it('invalidates a pending direct extension for a new turn and accepts the new request', async () => {
    const first = deferred<'accept_extension_10s' | 'reject_extension' | 'no_request'>();
    const second = deferred<'accept_extension_10s' | 'reject_extension' | 'no_request'>();
    vi.mocked(chooseTimeExtension).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { session, messages } = setup('new-turn-direct-extension', 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    await vi.advanceTimersByTimeAsync(52_000);
    provider.events?.onUserSpeech();
    provider.events?.onTranscript('user', '延長して', { startMs: 0, endMs: 100 });
    provider.events?.onUserSpeechEnd();
    await vi.advanceTimersByTimeAsync(151);
    const confirmedBefore = provider.confirmedLine.mock.calls.length;
    provider.events?.onUserSpeech();
    first.resolve('accept_extension_10s');
    await first.promise;
    expect(provider.confirmedLine).toHaveBeenCalledTimes(confirmedBefore);
    expect(messages.some(message => message.type === 'time_extension')).toBe(false);
    provider.events?.onTranscript('user', '延長して', { startMs: 301, endMs: 500 });
    provider.events?.onUserSpeechEnd();
    await vi.advanceTimersByTimeAsync(251);
    expect(chooseTimeExtension).toHaveBeenCalledTimes(2);
    second.resolve('accept_extension_10s');
    await second.promise;
    const [line, speechId] = provider.confirmedLine.mock.calls.at(-1) ?? [];
    expect(line).toBe('しょうがないな、10秒伸ばしてあげる。まだ諦めないでよ？');
    provider.events?.onSpeechAudioEnded(speechId as string);
    session.handleRaw(JSON.stringify({ type: 'voice_speech_done', speechId }));
    expect(messages.filter(message => message.type === 'time_extension')).toHaveLength(1);
    await session.shutdown('test_finished');
  });

  it('does not direct-route an extension that began before the final fifteen seconds', async () => {
    const { session } = setup('early-direct-extension', 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    await vi.advanceTimersByTimeAsync(44_000);
    provider.events?.onUserSpeech();
    await vi.advanceTimersByTimeAsync(1_000);
    provider.events?.onUserSpeechEnd();
    provider.events?.onTranscript('user', '延長して', { startMs: 0, endMs: 300 });
    await vi.advanceTimersByTimeAsync(150);
    expect(chooseTimeExtension).not.toHaveBeenCalled();
    await session.shutdown('test_finished');
  });

  it('authoritatively transfers one fixed $5 loan to a bankrupt player only after the delegated decision', async () => {
    vi.mocked(chooseLoanDecision).mockResolvedValueOnce('accept_loan');
    const { session, messages } = setup('player-loan', 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    const state = (session as unknown as { state: MatchState }).state;
    state.scores.player = 0;
    state.scores.rival = 10;
    provider.events?.onUserSpeech();
    provider.events?.onTranscript('user', 'Can you lend me enough for one more spin?', { startMs: 0, endMs: 300 });
    provider.events?.onDelegation({ id: 'player-loan-delegation', offsetMs: 400 });
    await vi.advanceTimersByTimeAsync(150);
    expect(chooseLoanDecision).toHaveBeenCalledWith(expect.objectContaining({ scores: { player: 0, rival: 10 } }), 'rival_to_player', expect.stringContaining('lend me'), expect.any(String), expect.any(AbortSignal), false);
    provider.events?.onUserSpeechEnd();
    await vi.advanceTimersByTimeAsync(250);
    const transfer = messages.find((message): message is Extract<ServerMessage, { type: 'loan_transfer' }> => message.type === 'loan_transfer');
    expect(transfer).toMatchObject({ direction: 'rival_to_player', amount: 5, before: { scores: { player: 0, rival: 10 } }, after: { scores: { player: 5, rival: 5 }, balances: { player: 5, rival: 5 } } });
    expect(provider.delegationResult).toHaveBeenCalledWith('player-loan-delegation', expect.stringContaining('Speak only this confirmed English line exactly'), expect.any(String));
    provider.events?.onDelegation({ id: 'player-loan-again', offsetMs: 400 });
    await vi.advanceTimersByTimeAsync(150);
    expect(messages.filter(message => message.type === 'loan_transfer')).toHaveLength(1);
    await session.shutdown('test_finished');
  });

  it('routes a loan request whose transcript arrives after its delegation', async () => {
    vi.mocked(chooseLoanDecision).mockResolvedValueOnce('accept_loan');
    const { session, messages } = setup('late-loan-route', 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    const state = (session as unknown as { state: MatchState }).state;
    state.scores.player = 0;
    state.scores.rival = 30;
    provider.events?.onUserSpeech();
    provider.events?.onDelegation({ id: 'late-loan-route-delegation', offsetMs: 400 });
    provider.events?.onTranscript('user', 'お金を貸して', { startMs: 0, endMs: 300 });
    await vi.advanceTimersByTimeAsync(150);
    expect(chooseLoanDecision).toHaveBeenCalledWith(expect.objectContaining({ scores: { player: 0, rival: 30 } }), 'rival_to_player', 'お金を貸して', expect.any(String), expect.any(AbortSignal), false);
    expect(chooseTimeExtension).not.toHaveBeenCalled();
    provider.events?.onUserSpeechEnd();
    await vi.advanceTimersByTimeAsync(250);
    expect(messages.find(message => message.type === 'loan_transfer')).toMatchObject({ direction: 'rival_to_player', amount: 5 });
    await session.shutdown('test_finished');
  });

  it('routes a clear borrower transcript without a Live delegation through the existing loan decision', async () => {
    vi.mocked(chooseLoanDecision).mockResolvedValueOnce('accept_loan');
    const { session, messages } = setup('direct-player-loan', 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    const state = (session as unknown as { state: MatchState }).state;
    state.scores.player = 0;
    state.scores.rival = 10;
    provider.events?.onUserSpeech();
    provider.events?.onUserSpeechEnd();
    await vi.advanceTimersByTimeAsync(100);
    provider.events?.onTranscript('user', 'お金を貸してほしい', { startMs: 0, endMs: 300 });
    await vi.advanceTimersByTimeAsync(250);
    expect(chooseLoanDecision).toHaveBeenCalledWith(expect.objectContaining({ scores: { player: 0, rival: 10 } }), 'rival_to_player', 'お金を貸してほしい', expect.any(String), expect.any(AbortSignal), false);
    expect(messages.some(message => message.type === 'loan_transfer')).toBe(false);
    await vi.advanceTimersByTimeAsync(250);
    expect(messages.find(message => message.type === 'loan_transfer')).toMatchObject({ direction: 'rival_to_player', amount: 5 });
    expect(provider.delegationResult).not.toHaveBeenCalled();
    expect(provider.confirmedLine).toHaveBeenCalledWith('しょうがないな、$5だけ貸すよ。無駄にしないで。');
    await session.shutdown('test_finished');
  });

  it('accepts a direct player loan without a rival request or AI decision, even when the rival has money', async () => {
    const { session, messages } = setup('direct-rival-loan', 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    const state = (session as unknown as { state: MatchState }).state;
    state.scores.player = 10;
    state.scores.rival = 20;
    provider.events?.onUserSpeech();
    provider.events?.onUserSpeechEnd();
    provider.events?.onTranscript('user', 'お金を貸すよ', { startMs: 0, endMs: 300 });
    await vi.advanceTimersByTimeAsync(250);
    expect(chooseLoanDecision).not.toHaveBeenCalled();
    expect(messages.filter((message): message is Extract<ServerMessage, { type: 'loan_transfer' }> => message.type === 'loan_transfer')).toMatchObject([
      { direction: 'player_to_rival', amount: 5, before: { scores: { player: 10, rival: 20 } }, after: { scores: { player: 5, rival: 25 }, balances: { player: 5, rival: 25 } } },
    ]);
    expect(provider.confirmedLine).toHaveBeenCalledWith('助かった、$5借りるよ。ここから巻き返す。');
    await session.shutdown('test_finished');
  });

  it('settles a direct player loan once when it overlaps the rival offer, a delegation, and an assistant subtitle', async () => {
    const { session, messages } = setup('overlapping-direct-rival-loan', 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    const state = (session as unknown as { state: MatchState }).state;
    state.scores.player = 10;
    state.scores.rival = 0;
    state.elapsed = state.processedSecond = 50;
    state.remaining = 10;
    session.handleRaw('{"type":"snapshot"}');
    startLoanOffer();
    provider.events?.onUserSpeech();
    provider.events?.onUserSpeechEnd();
    provider.events?.onTranscript('user', '貸すよ', { startMs: 0, endMs: 100 });
    provider.events?.onDelegation({ id: 'overlapping-direct-player-loan', offsetMs: 200 });
    provider.events?.onTranscript('assistant', '了解。');
    await vi.advanceTimersByTimeAsync(250);
    expect(messages.filter(message => message.type === 'loan_transfer')).toHaveLength(1);
    expect(messages.find(message => message.type === 'loan_transfer')).toMatchObject({ direction: 'player_to_rival', amount: 5, after: { scores: { player: 5, rival: 5 } } });
    expect(chooseLoanDecision).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(messages.filter(message => message.type === 'loan_transfer')).toHaveLength(1);
    await session.shutdown('test_finished');
  });

  it('accepts each new player loan offer once and keeps duplicate delegation from moving money twice', async () => {
    const { session, messages } = setup('repeated-direct-rival-loan', 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    const state = (session as unknown as { state: MatchState }).state;
    state.scores.player = 15;
    state.scores.rival = 20;
    provider.events?.onUserSpeech();
    provider.events?.onUserSpeechEnd();
    provider.events?.onTranscript('user', '貸してあげる', { startMs: 0, endMs: 300 });
    provider.events?.onDelegation({ id: 'direct-player-loan', offsetMs: 400 });
    provider.events?.onDelegation({ id: 'direct-player-loan', offsetMs: 400 });
    await vi.advanceTimersByTimeAsync(250);
    provider.events?.onUserSpeech();
    provider.events?.onUserSpeechEnd();
    provider.events?.onTranscript('user', '貸すよ', { startMs: 500, endMs: 800 });
    await vi.advanceTimersByTimeAsync(250);
    const transfers = messages.filter((message): message is Extract<ServerMessage, { type: 'loan_transfer' }> => message.type === 'loan_transfer');
    expect(transfers).toHaveLength(2);
    expect(transfers.map(transfer => transfer.after.scores)).toEqual([{ player: 10, rival: 25 }, { player: 5, rival: 30 }]);
    expect(chooseLoanDecision).not.toHaveBeenCalled();
    await session.shutdown('test_finished');
  });

  it('does not move money for a withdrawn, negative, reverse, or underfunded player loan offer', async () => {
    const { session, messages } = setup('guarded-direct-rival-loan', 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    const state = (session as unknown as { state: MatchState }).state;
    state.scores.player = 10;
    state.scores.rival = 20;
    provider.events?.onUserSpeech();
    provider.events?.onTranscript('user', 'お金を貸す', { startMs: 0, endMs: 100 });
    provider.events?.onUserSpeechEnd();
    await vi.advanceTimersByTimeAsync(100);
    provider.events?.onTranscript('user', '、やっぱり貸さない', { startMs: 101, endMs: 300 });
    await vi.advanceTimersByTimeAsync(250);
    provider.events?.onUserSpeech();
    provider.events?.onUserSpeechEnd();
    provider.events?.onTranscript('user', 'お金を貸して', { startMs: 400, endMs: 600 });
    await vi.advanceTimersByTimeAsync(250);
    expect(messages.some(message => message.type === 'loan_transfer')).toBe(false);
    state.scores.player = 0;
    provider.events?.onUserSpeech();
    provider.events?.onUserSpeechEnd();
    provider.events?.onTranscript('user', 'お金を貸すよ', { startMs: 700, endMs: 900 });
    await vi.advanceTimersByTimeAsync(250);
    expect(messages.some(message => message.type === 'loan_transfer')).toBe(false);
    expect(provider.confirmedLine).toHaveBeenCalledWith('$5を貸せる残高がない。自分の資金で続けよう。');
    await session.shutdown('test_finished');
  });

  it('waits past one second for speech end before rejecting a later negation in a direct borrower transcript', async () => {
    const { session, messages } = setup('settled-player-loan', 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    const state = (session as unknown as { state: MatchState }).state;
    state.scores.player = 0;
    state.scores.rival = 10;
    provider.events?.onUserSpeech();
    provider.events?.onTranscript('user', 'お金を貸して', { startMs: 0, endMs: 100 });
    await vi.advanceTimersByTimeAsync(1_100);
    expect(chooseLoanDecision).not.toHaveBeenCalled();
    provider.events?.onTranscript('user', 'ほしくない', { startMs: 101, endMs: 300 });
    provider.events?.onUserSpeechEnd();
    await vi.advanceTimersByTimeAsync(300);
    expect(chooseLoanDecision).not.toHaveBeenCalled();
    expect(messages.some(message => message.type === 'loan_transfer')).toBe(false);
    await session.shutdown('test_finished');
  });

  it('waits after speech end for a later withdrawal of a direct borrower request', async () => {
    const { session, messages } = setup('withdrawn-direct-player-loan', 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    const state = (session as unknown as { state: MatchState }).state;
    state.scores.player = 0;
    state.scores.rival = 10;
    provider.events?.onUserSpeech();
    provider.events?.onTranscript('user', 'お金を貸して', { startMs: 0, endMs: 100 });
    provider.events?.onUserSpeechEnd();
    await vi.advanceTimersByTimeAsync(100);
    provider.events?.onTranscript('user', '、やっぱりいらない', { startMs: 101, endMs: 300 });
    await vi.advanceTimersByTimeAsync(150);
    expect(chooseLoanDecision).not.toHaveBeenCalled();
    expect(messages.some(message => message.type === 'loan_transfer')).toBe(false);
    await session.shutdown('test_finished');
  });

  it('invalidates a pending direct loan acceptance after a same-turn withdrawal', async () => {
    const pending = deferred<'accept_loan' | 'reject_loan' | 'no_request'>();
    vi.mocked(chooseLoanDecision).mockReturnValueOnce(pending.promise);
    const { session, messages } = setup('pending-withdrawn-direct-loan', 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    const state = (session as unknown as { state: MatchState }).state;
    state.scores.player = 0;
    state.scores.rival = 10;
    provider.events?.onUserSpeech();
    provider.events?.onTranscript('user', 'お金を貸して', { startMs: 0, endMs: 100 });
    provider.events?.onUserSpeechEnd();
    await vi.advanceTimersByTimeAsync(251);
    expect(chooseLoanDecision).toHaveBeenCalledOnce();
    provider.events?.onTranscript('user', '、やっぱりいらない', { startMs: 101, endMs: 300 });
    pending.resolve('accept_loan');
    await pending.promise;
    await vi.advanceTimersByTimeAsync(1);
    expect(messages.some(message => message.type === 'loan_transfer')).toBe(false);
    await session.shutdown('test_finished');
  });

  it('waits one bounded transcript grace after a fast direct loan acceptance before transfer', async () => {
    vi.mocked(chooseLoanDecision).mockResolvedValueOnce('accept_loan');
    const { session, messages } = setup('fast-direct-loan-withdrawal', 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    const state = (session as unknown as { state: MatchState }).state;
    state.scores.player = 0;
    state.scores.rival = 10;
    provider.events?.onUserSpeech();
    provider.events?.onTranscript('user', 'お金を貸して', { startMs: 0, endMs: 100 });
    provider.events?.onUserSpeechEnd();
    await vi.advanceTimersByTimeAsync(250);
    expect(chooseLoanDecision).toHaveBeenCalledOnce();
    expect(messages.some(message => message.type === 'loan_transfer')).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    provider.events?.onTranscript('user', '、やっぱりいらない', { startMs: 101, endMs: 300 });
    await vi.advanceTimersByTimeAsync(250);
    expect(messages.some(message => message.type === 'loan_transfer')).toBe(false);
    expect(provider.confirmedLine).not.toHaveBeenCalledWith('しょうがないな、$5だけ貸すよ。無駄にしないで。');
    await session.shutdown('test_finished');
  });

  it('re-evaluates a pending direct loan with a same-turn positive supplement only once', async () => {
    const first = deferred<'accept_loan' | 'reject_loan' | 'no_request'>();
    const second = deferred<'accept_loan' | 'reject_loan' | 'no_request'>();
    vi.mocked(chooseLoanDecision).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { session, messages } = setup('supplemented-direct-loan', 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    const state = (session as unknown as { state: MatchState }).state;
    state.scores.player = 0;
    state.scores.rival = 10;
    provider.events?.onUserSpeech();
    provider.events?.onTranscript('user', 'お金を貸して', { startMs: 0, endMs: 100 });
    provider.events?.onUserSpeechEnd();
    await vi.advanceTimersByTimeAsync(251);
    provider.events?.onTranscript('user', '、お願い', { startMs: 101, endMs: 300 });
    await vi.advanceTimersByTimeAsync(250);
    expect(chooseLoanDecision).toHaveBeenCalledTimes(2);
    expect(chooseLoanDecision).toHaveBeenLastCalledWith(expect.anything(), 'rival_to_player', 'お金を貸して、お願い', expect.any(String), expect.any(AbortSignal), false);
    first.resolve('accept_loan');
    await first.promise;
    expect(messages.some(message => message.type === 'loan_transfer')).toBe(false);
    second.resolve('accept_loan');
    await second.promise;
    await vi.advanceTimersByTimeAsync(250);
    expect(messages.filter(message => message.type === 'loan_transfer')).toHaveLength(1);
    await session.shutdown('test_finished');
  });

  it('invalidates a pending direct loan for a new turn and accepts the new request', async () => {
    const first = deferred<'accept_loan' | 'reject_loan' | 'no_request'>();
    const second = deferred<'accept_loan' | 'reject_loan' | 'no_request'>();
    vi.mocked(chooseLoanDecision).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { session, messages } = setup('new-turn-direct-loan', 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    const state = (session as unknown as { state: MatchState }).state;
    state.scores.player = 0;
    state.scores.rival = 10;
    provider.events?.onUserSpeech();
    provider.events?.onTranscript('user', 'お金を貸して', { startMs: 0, endMs: 100 });
    provider.events?.onUserSpeechEnd();
    await vi.advanceTimersByTimeAsync(251);
    provider.events?.onUserSpeech();
    first.resolve('accept_loan');
    await first.promise;
    expect(messages.some(message => message.type === 'loan_transfer')).toBe(false);
    provider.events?.onTranscript('user', 'お金を貸して', { startMs: 301, endMs: 500 });
    provider.events?.onUserSpeechEnd();
    await vi.advanceTimersByTimeAsync(251);
    expect(chooseLoanDecision).toHaveBeenCalledTimes(2);
    second.resolve('accept_loan');
    await second.promise;
    await vi.advanceTimersByTimeAsync(250);
    expect(messages.filter(message => message.type === 'loan_transfer')).toHaveLength(1);
    await session.shutdown('test_finished');
  });

  it.each([
    { kind: 'loan', transcript: 'お金を貸してほしくない' },
    { kind: 'loan', transcript: 'お金を貸して欲しくない' },
    { kind: 'loan', transcript: 'お金を貸してほしくありません' },
    { kind: 'loan', transcript: 'お金を貸して欲しくありません' },
    { kind: 'loan', transcript: 'お金を借りたくありません' },
    { kind: 'loan', transcript: 'お金を借りたくはない' },
    { kind: 'loan', transcript: 'お金を借りません' },
    { kind: 'loan', transcript: 'お金を借りる必要ありません' },
    { kind: 'loan', transcript: 'お金を借りる必要はありません' },
    { kind: 'loan', transcript: 'お金を借りる必要がない' },
    { kind: 'loan', transcript: 'お金を借りるつもりはありません' },
    { kind: 'loan', transcript: 'お金を借りる気はない' },
    { kind: 'extension', transcript: '延長してほしくない' },
    { kind: 'extension', transcript: '延長して欲しくない' },
    { kind: 'extension', transcript: '延長してほしくありません' },
    { kind: 'extension', transcript: '延長して欲しくありません' },
  ] as const)('does not start a direct $kind decision for an explicit negative: $transcript', async ({ kind, transcript }) => {
    const { session } = setup(`negative-direct-${kind}-${transcript}`, 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    if (kind === 'loan') {
      const state = (session as unknown as { state: MatchState }).state;
      state.scores.player = 0;
      state.scores.rival = 10;
    } else await vi.advanceTimersByTimeAsync(52_000);
    provider.events?.onUserSpeech();
    provider.events?.onTranscript('user', transcript, { startMs: 0, endMs: 300 });
    provider.events?.onUserSpeechEnd();
    await vi.advanceTimersByTimeAsync(300);
    expect(chooseLoanDecision).not.toHaveBeenCalled();
    expect(chooseTimeExtension).not.toHaveBeenCalled();
    await session.shutdown('test_finished');
  });

  it('does not settle a direct borrower request after a new speech turn begins', async () => {
    const { session, messages } = setup('interrupted-direct-player-loan', 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    const state = (session as unknown as { state: MatchState }).state;
    state.scores.player = 0;
    state.scores.rival = 10;
    provider.events?.onUserSpeech();
    provider.events?.onUserSpeechEnd();
    provider.events?.onTranscript('user', 'お金を貸して', { startMs: 0, endMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    provider.events?.onUserSpeech();
    await vi.advanceTimersByTimeAsync(250);
    expect(chooseLoanDecision).not.toHaveBeenCalled();
    expect(messages.some(message => message.type === 'loan_transfer')).toBe(false);
    await session.shutdown('test_finished');
  });

  it('resolves a later Live delegation without a second loan decision after the same direct-request turn settles', async () => {
    vi.mocked(chooseLoanDecision).mockResolvedValueOnce('reject_loan');
    const { session } = setup('deduplicated-player-loan', 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    const state = (session as unknown as { state: MatchState }).state;
    state.scores.player = 0;
    state.scores.rival = 10;
    provider.events?.onUserSpeech();
    provider.events?.onTranscript('user', 'お金を貸してほしい', { startMs: 0, endMs: 300 });
    provider.events?.onUserSpeechEnd();
    await vi.advanceTimersByTimeAsync(300);
    provider.events?.onDelegation({ id: 'duplicate-player-loan', offsetMs: 400 });
    await vi.advanceTimersByTimeAsync(150);
    expect(chooseLoanDecision).toHaveBeenCalledOnce();
    expect(provider.delegationThinking).toHaveBeenCalledWith('duplicate-player-loan', expect.stringContaining('Continue the ordinary conversation'));
    await session.shutdown('test_finished');
  });

  it('resolves a later Live delegation while the direct loan decision is still pending', async () => {
    const pending = deferred<'accept_loan' | 'reject_loan' | 'no_request'>();
    vi.mocked(chooseLoanDecision).mockReturnValueOnce(pending.promise);
    const { session } = setup('pending-direct-player-loan', 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    const state = (session as unknown as { state: MatchState }).state;
    state.scores.player = 0;
    state.scores.rival = 10;
    provider.events?.onUserSpeech();
    provider.events?.onTranscript('user', 'お金を貸してほしい', { startMs: 0, endMs: 300 });
    provider.events?.onUserSpeechEnd();
    await vi.advanceTimersByTimeAsync(300);
    provider.events?.onDelegation({ id: 'pending-direct-player-loan', offsetMs: 400 });
    await vi.advanceTimersByTimeAsync(150);
    expect(chooseLoanDecision).toHaveBeenCalledOnce();
    expect(provider.delegationThinking).toHaveBeenCalledWith('pending-direct-player-loan', expect.stringContaining('Continue the ordinary conversation'));
    pending.resolve('reject_loan');
    await pending.promise;
    await session.shutdown('test_finished');
  });

  it('answers a clear borrower request when the loan decision returns no_request', async () => {
    vi.mocked(chooseLoanDecision).mockResolvedValueOnce('no_request');
    const { session, messages } = setup('loan-clarification', 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    const state = (session as unknown as { state: MatchState }).state;
    state.scores.player = 0;
    state.scores.rival = 30;
    provider.events?.onUserSpeech();
    provider.events?.onDelegation({ id: 'loan-clarification-delegation', offsetMs: 400 });
    provider.events?.onTranscript('user', 'お金を貸して', { startMs: 0, endMs: 300 });
    await vi.advanceTimersByTimeAsync(150);
    expect(provider.suppress).toHaveBeenCalledOnce();
    provider.events?.onUserSpeechEnd();
    await vi.advanceTimersByTimeAsync(250);
    expect(provider.delegationResult).toHaveBeenCalledWith('loan-clarification-delegation', expect.stringContaining('もう一度「貸して」って言ってくれる？'), expect.any(String));
    expect(messages.some(message => message.type === 'loan_transfer')).toBe(false);
    await session.shutdown('test_finished');
  });

  it('keeps an explicit late extension request on the extension decision path when the player is bankrupt', async () => {
    vi.mocked(chooseTimeExtension).mockResolvedValueOnce('reject_extension');
    const { session, messages } = setup('bankrupt-extension', 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    const state = (session as unknown as { state: MatchState }).state;
    state.scores.player = 0;
    state.scores.rival = 10;
    state.elapsed = state.processedSecond = 52;
    state.remaining = 8;
    provider.events?.onTranscript('user', '延長して', { startMs: 0, endMs: 300 });
    provider.events?.onDelegation({ id: 'bankrupt-extension-delegation', offsetMs: 400 });
    await vi.advanceTimersByTimeAsync(150);
    expect(chooseTimeExtension).toHaveBeenCalledWith(expect.objectContaining({ scores: { player: 0, rival: 10 }, remaining: 8 }), '延長して', expect.any(String), expect.any(AbortSignal), false);
    expect(chooseLoanDecision).not.toHaveBeenCalled();
    expect(messages.some(message => message.type === 'loan_transfer')).toBe(false);
    await session.shutdown('test_finished');
  });

  it('offers a rival loan once, transfers a clear reply immediately, and ignores an expired reply', async () => {
    const first = setup('rival-loan', 'manual', 'audio');
    await first.session.initialize();
    first.session.handleRaw('{"type":"start"}');
    const firstState = (first.session as unknown as { state: MatchState }).state;
    firstState.scores.player = 10;
    firstState.scores.rival = 0;
    // A loan remains available in the final seconds when no extension offer
    // or extension decision is active.
    firstState.elapsed = firstState.processedSecond = 50;
    firstState.remaining = 10;
    first.session.handleRaw('{"type":"snapshot"}');
    startLoanOffer();
    await vi.advanceTimersByTimeAsync(1_000);
    provider.events?.onTranscript('user', 'Sure!', { startMs: 0, endMs: 300 });
    provider.events?.onDelegation({ id: 'rival-loan-delegation', offsetMs: 400 });
    await vi.advanceTimersByTimeAsync(150);
    expect(chooseLoanDecision).not.toHaveBeenCalled();
    expect(first.messages.find(message => message.type === 'loan_transfer')).toMatchObject({ direction: 'player_to_rival', amount: 5, after: { scores: { player: 5, rival: 5 } } });
    firstState.scores.player = 10;
    firstState.scores.rival = 0;
    first.session.handleRaw('{"type":"snapshot"}');
    expect(provider.confirmedLine.mock.calls.filter(([line]) => line === 'お金がなくなっちゃった。5ドル貸してくれない？')).toHaveLength(1);
    await first.session.shutdown('test_finished');

    const second = setup('expired-rival-loan', 'manual', 'audio');
    await second.session.initialize();
    second.session.handleRaw('{"type":"start"}');
    const secondState = (second.session as unknown as { state: MatchState }).state;
    secondState.scores.player = 10;
    secondState.scores.rival = 0;
    second.session.handleRaw('{"type":"snapshot"}');
    const secondOfferSpeechId = startLoanOffer();
    finishLoanOffer(second.session, secondOfferSpeechId);
    await vi.advanceTimersByTimeAsync(5_001);
    second.session.handleRaw('{"type":"snapshot"}');
    provider.events?.onTranscript('user', 'Sure!', { startMs: 0, endMs: 300 });
    provider.events?.onDelegation({ id: 'expired-rival-loan-delegation', offsetMs: 400 });
    await vi.advanceTimersByTimeAsync(150);
    expect(second.messages.some(message => message.type === 'loan_transfer')).toBe(false);
    await second.session.shutdown('test_finished');
  });

  it.each(['いいよ', 'いいですよ'])('immediately transfers a clear reply to a spoken rival loan offer without AI judgment: %s', async affirmative => {
    const { session, messages } = setup('immediate-rival-loan', 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    const state = (session as unknown as { state: MatchState }).state;
    state.scores.player = 10;
    state.scores.rival = 0;
    state.elapsed = state.processedSecond = 59;
    state.remaining = 1;
    session.handleRaw('{"type":"snapshot"}');
    startLoanOffer();
    provider.events?.onUserSpeech();
    provider.events?.onTranscript('user', affirmative, { startMs: 0, endMs: 100 });
    provider.events?.onUserSpeechEnd();
    await vi.advanceTimersByTimeAsync(250);
    const transfers = messages.filter((message): message is Extract<ServerMessage, { type: 'loan_transfer' }> => message.type === 'loan_transfer');
    expect(transfers).toHaveLength(1);
    expect(transfers[0]).toMatchObject({ direction: 'player_to_rival', amount: 5, after: { scores: { player: 5, rival: 5 } } });
    expect(chooseLoanDecision).not.toHaveBeenCalled();
    expect(provider.confirmedLine).toHaveBeenCalledWith('助かった、$5借りるよ。ここから巻き返す。');
    provider.events?.onTranscript('user', affirmative, { startMs: 101, endMs: 200 });
    expect(messages.filter(message => message.type === 'loan_transfer')).toHaveLength(1);
    await session.shutdown('test_finished');
  });

  it('uses tagged offer audio when a delegation and an unrelated assistant transcript arrive before the affirmative', async () => {
    const { session, messages } = setup('tagged-rival-loan', 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    const state = (session as unknown as { state: MatchState }).state;
    state.scores.player = 10;
    state.scores.rival = 0;
    session.handleRaw('{"type":"snapshot"}');
    startLoanOffer();
    provider.events?.onDelegation({ id: 'tagged-rival-loan-delegation', offsetMs: 400 });
    provider.events?.onTranscript('assistant', 'まだ声が出始めただけ。');
    provider.events?.onUserSpeech();
    provider.events?.onTranscript('user', 'いいよ', { startMs: 0, endMs: 100 });
    provider.events?.onUserSpeechEnd();
    await vi.advanceTimersByTimeAsync(250);
    expect(messages.filter(message => message.type === 'loan_transfer')).toHaveLength(1);
    expect(chooseLoanDecision).not.toHaveBeenCalled();
    await session.shutdown('test_finished');
  });

  it('does not immediately transfer a negative or expired rival-loan reply', async () => {
    const { session, messages } = setup('guarded-rival-loan', 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    const state = (session as unknown as { state: MatchState }).state;
    state.scores.player = 10;
    state.scores.rival = 0;
    session.handleRaw('{"type":"snapshot"}');
    const guardedOfferSpeechId = startLoanOffer();
    provider.events?.onUserSpeech();
    provider.events?.onTranscript('user', 'いや', { startMs: 0, endMs: 100 });
    expect(messages.some(message => message.type === 'loan_transfer')).toBe(false);
    finishLoanOffer(session, guardedOfferSpeechId);
    await vi.advanceTimersByTimeAsync(5_001);
    session.handleRaw('{"type":"snapshot"}');
    provider.events?.onUserSpeech();
    provider.events?.onTranscript('user', 'いいよ', { startMs: 200, endMs: 300 });
    expect(messages.some(message => message.type === 'loan_transfer')).toBe(false);
    await session.shutdown('test_finished');
  });

  it.each(['いいよ', 'いいですよ'])('transfers a clear reply whose turn started before the loan deadline but whose transcript is delayed: %s', async affirmative => {
    const { session, messages } = setup('delayed-rival-loan', 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    const state = (session as unknown as { state: MatchState }).state;
    state.scores.player = 10;
    state.scores.rival = 0;
    session.handleRaw('{"type":"snapshot"}');
    const speechId = startLoanOffer();
    finishLoanOffer(session, speechId);
    await vi.advanceTimersByTimeAsync(4_900);
    provider.events?.onUserSpeech();
    await vi.advanceTimersByTimeAsync(200);
    provider.events?.onUserSpeechEnd();
    provider.events?.onTranscript('user', `${affirmative}、`, { startMs: 0, endMs: 100 });
    expect(messages.some(message => message.type === 'loan_transfer')).toBe(false);
    await vi.advanceTimersByTimeAsync(250);
    expect(messages.filter(message => message.type === 'loan_transfer')).toHaveLength(1);
    expect(messages.find(message => message.type === 'loan_transfer')).toMatchObject({ direction: 'player_to_rival', amount: 5 });
    expect(chooseLoanDecision).not.toHaveBeenCalled();
    await session.shutdown('test_finished');
  });

  it.each(['いいよ', 'いいですよ'])('does not transfer a comma-ended rival-loan reply when a later transcript delta refuses it: %s', async affirmative => {
    const { session, messages } = setup('refused-settled-rival-loan', 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    const state = (session as unknown as { state: MatchState }).state;
    state.scores.player = 10;
    state.scores.rival = 0;
    session.handleRaw('{"type":"snapshot"}');
    const speechId = startLoanOffer();
    finishLoanOffer(session, speechId);
    provider.events?.onUserSpeech();
    provider.events?.onUserSpeechEnd();
    provider.events?.onTranscript('user', `${affirmative}、`, { startMs: 0, endMs: 100 });
    provider.events?.onTranscript('user', 'でも無理', { startMs: 101, endMs: 200 });
    await vi.advanceTimersByTimeAsync(150);
    expect(messages.some(message => message.type === 'loan_transfer')).toBe(false);
    await session.shutdown('test_finished');
  });

  it('does not carry a pre-deadline loan reply grace into a later user turn', async () => {
    const { session, messages } = setup('next-turn-rival-loan', 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    const state = (session as unknown as { state: MatchState }).state;
    state.scores.player = 10;
    state.scores.rival = 0;
    session.handleRaw('{"type":"snapshot"}');
    const speechId = startLoanOffer();
    finishLoanOffer(session, speechId);
    await vi.advanceTimersByTimeAsync(4_900);
    provider.events?.onUserSpeech();
    await vi.advanceTimersByTimeAsync(200);
    provider.events?.onUserSpeech();
    provider.events?.onTranscript('user', 'いいよ', { startMs: 0, endMs: 100 });
    expect(messages.some(message => message.type === 'loan_transfer')).toBe(false);
    await session.shutdown('test_finished');
  });

  it('does not accept a pre-deadline loan reply after its finite transcript grace expires', async () => {
    const { session, messages } = setup('expired-delayed-rival-loan', 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    const state = (session as unknown as { state: MatchState }).state;
    state.scores.player = 10;
    state.scores.rival = 0;
    session.handleRaw('{"type":"snapshot"}');
    const speechId = startLoanOffer();
    finishLoanOffer(session, speechId);
    await vi.advanceTimersByTimeAsync(4_900);
    provider.events?.onUserSpeech();
    await vi.advanceTimersByTimeAsync(1_200);
    provider.events?.onTranscript('user', 'いいよ', { startMs: 0, endMs: 100 });
    expect(messages.some(message => message.type === 'loan_transfer')).toBe(false);
    await session.shutdown('test_finished');
  });

  it('does not extend a reply that started during the loan offer past playback completion and its transcript grace', async () => {
    const { session, messages } = setup('spoken-offer-expired-rival-loan', 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    const state = (session as unknown as { state: MatchState }).state;
    state.scores.player = 10;
    state.scores.rival = 0;
    session.handleRaw('{"type":"snapshot"}');
    const speechId = startLoanOffer();
    provider.events?.onUserSpeech();
    await vi.advanceTimersByTimeAsync(5_000);
    finishLoanOffer(session, speechId);
    await vi.advanceTimersByTimeAsync(6_001);
    provider.events?.onTranscript('user', 'いいよ', { startMs: 0, endMs: 100 });
    expect(messages.some(message => message.type === 'loan_transfer')).toBe(false);
    await session.shutdown('test_finished');
  });

  it('keeps legacy latest-spin recovery snapshots valid across a loan and the next spin', async () => {
    vi.mocked(chooseLoanDecision).mockResolvedValueOnce('accept_loan');
    const { session, messages } = setup('loan-recovery', 'automatic', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    await vi.advanceTimersByTimeAsync(2_000);
    const internals = session as unknown as {
      state: MatchState;
      lastSpin: { player: SpinView; rival: SpinView } | undefined;
      lastSpins: Partial<Record<'player' | 'rival', SpinView>>;
    };
    const pair = internals.lastSpin!;
    // These are actual confirmed reel outcomes; set the test bankroll to the
    // matching post-spin values needed to exercise the player-to-rival loan.
    internals.state.scores.player = 10;
    internals.state.scores.rival = 0;
    // Automatic spins intentionally share this pair with lastSpins. Retain
    // that legacy shape while making the last reel totals match the bankroll.
    pair.player.total = 10;
    pair.rival.total = 0;
    session.handleRaw('{"type":"snapshot"}');
    expect(parseServerEnvelope(JSON.stringify(messages.filter(message => message.type === 'snapshot').at(-1)))).not.toBeNull();
    startLoanOffer();
    await vi.advanceTimersByTimeAsync(1_000);
    provider.events?.onTranscript('user', 'Sure!', { startMs: 0, endMs: 300 });
    provider.events?.onDelegation({ id: 'loan-recovery-delegation', offsetMs: 400 });
    await vi.advanceTimersByTimeAsync(150);
    const loanSnapshot = messages.filter(message => message.type === 'snapshot').at(-1)!;
    expect(parseServerEnvelope(JSON.stringify(loanSnapshot))).not.toBeNull();
    expect(loanSnapshot.lastSpin).toMatchObject({ player: { total: 5 }, rival: { total: 5 } });
    session.handleRaw('{"type":"snapshot"}');
    expect(parseServerEnvelope(JSON.stringify(messages.filter(message => message.type === 'snapshot').at(-1)))).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1_000);
    session.handleRaw('{"type":"snapshot"}');
    expect(parseServerEnvelope(JSON.stringify(messages.filter(message => message.type === 'snapshot').at(-1)))).not.toBeNull();
    await session.shutdown('test_finished');
  });

  it('keeps split latest-spin recovery snapshots valid across a loan and the next manual spin', async () => {
    vi.mocked(chooseLoanDecision).mockResolvedValueOnce('accept_loan');
    const { session, messages } = setup('loan-recovery-manual', 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    session.handleRaw('{"type":"spin","matchId":"loan-recovery-manual","commandId":"loan-spin-1"}');
    await vi.advanceTimersByTimeAsync(2_000);
    const internals = session as unknown as {
      state: MatchState;
      lastSpin: { player: SpinView; rival: SpinView } | undefined;
      lastSpins: Partial<Record<'player' | 'rival', SpinView>>;
    };
    expect(internals.lastSpin).toBeUndefined();
    const playerSpin = internals.lastSpins.player!;
    const rivalSpin = internals.lastSpins.rival!;
    internals.state.scores.player = 10;
    internals.state.scores.rival = 0;
    playerSpin.total = 10;
    rivalSpin.total = 0;
    await vi.advanceTimersByTimeAsync(100);
    startLoanOffer();
    await vi.advanceTimersByTimeAsync(1_000);
    provider.events?.onTranscript('user', 'Sure!', { startMs: 0, endMs: 300 });
    provider.events?.onDelegation({ id: 'loan-recovery-manual-delegation', offsetMs: 400 });
    await vi.advanceTimersByTimeAsync(150);
    const loanSnapshot = messages.filter(message => message.type === 'snapshot').at(-1)!;
    expect(parseServerEnvelope(JSON.stringify(loanSnapshot))).not.toBeNull();
    expect(loanSnapshot.lastSpins).toMatchObject({ player: { total: 5 }, rival: { total: 5 } });
    session.handleRaw('{"type":"snapshot"}');
    expect(parseServerEnvelope(JSON.stringify(messages.filter(message => message.type === 'snapshot').at(-1)))).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1_100);
    session.handleRaw('{"type":"spin","matchId":"loan-recovery-manual","commandId":"loan-spin-2"}');
    session.handleRaw('{"type":"snapshot"}');
    expect(parseServerEnvelope(JSON.stringify(messages.filter(message => message.type === 'snapshot').at(-1)))).not.toBeNull();
    await session.shutdown('test_finished');
  });

  it('never transfers after a delayed decision reaches result or voice disconnect', async () => {
    const late = deferred<'accept_loan'>();
    vi.mocked(chooseLoanDecision).mockReturnValueOnce(late.promise);
    const first = setup('late-player-loan', 'manual', 'audio');
    await first.session.initialize();
    first.session.handleRaw('{"type":"start"}');
    const firstState = (first.session as unknown as { state: MatchState }).state;
    firstState.scores.player = 0;
    firstState.scores.rival = 10;
    provider.events?.onTranscript('user', 'Please lend me money.', { startMs: 0, endMs: 300 });
    provider.events?.onDelegation({ id: 'late-loan-delegation', offsetMs: 400 });
    await vi.advanceTimersByTimeAsync(150);
    await vi.advanceTimersByTimeAsync(61_000);
    late.resolve('accept_loan');
    await late.promise;
    await vi.advanceTimersByTimeAsync(1);
    expect(first.messages.some(message => message.type === 'loan_transfer')).toBe(false);
    await first.session.shutdown('test_finished');

    const disconnected = deferred<'accept_loan'>();
    vi.mocked(chooseLoanDecision).mockReturnValueOnce(disconnected.promise);
    const second = setup('disconnected-player-loan', 'manual', 'audio');
    await second.session.initialize();
    second.session.handleRaw('{"type":"start"}');
    const secondState = (second.session as unknown as { state: MatchState }).state;
    secondState.scores.player = 0;
    secondState.scores.rival = 10;
    provider.events?.onTranscript('user', 'Please lend me money.', { startMs: 0, endMs: 300 });
    provider.events?.onDelegation({ id: 'disconnect-loan-delegation', offsetMs: 400 });
    await vi.advanceTimersByTimeAsync(150);
    second.session.handleRaw('{"type":"voice_close"}');
    disconnected.resolve('accept_loan');
    await disconnected.promise;
    await vi.advanceTimersByTimeAsync(1);
    expect(second.messages.some(message => message.type === 'loan_transfer')).toBe(false);
    await second.session.shutdown('test_finished');
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
    expect(provider.context).toHaveBeenLastCalledWith(expect.stringContaining('ライバルは時間延長を提案済み。プレイヤーの短い同意は、結果が出るまで発話せずに扱う。拒否は延長しない。'));
    provider.events?.onUserSpeech();
    provider.events?.onTranscript('user', 'うん', { startMs: 0, endMs: 200 });
    provider.events?.onUserSpeechEnd();
    provider.events?.onDelegation({ id: 'item-offer', offsetMs: 300 });
    await vi.advanceTimersByTimeAsync(150);
    expect(chooseTimeExtension).toHaveBeenCalledWith(expect.anything(), 'うん', expect.any(String), expect.any(AbortSignal), true);
    await vi.advanceTimersByTimeAsync(250);
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
    (session as unknown as { state: MatchState }).state.scores.rival = 100;
    await vi.advanceTimersByTimeAsync(52_000);
    provider.events?.onTranscript('user', 'まだ負けたくない', { startMs: 0, endMs: 300 });
    provider.events?.onDelegation({ id: 'item-no-request', offsetMs: 400 });
    await vi.advanceTimersByTimeAsync(150);
    expect(chooseTimeExtension).toHaveBeenCalledOnce();
    expect(messages.some(message => message.type === 'time_extension')).toBe(false);
    expect(provider.delegationThinking).toHaveBeenCalledWith('item-no-request', expect.stringContaining('Continue the ordinary conversation'));
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
    (session as unknown as { state: MatchState }).state.scores.rival = 100;
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
    expect(provider.delegationThinking).toHaveBeenCalledWith('item-early', expect.stringContaining('Continue the ordinary conversation'));
    await session.shutdown('test_finished');
  });

  it.each(['いや', 'no'])('keeps an explicit declined offer in that turn, then routes a later clear request: %s', async transcript => {
    const { session, messages } = setup('declined-rival-offer', 'manual', 'audio', () => 0);
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    await vi.advanceTimersByTimeAsync(46_000);
    provider.events?.onUserSpeech();
    provider.events?.onTranscript('user', transcript);
    provider.events?.onUserSpeechEnd();
    await vi.advanceTimersByTimeAsync(300);
    expect(messages.some(message => message.type === 'time_extension')).toBe(false);
    expect(chooseTimeExtension).not.toHaveBeenCalled();
    provider.events?.onUserSpeech();
    provider.events?.onTranscript('user', 'やっぱり延長して');
    provider.events?.onUserSpeechEnd();
    await vi.advanceTimersByTimeAsync(300);
    expect(chooseTimeExtension).toHaveBeenCalledWith(expect.anything(), 'やっぱり延長して', expect.any(String), expect.any(AbortSignal), false);
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

  it('switches once to a $0 chat policy, suppresses the automatic extension offer, and restores normal context after a confirmed payout', async () => {
    const { session } = setup('zero-balance-chat', 'manual', 'audio', () => 0);
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    const state = (session as unknown as { state: MatchState }).state;
    state.scores.player = 0;
    state.scores.rival = 0;
    state.elapsed = state.processedSecond = 52;
    state.remaining = 8;
    await vi.advanceTimersByTimeAsync(100);
    expect(provider.context).toHaveBeenLastCalledWith(expect.stringContaining('初回の資金切れへの一言はまだ発話しない'));
    expect(provider.confirmedLine).not.toHaveBeenCalledWith('もう少し時間が欲しい？ 伸ばしてあげようか？');
    await vi.advanceTimersByTimeAsync(3000);
    expect(provider.reaction.mock.calls.filter(([text]) => String(text).includes('双方の確定残高が$0で未確定回転はない'))).toHaveLength(1);
    expect(provider.reaction).toHaveBeenCalledWith(expect.stringContaining('まず資金切れかこの台への軽い愚痴・感想'));
    expect(provider.reaction).toHaveBeenCalledWith(expect.stringContaining('短い二文までで終え'));
    expect(provider.context).toHaveBeenLastCalledWith(expect.stringContaining('初回の資金切れへの一言はすでに一度伝えた'));
    (session as unknown as { startedAt: number }).startedAt = Date.now() - 53_000;
    await vi.advanceTimersByTimeAsync(100);
    expect(provider.context).toHaveBeenLastCalledWith(expect.stringContaining('これは発話要求ではない'));
    expect(provider.context).toHaveBeenLastCalledWith(expect.not.stringContaining('初回反応を待ち'));
    provider.events?.onUserSpeech();
    provider.events?.onUserSpeechEnd();
    await vi.advanceTimersByTimeAsync(4000);
    expect(provider.reaction.mock.calls.filter(([text]) => String(text).includes('双方の確定残高が$0で未確定回転はない'))).toHaveLength(1);
    state.scores.player = 4;
    state.scores.rival = 2;
    await vi.advanceTimersByTimeAsync(100);
    expect(provider.context).toHaveBeenLastCalledWith(expect.stringContaining('会話方針: 通常のゲーム会話。'));
    await session.shutdown('test_finished');
  });

  it('keeps a $0 ready lobby silent until the match starts', async () => {
    const { session } = setup('zero-balance-ready', 'manual', 'audio');
    await session.initialize();
    const state = (session as unknown as { state: MatchState }).state;
    state.scores.player = state.scores.rival = 0;
    const context = (session as unknown as { gameContext(): string }).gameContext();
    expect(context).toContain('まだ試合開始前。雑談への移行案内を発話せず待つ');
    expect(context).not.toContain('初回の資金切れへの一言はすでに一度伝えた');
    await session.shutdown('test_finished');
  });

  it('retries the $0 transition after the AI response cooldown rejects its first request', async () => {
    const { session } = setup('zero-balance-bridge-cooldown', 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    await vi.advanceTimersByTimeAsync(100);
    provider.reaction.mockReturnValueOnce(false).mockReturnValueOnce(true);
    const state = (session as unknown as { state: MatchState }).state;
    state.scores.player = state.scores.rival = 0;
    await vi.advanceTimersByTimeAsync(3000);
    const zeroReactionCount = () => provider.reaction.mock.calls.filter(call => String(call[0]).includes('双方の確定残高が$0で未確定回転はない')).length;
    expect(zeroReactionCount()).toBe(1);
    expect(provider.context).toHaveBeenLastCalledWith(expect.stringContaining('初回の資金切れへの一言はまだ発話しない'));
    await vi.advanceTimersByTimeAsync(250);
    expect(zeroReactionCount()).toBe(2);
    expect(provider.context).toHaveBeenLastCalledWith(expect.stringContaining('初回の資金切れへの一言はすでに一度伝えた'));
    await vi.advanceTimersByTimeAsync(4000);
    expect(zeroReactionCount()).toBe(2);
    await session.shutdown('test_finished');
  });

  it('keeps the $0 chat invitation through an ordinary reaction cooldown and a long user turn', async () => {
    const { session } = setup('zero-balance-user-priority', 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    await vi.advanceTimersByTimeAsync(100);
    expect(provider.reaction).toHaveBeenCalledWith('対戦が今始まる。短く挑発して。');
    const state = (session as unknown as { state: MatchState }).state;
    state.scores.player = state.scores.rival = 0;
    await vi.advanceTimersByTimeAsync(100);
    provider.events?.onUserSpeech();
    await vi.advanceTimersByTimeAsync(6000);
    expect(provider.reaction.mock.calls.some(([text]) => String(text).includes('双方の確定残高が$0で未確定回転はない'))).toBe(false);
    provider.events?.onUserSpeechEnd();
    await vi.advanceTimersByTimeAsync(3999);
    expect(provider.reaction.mock.calls.some(([text]) => String(text).includes('双方の確定残高が$0で未確定回転はない'))).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(provider.reaction.mock.calls.filter(([text]) => String(text).includes('双方の確定残高が$0で未確定回転はない'))).toHaveLength(1);
    await session.shutdown('test_finished');
  });

  it('keeps an explicit time-extension request available when both balances are $0', async () => {
    vi.mocked(chooseTimeExtension).mockResolvedValueOnce('reject_extension');
    const { session } = setup('zero-balance-explicit-extension', 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    const state = (session as unknown as { state: MatchState }).state;
    state.scores.player = state.scores.rival = 0;
    state.elapsed = state.processedSecond = 52;
    state.remaining = 8;
    provider.events?.onTranscript('user', '延長して', { startMs: 0, endMs: 300 });
    provider.events?.onDelegation({ id: 'zero-balance-extension', offsetMs: 400 });
    await vi.advanceTimersByTimeAsync(150);
    expect(chooseTimeExtension).toHaveBeenCalledWith(expect.objectContaining({ scores: { player: 0, rival: 0 }, remaining: 8 }), '延長して', expect.any(String), expect.any(AbortSignal), false);
    await session.shutdown('test_finished');
  });

  it('uses the $0 policy for the final line instead of inviting a rematch', async () => {
    const { session } = setup('zero-balance-result', 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    const state = (session as unknown as { state: MatchState }).state;
    state.scores.player = state.scores.rival = 0;
    state.elapsed = state.processedSecond = 59;
    state.remaining = 1;
    (session as unknown as { startedAt: number }).startedAt = Date.now() - 60_000;
    await vi.advanceTimersByTimeAsync(100);
    expect(provider.openingContexts.at(-1)).toContain('会話方針: 双方の確定残高が$0で試合は終了済み。雑談への移行案内や再戦を誘わず');
    expect(provider.reaction).toHaveBeenCalledWith(expect.stringContaining('逆転、再戦、追加の回転は誘わず'));
    await session.shutdown('test_finished');
  });

  it('keeps the clock moving and rejects a delayed decision after the match ends', async () => {
    const late = deferred<'accept_extension_10s'>();
    vi.mocked(chooseTimeExtension).mockReturnValueOnce(late.promise);
    const { session, messages } = setup('late-extension', 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    (session as unknown as { state: MatchState }).state.scores.rival = 100;
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
