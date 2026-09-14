import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';
import type { LiveEvents } from './gptLive';
import type { ServerMessage } from '../shared/protocol';
import type { MatchState } from '../src/domain/game';
import { parseServerEnvelope } from '../shared/wire';

const provider = vi.hoisted(() => ({
  start: vi.fn(), stop: vi.fn(), mediaStart: vi.fn(), mediaClose: vi.fn(),
  mediaFailures: [] as Array<() => void>,
  gptConnect: vi.fn(), gptClose: vi.fn(), events: null as LiveEvents | null, bridges: [] as LiveEvents[], bridgeLanguages: [] as Array<'ja' | 'en'>,
  context: vi.fn(), reaction: vi.fn(), conversationInvitation: vi.fn(() => true), confirmedLine: vi.fn(), cancelConfirmedSpeech: vi.fn(), delegationResult: vi.fn(), delegationThinking: vi.fn(), suppress: vi.fn(), mic: vi.fn(), language: vi.fn(), beginUserSpeech: vi.fn(), endUserSpeech: vi.fn(), finishUserTurnGate: vi.fn(), playbackDone: vi.fn(), interruptPlayback: vi.fn(), discardNormalPlayback: vi.fn(), mediaComplete: vi.fn(),
  speak: vi.fn(), interrupt: vi.fn(), interruptWait: vi.fn(), openingContexts: [] as string[],
  seed: [1, 0, 0, 0] as [number, number, number, number],
}));
const agreement = vi.hoisted(() => ({
  resolve: vi.fn(),
  auditAssistantSpeech: vi.fn(),
  applyOnce: vi.fn(),
  applied: new Set<string>(),
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
  completeSpeechInput = provider.mediaComplete;
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
  requestConversationInvitation = provider.conversationInvitation;
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
  endUserSpeech = provider.endUserSpeech;
  finishUserTurnGate = provider.finishUserTurnGate;
  sendMic = provider.mic;
  noteSpeechPlaybackDone = provider.playbackDone;
  interruptPlayback = provider.interruptPlayback;
  discardNormalPlayback = provider.discardNormalPlayback;
} }));
vi.mock('./conversationAgreement', () => ({ ConversationAgreementCoordinator: class {
  resolve = agreement.resolve;
  auditAssistantSpeech = agreement.auditAssistantSpeech;
  applyOnce = agreement.applyOnce;
} }));
vi.mock('./rivalBrain', async importOriginal => ({
  ...(await importOriginal<typeof import('./rivalBrain')>()),
  chooseRivalUpgrade: vi.fn(async () => ({ upgradeId: 'steady', source: 'fallback' })),
}));
import { MatchSession } from './matchSession';

const avatar = { sessionId: 'test-session', livekitUrl: 'test-url', livekitToken: 'test-token', mediaWsUrl: 'test-media' };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
// All live sessions use the bankroll rules; automatic mode remains useful for lifecycle timing.
function setup(id = 'test-match', spinMode: 'automatic' | 'manual' = 'automatic', voiceMode: 'audio' | 'avatar' = 'avatar', random: () => number = () => 1, usePacer = false) {
  const messages: ServerMessage[] = [];
  const close = vi.fn();
  const socket = { readyState: 1, close, send: (data: string) => messages.push(JSON.parse(data)) } as unknown as WebSocket;
  const release = vi.fn(async () => undefined);
  const session = new MatchSession(socket, id, release, { spinMode, voiceMode, random });
  if (!usePacer) {
    const pacer = session as unknown as { conversationPacer: { canInitiate: (now?: number) => boolean; nextInitiatedAt: () => number; markInitiatedSpeechSent: (now?: number) => void } };
    vi.spyOn(pacer.conversationPacer, 'canInitiate').mockReturnValue(true);
    vi.spyOn(pacer.conversationPacer, 'nextInitiatedAt').mockReturnValue(0);
    vi.spyOn(pacer.conversationPacer, 'markInitiatedSpeechSent').mockImplementation(() => undefined);
  }
  return { session, messages, release, close };
}
type AgreementEventBridge = {
  onUserSpeech(timeline?: { startMs: number; endMs: number }): void;
  onUserSpeechEnd(timeline?: { startMs: number; endMs: number }): void;
  onTranscript(role: 'user' | 'assistant', delta: string, timing?: { startMs?: number; endMs?: number }): void;
  onNormalSpeechCandidate?(candidate: { speechId: string; transcript: string; signal: AbortSignal }): Promise<boolean>;
};
function agreementBridge(): AgreementEventBridge {
  expect(provider.events).not.toBeNull();
  return provider.events as unknown as AgreementEventBridge;
}
function completeAgreementTurn(turnId: string, transcript: string, startMs = 0, endMs = 100): void {
  const bridge = agreementBridge();
  void turnId;
  bridge.onUserSpeech({ startMs, endMs: startMs + 10 });
  bridge.onTranscript('user', transcript, { startMs, endMs });
  bridge.onUserSpeechEnd({ startMs: endMs - 10, endMs });
}
async function settleAgreement(): Promise<void> {
  await vi.advanceTimersByTimeAsync(350);
  await vi.waitFor(() => expect(agreement.resolve).toHaveBeenCalled());
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  provider.seed = [1, 0, 0, 0];
  provider.bridges.length = 0;
  provider.bridgeLanguages.length = 0;
  provider.openingContexts.length = 0;
  provider.mediaFailures.length = 0;
  agreement.applied.clear();
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network disabled in lifecycle tests'); }));
  provider.start.mockResolvedValue(avatar);
  provider.stop.mockResolvedValue(undefined);
  provider.mediaStart.mockResolvedValue(true);
  provider.interruptWait.mockResolvedValue(true);
  provider.gptConnect.mockImplementation(async () => { provider.events?.onReady(); return true; });
  provider.gptClose.mockResolvedValue(undefined);
  agreement.resolve.mockImplementation(async (turn: { id: string }) => ({ state: 'none', id: turn.id }));
  agreement.auditAssistantSpeech.mockResolvedValue({ state: 'safe' });
  agreement.applyOnce.mockImplementation((id: string, item: { action: 'rival_to_player' | 'player_to_rival' | 'time_extension'; offerId: string | null }, apply: (direction?: 'rival_to_player' | 'player_to_rival') => boolean) => {
    const turnKey = `${id}:applied:${item.action}`;
    const offerKey = item.offerId === null ? null : `${item.offerId}:applied:${item.action}`;
    const turnApplied = agreement.applied.has(turnKey);
    const offerApplied = offerKey !== null && agreement.applied.has(offerKey);
    if (turnApplied || offerApplied) {
      if (turnApplied && offerKey !== null) agreement.applied.add(offerKey);
      if (offerApplied) agreement.applied.add(turnKey);
      return false;
    }
    const applied = apply(item.action === 'time_extension' ? undefined : item.action);
    if (applied) {
      agreement.applied.add(turnKey);
      if (offerKey !== null) agreement.applied.add(offerKey);
    }
    return applied;
  });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('provider status lifecycle', () => {
  it('returns a normal speech playback ACK to the live bridge', async () => {
    const { session, messages } = setup('normal-playback-ack', 'manual', 'audio');
    await session.initialize();
    const speechId = 'normal-1';
    provider.events?.onAudio(Buffer.alloc(4800, 4).toString('base64'), speechId, 'normal');
    provider.events?.onSpeechAudioEnded(speechId);
    expect(messages).toContainEqual(expect.objectContaining({ type: 'voice_audio', speechId }));
    expect(messages).toContainEqual(expect.objectContaining({ type: 'voice_speech_end', speechId }));
    session.handleRaw(JSON.stringify({ type: 'voice_speech_done', speechId }));
    expect(provider.playbackDone).toHaveBeenCalledExactlyOnceWith(speechId);
    await session.shutdown('test_finished');
  });

  it('releases a suppressed normal Avatar utterance instead of waiting for an impossible media ACK', async () => {
    const { session } = setup('suppressed-normal-avatar', 'manual', 'avatar');
    await session.initialize();
    agreementBridge().onUserSpeech({ startMs: 0, endMs: 10 });
    const speechId = 'normal-suppressed';
    provider.events?.onAudio(Buffer.alloc(4800, 4).toString('base64'), speechId, 'normal');
    provider.events?.onSpeechAudioEnded(speechId);
    expect(provider.speak).not.toHaveBeenCalled();
    expect(provider.mediaComplete).not.toHaveBeenCalled();
    expect(provider.discardNormalPlayback).toHaveBeenCalledExactlyOnceWith(speechId);
    await session.shutdown('test_finished');
  });

  it('settles a complete English turn before preserving English for the rest of the match', async () => {
    const { session } = setup('english-turn', 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    agreementBridge().onUserSpeech({ startMs: 0, endMs: 100 });
    provider.events?.onTranscript('user', 'これは ABC の話', { startMs: 0, endMs: 100 });
    agreementBridge().onUserSpeechEnd({ startMs: 0, endMs: 100 });
    await vi.advanceTimersByTimeAsync(250);
    expect(provider.language).toHaveBeenLastCalledWith('ja');
    agreementBridge().onUserSpeech({ startMs: 200, endMs: 300 });
    agreementBridge().onUserSpeechEnd({ startMs: 200, endMs: 300 });
    await vi.advanceTimersByTimeAsync(200);
    provider.events?.onTranscript('user', 'Absolutely!', { startMs: 200, endMs: 300 });
    await vi.advanceTimersByTimeAsync(249);
    expect(provider.language).not.toHaveBeenCalledWith('en');
    await vi.advanceTimersByTimeAsync(1);
    expect(provider.language).toHaveBeenLastCalledWith('en');
    agreementBridge().onUserSpeech({ startMs: 400, endMs: 700 });
    provider.events?.onTranscript('user', '日本語に ABC が混ざる返答', { startMs: 400, endMs: 700 });
    agreementBridge().onUserSpeechEnd({ startMs: 400, endMs: 700 });
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
    agreementBridge().onUserSpeech({ startMs: 0, endMs: 300 });
    agreementBridge().onUserSpeechEnd({ startMs: 0, endMs: 300 });
    await vi.advanceTimersByTimeAsync(100);
    provider.events?.onTranscript('user', transcript, { startMs: 0, endMs: 300 });
    await vi.advanceTimersByTimeAsync(1_600);
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
    await vi.advanceTimersByTimeAsync(59_800);
    const matchBridge = provider.bridges[0];
    matchBridge.onUserSpeech({ startMs: 0, endMs: 300 });
    matchBridge.onUserSpeechEnd({ startMs: 0, endMs: 300 });
    await vi.advanceTimersByTimeAsync(100);
    expect(provider.bridges).toHaveLength(1);
    matchBridge.onTranscript('user', transcript, { startMs: 0, endMs: 300 });
    await vi.advanceTimersByTimeAsync(1_600);
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
    await vi.advanceTimersByTimeAsync(350);
    matchBridge.onUserSpeech();
    matchBridge.onTranscript('user', 'Hello', { startMs: 0, endMs: 300 });
    await vi.advanceTimersByTimeAsync(150);
    expect(provider.bridgeLanguages.at(-1)).toBe('ja');
    expect(provider.openingContexts.at(-1)).not.toContain('Hello');
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
    agreementBridge().onUserSpeech({ startMs: 0, endMs: 100 });
    provider.events?.onTranscript('user', 'Hello', { startMs: 0, endMs: 100 });
    agreementBridge().onUserSpeechEnd({ startMs: 0, endMs: 100 });
    await vi.advanceTimersByTimeAsync(350);
    expect(provider.language).toHaveBeenLastCalledWith('en');
    await vi.advanceTimersByTimeAsync(59_550);
    const matchBridge = provider.bridges[0];
    matchBridge.onUserSpeech({ startMs: 0, endMs: 100 });
    matchBridge.onUserSpeechEnd({ startMs: 0, endMs: 100 });
    await vi.advanceTimersByTimeAsync(350);
    expect(provider.bridgeLanguages.at(-1)).toBe('en');
    expect(provider.openingContexts.at(-1)).toContain('English');
    await session.shutdown('test_finished');
  });

  it('uses settled English for coordinator-confirmed loans and extensions', async () => {
    agreement.resolve
      .mockResolvedValueOnce({ state: 'none', id: 'english-fixed-lines:turn:1' })
      .mockResolvedValueOnce({ state: 'accepted', id: 'english-fixed-lines:turn:2', agreements: [{ action: 'rival_to_player', offerId: null }] })
      .mockResolvedValueOnce({ state: 'accepted', id: 'english-fixed-lines:turn:3', agreements: [{ action: 'time_extension', offerId: null }] });
    const { session, messages } = setup('english-fixed-lines', 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');

    completeAgreementTurn('english', 'Hello!', 0, 100);
    await settleAgreement();
    expect(provider.language).toHaveBeenLastCalledWith('en');

    const state = (session as unknown as { state: MatchState }).state;
    state.scores.player = 0;
    state.scores.rival = 10;
    completeAgreementTurn('loan', 'synthetic English loan request', 200, 300);
    await settleAgreement();
    expect(messages.find(message => message.type === 'loan_transfer')).toMatchObject({ line: 'All right, I will lend you $5. Do not waste it.' });

    completeAgreementTurn('extension', 'synthetic English extension request', 400, 500);
    await settleAgreement();
    expect(messages.find(message => message.type === 'time_extension')).toMatchObject({ line: 'All right, agreed: ten more seconds.' });
    expect(provider.confirmedLine).toHaveBeenCalledWith('All right, I will lend you $5. Do not waste it.', expect.any(String));
    expect(provider.confirmedLine).toHaveBeenCalledWith('All right, agreed: ten more seconds.', expect.any(String));
    await session.shutdown('test_finished');
  });

  it.each([
    ['Can you lend me money?', 'en', 'All right, I will lend you $5. Do not waste it.'],
    ['Can you lend me money? 日本語', 'ja', 'しょうがないな、$5だけ貸すよ。無駄にしないで。'],
  ] as const)('keeps an initial %s coordinator-confirmed loan aligned with its settled language', async (transcript, language, line) => {
    agreement.resolve.mockResolvedValueOnce({ state: 'accepted', id: `initial-language-loan:${language}:turn:1`, agreements: [{ action: 'rival_to_player', offerId: null }] });
    const { session, messages } = setup(`initial-language-loan-${language}`, 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    const state = (session as unknown as { state: MatchState }).state;
    state.scores.player = 0;
    state.scores.rival = 10;

    completeAgreementTurn('loan', transcript, 0, 300);
    await settleAgreement();

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
    expect(statuses).toContainEqual({ type: 'provider_status', provider: 'gptLive', state: 'connected' });
    expect(statuses).not.toContainEqual({ type: 'provider_status', provider: 'gptLive', state: 'failed' });
    expect(provider.stop).not.toHaveBeenCalled();
    const route = messages.find((message): message is Extract<ServerMessage, { type: 'voice_route' }> => message.type === 'voice_route');
    expect(route).toBeDefined();
    session.handleRaw(JSON.stringify({ type: 'voice_route_ready', transitionId: route!.transitionId }));
    expect(provider.stop).toHaveBeenCalledWith('test-session');
    expect(release).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    session.handleRaw('{"type":"start"}');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(messages.some(message => message.type === 'match_ended')).toBe(true);
  });

  it('falls back from avatar media only after the matching browser PCM ACK, ignores old ACKs, and preserves tagged completion order', async () => {
    const { session, messages } = setup('avatar-route-ack', 'manual', 'avatar');
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    provider.events?.onAudio('AAAA', 'old-normal', 'normal');
    provider.mediaFailures[0]!();
    await vi.advanceTimersByTimeAsync(1);
    expect(provider.interruptPlayback).toHaveBeenCalledOnce();
    const route = messages.find((message): message is Extract<ServerMessage, { type: 'voice_route' }> => message.type === 'voice_route');
    expect(route).toBeDefined();
    expect(provider.stop).not.toHaveBeenCalled();
    session.handleRaw(JSON.stringify({ type: 'voice_route_ready', transitionId: 'stale-route' }));
    provider.events?.onAudio('AAAA');
    provider.events?.onAudio('BBBB', 'new-confirmed');
    provider.events?.onSpeechAudioEnded('new-confirmed');
    expect(messages.some(message => message.type === 'voice_audio')).toBe(false);
    session.handleRaw(JSON.stringify({ type: 'voice_route_ready', transitionId: route!.transitionId }));
    expect(messages.slice(-2)).toEqual([
      expect.objectContaining({ type: 'voice_audio', audio: 'BBBB', speechId: 'new-confirmed' }),
      expect.objectContaining({ type: 'voice_speech_end', speechId: 'new-confirmed' }),
    ]);
    expect(provider.stop).toHaveBeenCalledWith('test-session');
    session.handleRaw(JSON.stringify({ type: 'voice_speech_done', speechId: 'new-confirmed' }));
    await session.shutdown('test_finished');
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
    expect(statuses).toContainEqual({ type: 'provider_status', provider: 'gptLive', state: 'connected' });
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
    expect(messages.filter(m => m.type === 'voice_status' && m.status === 'error')).toHaveLength(failure === 'clear' ? 0 : 1);
    expect(provider.gptConnect).toHaveBeenCalledTimes(failure === 'connect' ? 2 : 1);
    if (failure === 'clear') {
      expect(provider.stop).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2_000);
    }
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

  it('reserves an audio play window after a late start and a coordinator-confirmed extension', async () => {
    agreement.resolve.mockResolvedValueOnce({ state: 'accepted', id: 'late-audio-extension:turn:1', agreements: [{ action: 'time_extension', offerId: null }] });
    const { session, messages, release } = setup('late-audio-extension', 'manual', 'audio');
    await session.initialize();
    await vi.advanceTimersByTimeAsync(74_000);
    session.handleRaw('{"type":"start"}');

    await vi.advanceTimersByTimeAsync(46_000);
    expect(provider.gptClose).not.toHaveBeenCalled();
    provider.events?.onAudio('after-old-deadline');
    expect(messages).toContainEqual(expect.objectContaining({ type: 'voice_audio', audio: 'after-old-deadline' }));

    completeAgreementTurn('extension', 'synthetic late extension request', 0, 300);
    await settleAgreement();
    expect(messages.find(message => message.type === 'time_extension')).toMatchObject({ decision: 'accepted', after: { duration: 70 } });
    await vi.advanceTimersByTimeAsync(25_000);
    expect(messages.find(message => message.type === 'match_ended')).toMatchObject({ snapshot: { elapsed: 70, duration: 70, remaining: 0 } });
    await vi.advanceTimersByTimeAsync(8_000);
    expect(release).toHaveBeenCalledOnce();
    await session.shutdown('test_finished');
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
    expect(logs.mock.calls.map(([line]) => JSON.parse(line)).filter(value => value.event === 'voice_session_usage')).toEqual([
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
    expect(provider.context).toHaveBeenLastCalledWith(expect.stringContaining('時間延長: プレイヤーまたはライバルからの明確な新規要求・提案への合意ごとに、残り時間へ必ず+10秒を確定する。'));
    expect(provider.context).toHaveBeenLastCalledWith(expect.stringContaining('貸借: プレイヤーがAIに要求してAIが合意すれば、またAIがプレイヤーに要求してプレイヤーが合意すれば、残高に関係なく必ず$5を移動する。'));
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

  it('applies each confirmed $5 transfer direction from completed user turns', async () => {
    agreement.resolve
      .mockResolvedValueOnce({ state: 'accepted', id: 'loan-directions:turn:1', agreements: [{ action: 'rival_to_player', offerId: null }] })
      .mockResolvedValueOnce({ state: 'accepted', id: 'loan-directions:turn:2', agreements: [{ action: 'player_to_rival', offerId: null }] });
    const { session, messages } = setup('loan-directions', 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');

    completeAgreementTurn('turn-1', 'synthetic player loan request', 0, 100);
    await settleAgreement();
    completeAgreementTurn('turn-2', 'synthetic rival loan acceptance', 200, 300);
    await settleAgreement();

    const transfers = messages.filter((message): message is Extract<ServerMessage, { type: 'loan_transfer' }> => message.type === 'loan_transfer');
    expect(transfers).toHaveLength(2);
    expect(transfers.map(transfer => transfer.direction)).toEqual(['rival_to_player', 'player_to_rival']);
    expect(transfers.map(transfer => transfer.amount)).toEqual([5, 5]);
    await session.shutdown('test_finished');
  });

  it('applies a player- or AI-initiated confirmed +10 second proposal', async () => {
    agreement.resolve
      .mockResolvedValueOnce({ state: 'accepted', id: 'time-player:turn:1', agreements: [{ action: 'time_extension', offerId: null }] })
      .mockResolvedValueOnce({ state: 'accepted', id: 'time-ai:turn:2', agreements: [{ action: 'time_extension', offerId: 'ai-offer-1' }] });
    const { session, messages } = setup('time-proposals', 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');

    completeAgreementTurn('player-request', 'synthetic player proposes more time', 0, 100);
    await settleAgreement();
    completeAgreementTurn('ai-offer-accept', 'synthetic player accepts offer', 200, 300);
    await settleAgreement();

    const extensions = messages.filter((message): message is Extract<ServerMessage, { type: 'time_extension' }> => message.type === 'time_extension');
    expect(extensions).toHaveLength(2);
    expect(extensions.map(extension => extension.after.duration)).toEqual([70, 80]);
    await session.shutdown('test_finished');
  });

  it('applies distinct direct requests but deduplicates two acknowledgements of one offer ID', async () => {
    agreement.resolve
      .mockResolvedValueOnce({ state: 'accepted', id: 'dedupe:turn:1', agreements: [{ action: 'rival_to_player', offerId: null }] })
      .mockResolvedValueOnce({ state: 'accepted', id: 'dedupe:turn:2', agreements: [{ action: 'player_to_rival', offerId: 'loan-offer-7' }] })
      .mockResolvedValueOnce({ state: 'accepted', id: 'dedupe:turn:3', agreements: [{ action: 'player_to_rival', offerId: 'loan-offer-7' }] });
    const { session, messages } = setup('dedupe-offers', 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');

    completeAgreementTurn('direct-one', 'synthetic distinct request', 0, 100);
    await settleAgreement();
    completeAgreementTurn('offer-ack-one', 'synthetic yes', 200, 300);
    await settleAgreement();
    completeAgreementTurn('offer-ack-two', 'synthetic repeated yes', 400, 500);
    await settleAgreement();

    expect(messages.filter(message => message.type === 'loan_transfer')).toHaveLength(2);
    expect(agreement.applyOnce).toHaveBeenCalledTimes(3);
    await session.shutdown('test_finished');
  });

  it('applies one $5 transfer when an untrusted classifier repeats one action as direct and offered', async () => {
    agreement.resolve.mockResolvedValueOnce({
      state: 'accepted', id: 'duplicate-action:turn:1', agreements: [
        { action: 'rival_to_player', offerId: null },
        { action: 'rival_to_player', offerId: 'same-rival-offer' },
      ],
    });
    const { session, messages } = setup('duplicate-action', 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');

    completeAgreementTurn('duplicate-action', 'synthetic agreement', 0, 100);
    await settleAgreement();

    const transfers = messages.filter((message): message is Extract<ServerMessage, { type: 'loan_transfer' }> => message.type === 'loan_transfer');
    expect(transfers).toHaveLength(1);
    expect(transfers[0]).toMatchObject({ direction: 'rival_to_player', amount: 5 });
    await session.shutdown('test_finished');
  });

  it('commits a compound transfer and extension before their confirmed audio and reflects both in snapshots', async () => {
    agreement.resolve.mockResolvedValueOnce({
      state: 'accepted',
      id: 'compound:turn:1',
      agreements: [
        { action: 'rival_to_player', offerId: null },
        { action: 'time_extension', offerId: null },
      ],
    });
    const { session, messages } = setup('compound-agreement', 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');

    completeAgreementTurn('compound', 'synthetic request and extension acceptance', 0, 100);
    await settleAgreement();

    const loanIndex = messages.findIndex(message => message.type === 'loan_transfer');
    const extensionIndex = messages.findIndex(message => message.type === 'time_extension');
    const snapshot = messages.filter((message): message is Extract<ServerMessage, { type: 'snapshot' }> => message.type === 'snapshot').at(-1);
    expect(loanIndex).toBeGreaterThanOrEqual(0);
    expect(extensionIndex).toBeGreaterThan(loanIndex);
    expect(provider.confirmedLine).toHaveBeenCalledTimes(2);
    expect(snapshot).toMatchObject({ snapshot: { duration: 70, scores: { player: 35, rival: 25 } } });
    await session.shutdown('test_finished');
  });

  it('keeps a pre-deadline completed turn held until its bounded agreement result settles', async () => {
    const pending = deferred<{ state: 'none'; id: string }>();
    agreement.resolve.mockReturnValueOnce(pending.promise);
    const { session, messages } = setup('deadline-hold', 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    await vi.advanceTimersByTimeAsync(59_900);

    completeAgreementTurn('deadline-turn', 'synthetic ordinary chat', 59_900, 59_990);
    await vi.advanceTimersByTimeAsync(500);
    expect(agreement.resolve).toHaveBeenCalledOnce();
    expect(messages.some(message => message.type === 'match_ended')).toBe(false);

    pending.resolve({ state: 'none', id: 'deadline-hold:turn:1' });
    await pending.promise;
    await vi.advanceTimersByTimeAsync(1_350);
    expect(messages.find(message => message.type === 'match_ended')).toMatchObject({ snapshot: { status: 'result' } });
    await session.shutdown('test_finished');
  });

  it('attributes a delayed old subtitle to its closed VAD interval instead of the newer turn', async () => {
    agreement.resolve.mockImplementation(async (turn: { id: string; transcript: string }) => ({ state: 'none', id: turn.id }));
    const { session } = setup('late-subtitle', 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    const bridge = agreementBridge();

    bridge.onUserSpeech({ startMs: 0, endMs: 500 });
    bridge.onUserSpeechEnd({ startMs: 0, endMs: 500 });
    bridge.onUserSpeech({ startMs: 600, endMs: 1000 });
    bridge.onTranscript('user', 'synthetic first turn', { startMs: 100, endMs: 450 });
    bridge.onTranscript('user', 'synthetic second turn', { startMs: 700, endMs: 900 });
    bridge.onUserSpeechEnd({ startMs: 600, endMs: 1000 });
    await vi.advanceTimersByTimeAsync(350);
    await vi.waitFor(() => expect(agreement.resolve).toHaveBeenCalledTimes(2));

    expect(agreement.resolve.mock.calls.map(([turn]) => turn)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'late-subtitle:turn:1', transcript: 'synthetic first turn' }),
      expect.objectContaining({ id: 'late-subtitle:turn:2', transcript: 'synthetic second turn' }),
    ]));
    await session.shutdown('test_finished');
  });

  it('does not attach a timingless user subtitle to the newer VAD turn', async () => {
    agreement.resolve.mockImplementation(async (turn: { id: string }) => ({ state: 'none', id: turn.id }));
    const { session } = setup('timingless-subtitle', 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    const bridge = agreementBridge();

    bridge.onUserSpeech({ startMs: 0, endMs: 500 });
    bridge.onUserSpeechEnd({ startMs: 0, endMs: 500 });
    bridge.onUserSpeech({ startMs: 600, endMs: 1000 });
    bridge.onTranscript('user', 'synthetic timingless subtitle');
    bridge.onUserSpeechEnd({ startMs: 600, endMs: 1000 });
    await vi.advanceTimersByTimeAsync(350);

    expect(agreement.resolve).not.toHaveBeenCalled();
    await session.shutdown('test_finished');
  });
  it('does not let a newer VAD turn discard an already pending older agreement', async () => {
    const first = deferred<{ state: 'none'; id: string }>();
    agreement.resolve
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ state: 'none', id: 'pending-old:turn:2' });
    const { session } = setup('pending-old', 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');

    completeAgreementTurn('first', 'synthetic first turn', 0, 100);
    await vi.advanceTimersByTimeAsync(350);
    await vi.waitFor(() => expect(agreement.resolve).toHaveBeenCalledOnce());
    completeAgreementTurn('second', 'synthetic second turn', 200, 300);
    await vi.advanceTimersByTimeAsync(350);
    await vi.waitFor(() => expect(agreement.resolve).toHaveBeenCalledTimes(2));
    first.resolve({ state: 'none', id: 'pending-old:turn:1' });
    await first.promise;
    await vi.advanceTimersByTimeAsync(1_250);
    expect(provider.finishUserTurnGate).toHaveBeenCalled();
    await session.shutdown('test_finished');
  });

  it('audits a newer normal reply against its own turn when an older response finishes last', async () => {
    const older = deferred<{ state: 'accepted'; id: string; agreements: Array<{ action: 'rival_to_player'; offerId: null }> }>();
    agreement.resolve
      .mockReturnValueOnce(older.promise)
      .mockResolvedValueOnce({ state: 'none', id: 'reverse-cause:turn:2' });
    agreement.auditAssistantSpeech.mockResolvedValueOnce({
      state: 'commit', agreements: [{ action: 'player_to_rival', offerId: 'turn-two-offer' }],
    });
    const { session, messages } = setup('reverse-cause', 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');

    completeAgreementTurn('older', 'synthetic older request', 0, 100);
    await vi.advanceTimersByTimeAsync(350);
    await vi.waitFor(() => expect(agreement.resolve).toHaveBeenCalledTimes(1));
    completeAgreementTurn('newer', 'synthetic newer request', 200, 300);
    await vi.advanceTimersByTimeAsync(700);
    await vi.waitFor(() => expect((session as unknown as { finishedAgreementTurns: Map<number, unknown> }).finishedAgreementTurns.has(2)).toBe(true));
    const contexts = session as unknown as { finishedAgreementTurns: Map<number, { activeOffers: Record<string, string | null> }> };
    contexts.finishedAgreementTurns.get(2)!.activeOffers = { rival_to_player: null, player_to_rival: 'turn-two-offer', time_extension: null };

    older.resolve({ state: 'accepted', id: 'reverse-cause:turn:1', agreements: [{ action: 'rival_to_player', offerId: null }] });
    await vi.waitFor(() => expect(messages.filter(message => message.type === 'loan_transfer')).toHaveLength(1));
    await expect(agreementBridge().onNormalSpeechCandidate!({
      speechId: 'newer-normal', transcript: 'synthetic newer AI reply', signal: new AbortController().signal,
    })).resolves.toBe(false);

    expect(agreement.auditAssistantSpeech.mock.calls.at(-1)?.[3]).toEqual({ rival_to_player: null, player_to_rival: 'turn-two-offer', time_extension: null });
    expect(messages.filter((message): message is Extract<ServerMessage, { type: 'loan_transfer' }> => message.type === 'loan_transfer').map(message => message.direction))
      .toEqual(['rival_to_player', 'player_to_rival']);
    await session.shutdown('test_finished');
  });

  it('keeps a fail-closed discard intent while another pending turn later settles none', async () => {
    agreement.resolve
      .mockResolvedValueOnce({ state: 'unavailable', id: 'gate-drop:turn:1' })
      .mockResolvedValueOnce({ state: 'none', id: 'gate-drop:turn:2' });
    const { session } = setup('gate-drop', 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');

    completeAgreementTurn('unavailable', 'synthetic uncertain first turn', 0, 100);
    await vi.advanceTimersByTimeAsync(350);
    completeAgreementTurn('none', 'synthetic ordinary second turn', 200, 300);
    await vi.advanceTimersByTimeAsync(350);
    expect(provider.finishUserTurnGate).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(350);
    expect(provider.finishUserTurnGate).toHaveBeenCalledTimes(1);
    expect(provider.finishUserTurnGate).toHaveBeenLastCalledWith(true);
    await session.shutdown('test_finished');
  });

  it('commits the fixed $5 transfer even when the lender crosses below zero', async () => {
    agreement.resolve
      .mockResolvedValueOnce({ state: 'accepted', id: 'loan-limit:turn:1', agreements: [{ action: 'rival_to_player', offerId: null }] })
      .mockResolvedValueOnce({ state: 'accepted', id: 'loan-limit:turn:2', agreements: [{ action: 'player_to_rival', offerId: null }] });
    const { session, messages } = setup('loan-limit', 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    const state = (session as unknown as { state: MatchState }).state;
    state.scores.player = 0;
    state.scores.rival = 4;

    completeAgreementTurn('underfunded-rival', 'synthetic request', 0, 100);
    await settleAgreement();
    state.scores.player = 4;
    state.scores.rival = 0;
    completeAgreementTurn('underfunded-player', 'synthetic acceptance', 200, 300);
    await settleAgreement();

    const transfers = messages.filter((message): message is Extract<ServerMessage, { type: 'loan_transfer' }> => message.type === 'loan_transfer');
    expect(transfers).toHaveLength(2);
    expect(transfers.map(transfer => transfer.after.scores)).toEqual([
      { player: 5, rival: -1 },
      { player: -1, rival: 5 },
    ]);
    expect(provider.confirmedLine).toHaveBeenCalledTimes(2);
    await session.shutdown('test_finished');
  });
  it('fails closed when agreement resolution is unavailable', async () => {
    agreement.resolve.mockResolvedValueOnce({ state: 'unavailable', id: 'fail-closed:turn:1' });
    const { session, messages } = setup('fail-closed', 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');

    completeAgreementTurn('unavailable', 'synthetic ambiguous request', 0, 100);
    await settleAgreement();
    await vi.advanceTimersByTimeAsync(1_250);

    expect(messages.some(message => message.type === 'loan_transfer' || message.type === 'time_extension')).toBe(false);
    expect(provider.finishUserTurnGate).toHaveBeenLastCalledWith(true);
    await session.shutdown('test_finished');
  });

  it('audits normal assistant speech: safe releases only, while commit, offer, and unavailable replace it', async () => {
    const { session } = setup('normal-audit', 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    const bridge = agreementBridge();
    const signal = new AbortController().signal;

    agreement.auditAssistantSpeech.mockResolvedValueOnce({ state: 'safe' });
    await expect(bridge.onNormalSpeechCandidate!({ speechId: 'safe', transcript: 'synthetic ordinary reply', signal })).resolves.toBe(true);
    agreement.auditAssistantSpeech.mockResolvedValueOnce({ state: 'commit', agreements: [{ action: 'rival_to_player', offerId: 'offer-commit' }] });
    await expect(bridge.onNormalSpeechCandidate!({ speechId: 'commit', transcript: 'synthetic acceptance', signal })).resolves.toBe(false);
    agreement.auditAssistantSpeech.mockResolvedValueOnce({ state: 'offer', actions: ['time_extension'] });
    await expect(bridge.onNormalSpeechCandidate!({ speechId: 'offer', transcript: 'synthetic proposal', signal })).resolves.toBe(false);
    agreement.auditAssistantSpeech.mockResolvedValueOnce({ state: 'unavailable' });
    await expect(bridge.onNormalSpeechCandidate!({ speechId: 'unavailable', transcript: 'synthetic unclear promise', signal })).resolves.toBe(false);

    expect(agreement.auditAssistantSpeech).toHaveBeenCalledTimes(4);
    await session.shutdown('test_finished');
  });

  it('permits audited-safe normal speech in both the lobby and result, but never an unreviewed candidate', async () => {
    agreement.auditAssistantSpeech.mockResolvedValue({ state: 'safe' });
    const { session } = setup('safe-lobby-result', 'manual', 'audio');
    await session.initialize();

    await expect(agreementBridge().onNormalSpeechCandidate!({ speechId: 'lobby-safe', transcript: 'synthetic lobby chat', signal: new AbortController().signal })).resolves.toBe(true);
    session.handleRaw('{"type":"start"}');
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(agreementBridge().onNormalSpeechCandidate!({ speechId: 'result-safe', transcript: 'synthetic result chat', signal: new AbortController().signal })).resolves.toBe(true);
    expect(agreement.auditAssistantSpeech).toHaveBeenCalledTimes(2);
    await session.shutdown('test_finished');
  });

  it('plays a safe result reply after a final play-turn context belongs to the old bridge generation', async () => {
    agreement.resolve.mockResolvedValueOnce({ state: 'none', id: 'result-old-context:turn:1' });
    const { session, messages } = setup('result-old-context', 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');

    await vi.advanceTimersByTimeAsync(55_000);
    completeAgreementTurn('final-player-turn', 'synthetic ordinary player turn', 0, 100);
    await settleAgreement();
    await vi.advanceTimersByTimeAsync(350);
    await vi.advanceTimersByTimeAsync(4_300);
    await vi.waitFor(() => expect(provider.bridges).toHaveLength(2));
    const internals = session as unknown as {
      voiceGeneration: number;
      finishedAgreementTurns: Map<number, { generation: number }>;
    };
    const finalPlayContext = internals.finishedAgreementTurns.get(1);
    expect(finalPlayContext).toBeDefined();
    expect(finalPlayContext?.generation).not.toBe(internals.voiceGeneration);
    const resultBridge = provider.bridges.at(-1)! as AgreementEventBridge;

    await expect(resultBridge.onNormalSpeechCandidate!({
      speechId: 'result-safe-after-player', transcript: 'synthetic final reaction', signal: new AbortController().signal,
    })).resolves.toBe(true);
    agreement.auditAssistantSpeech.mockResolvedValueOnce({
      state: 'commit', agreements: [{ action: 'rival_to_player', offerId: null }],
    });
    await expect(resultBridge.onNormalSpeechCandidate!({
      speechId: 'result-stale-commit', transcript: 'synthetic stale promise', signal: new AbortController().signal,
    })).resolves.toBe(false);
    expect(messages.some(message => message.type === 'loan_transfer' || message.type === 'time_extension')).toBe(false);
    await session.shutdown('test_finished');
  });

  it('plays a safe ordinary reply after context expiry but rejects uncaused commits and offers', async () => {
    agreement.resolve.mockResolvedValueOnce({ state: 'none', id: 'expired-context:turn:1' });
    const { session, messages } = setup('expired-context', 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');

    completeAgreementTurn('ordinary-player-turn', 'synthetic ordinary player turn', 0, 100);
    await settleAgreement();
    await vi.advanceTimersByTimeAsync(350);
    await vi.advanceTimersByTimeAsync(12_001);
    const bridge = agreementBridge();

    await expect(bridge.onNormalSpeechCandidate!({
      speechId: 'expired-safe', transcript: 'synthetic ordinary answer', signal: new AbortController().signal,
    })).resolves.toBe(true);
    agreement.auditAssistantSpeech.mockResolvedValueOnce({
      state: 'commit', agreements: [{ action: 'rival_to_player', offerId: null }],
    });
    await expect(bridge.onNormalSpeechCandidate!({
      speechId: 'expired-commit', transcript: 'synthetic stale commitment', signal: new AbortController().signal,
    })).resolves.toBe(false);
    const confirmedBefore = provider.confirmedLine.mock.calls.length;
    agreement.auditAssistantSpeech.mockResolvedValueOnce({ state: 'offer', actions: ['time_extension'] });
    await expect(bridge.onNormalSpeechCandidate!({
      speechId: 'expired-offer', transcript: 'synthetic stale proposal', signal: new AbortController().signal,
    })).resolves.toBe(false);

    expect(messages.some(message => message.type === 'loan_transfer' || message.type === 'time_extension')).toBe(false);
    expect(provider.confirmedLine).toHaveBeenCalledTimes(confirmedBefore);
    await session.shutdown('test_finished');
  });

  it('replaces an audited free proposal with a server-confirmed offer line, never the model transcript', async () => {
    agreement.resolve.mockResolvedValueOnce({ state: 'none', id: 'audited-offer-line:turn:1' });
    agreement.auditAssistantSpeech.mockResolvedValueOnce({ state: 'offer', actions: ['time_extension'] });
    const { session } = setup('audited-offer-line', 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    completeAgreementTurn('ordinary-player-turn', 'synthetic player none', 0, 100);
    await settleAgreement();
    await vi.advanceTimersByTimeAsync(1_250);
    expect(provider.finishUserTurnGate).toHaveBeenLastCalledWith(false);

    await expect(agreementBridge().onNormalSpeechCandidate!({
      speechId: 'free-proposal',
      transcript: 'synthetic free AI proposal with unconfirmed terms',
      signal: new AbortController().signal,
    })).resolves.toBe(false);

    const [line, speechId] = provider.confirmedLine.mock.calls.at(-1) ?? [];
    expect(line).toEqual(expect.any(String));
    expect(line).not.toContain('synthetic free AI proposal');
    expect(speechId).toEqual(expect.any(String));
    await session.shutdown('test_finished');
  });

  it('commits a normal acceptance only after the preceding player none releases its gate, then deduplicates the frozen offer', async () => {
    agreement.resolve.mockResolvedValueOnce({ state: 'none', id: 'normal-commit-dedupe:turn:1' });
    agreement.auditAssistantSpeech.mockResolvedValue({
      state: 'commit',
      agreements: [{ action: 'rival_to_player', offerId: 'frozen-offer-1' }],
    });
    const { session, messages } = setup('normal-commit-dedupe', 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');

    completeAgreementTurn('ordinary-player-turn', 'synthetic player none', 0, 100);
    await settleAgreement();
    await vi.advanceTimersByTimeAsync(1_250);
    expect(provider.finishUserTurnGate).toHaveBeenLastCalledWith(false);

    const signal = new AbortController().signal;
    await expect(agreementBridge().onNormalSpeechCandidate!({ speechId: 'normal-one', transcript: 'synthetic acceptance', signal })).resolves.toBe(false);
    await expect(agreementBridge().onNormalSpeechCandidate!({ speechId: 'normal-two', transcript: 'synthetic repeated acceptance', signal })).resolves.toBe(false);

    expect(messages.filter(message => message.type === 'loan_transfer')).toHaveLength(1);
    expect(provider.confirmedLine).toHaveBeenCalledTimes(1);
    await session.shutdown('test_finished');
  });
  it('cancels an aborted normal-speech audit without applying its late commit', async () => {
    const pending = deferred<{ state: 'commit'; agreements: Array<{ action: 'rival_to_player'; offerId: string }> }>();
    agreement.auditAssistantSpeech.mockReturnValueOnce(pending.promise);
    const { session, messages } = setup('aborted-normal-audit', 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    const controller = new AbortController();

    const candidate = agreementBridge().onNormalSpeechCandidate!({
      speechId: 'aborted-normal',
      transcript: 'synthetic late acceptance',
      signal: controller.signal,
    });
    controller.abort();
    pending.resolve({ state: 'commit', agreements: [{ action: 'rival_to_player', offerId: 'frozen-offer-2' }] });

    await expect(candidate).resolves.toBe(false);
    expect(messages.some(message => message.type === 'loan_transfer' || message.type === 'time_extension')).toBe(false);
    expect(provider.confirmedLine).not.toHaveBeenCalled();
    await session.shutdown('test_finished');
  });

  it('does not apply a resolved deadline-held agreement after the session closes', async () => {
    const pending = deferred<{ state: 'accepted'; id: string; agreements: Array<{ action: 'time_extension'; offerId: null }> }>();
    agreement.resolve.mockReturnValueOnce(pending.promise);
    const { session, messages } = setup('closed-deadline-hold', 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');
    await vi.advanceTimersByTimeAsync(59_900);

    completeAgreementTurn('deadline-close', 'synthetic request', 59_900, 59_990);
    await vi.advanceTimersByTimeAsync(350);
    await vi.waitFor(() => expect(agreement.resolve).toHaveBeenCalledOnce());
    await session.shutdown('test_finished');
    pending.resolve({ state: 'accepted', id: 'closed-deadline-hold:turn:1', agreements: [{ action: 'time_extension', offerId: null }] });
    await pending.promise;
    await vi.advanceTimersByTimeAsync(1);

    expect(messages.some(message => message.type === 'time_extension')).toBe(false);
  });
  it('does not convert a player none result into an assistant acceptance, but permits a short acknowledgement of a server offer', async () => {
    agreement.resolve
      .mockResolvedValueOnce({ state: 'none', id: 'assistant-regression:turn:1' })
      .mockResolvedValueOnce({ state: 'accepted', id: 'assistant-regression:turn:2', agreements: [{ action: 'time_extension', offerId: 'server-offer-9' }] });
    agreement.auditAssistantSpeech.mockResolvedValueOnce({ state: 'offer', actions: ['time_extension'] });
    const { session, messages } = setup('assistant-regression', 'manual', 'audio');
    await session.initialize();
    session.handleRaw('{"type":"start"}');

    completeAgreementTurn('ordinary', 'synthetic player none', 0, 100);
    await settleAgreement();
    await expect(agreementBridge().onNormalSpeechCandidate!({ speechId: 'proposal', transcript: 'synthetic free AI proposal', signal: new AbortController().signal })).resolves.toBe(false);
    expect(messages.some(message => message.type === 'time_extension')).toBe(false);

    completeAgreementTurn('short-yes', 'yes', 200, 250);
    await settleAgreement();
    expect(messages.find(message => message.type === 'time_extension')).toMatchObject({ after: { duration: 70 } });
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
  const beforeSpeech = messages.length;
  expect(messages).toHaveLength(beforeSpeech);
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
