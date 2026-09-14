import { describe, expect, it, vi } from 'vitest';
import type { ClientMessage, MatchSnapshot, ServerMessage, SpinView } from '../../shared/protocol';
import type { LiveSession, LiveSessionFactory, LiveSessionHandlers } from '../client/LiveSession';
import { createMatch, getSnapshot } from '../domain/game';
import { GameViewModel } from './GameViewModel';
import type { GameClock, GamePresentation, RoundPair } from './GameViewState';

class Clock implements GameClock {
  time = 0;
  nextId = 0;
  timers = new Map<number, { at: number; callback: () => void }>();
  now = () => this.time;
  setTimeout = (callback: () => void, delay: number) => {
    const id = ++this.nextId;
    this.timers.set(id, { at: this.time + delay, callback });
    return id;
  };
  clearTimeout = (id: number) => { this.timers.delete(id); };
  async advance(ms: number): Promise<void> {
    const target = this.time + ms;
    for (;;) {
      await Promise.resolve();
      const next = [...this.timers].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next || next[1].at > target) break;
      this.time = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
    }
    this.time = target;
    await Promise.resolve();
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class Session implements LiveSession {
  messages: ClientMessage[] = [];
  spins = 0;
  bets = 0;
  disconnect = vi.fn(async () => undefined);
  setMuted = vi.fn();
  setMicMuted = vi.fn();
  constructor(readonly handlers: LiveSessionHandlers) {}
  connect = vi.fn(async () => {
    this.handlers.message({ type: 'voice_status', status: 'ready' });
    this.handlers.message({ type: 'snapshot', snapshot: readySnapshot() });
  });
  send(message: ClientMessage): void { this.messages.push(message); }
  sendSpin(): string { return `spin-${++this.spins}`; }
  setBet(): string { return `bet-${++this.bets}`; }
  emit(message: ServerMessage): void { this.handlers.message(message); }
}

function readySnapshot(): MatchSnapshot { return getSnapshot(createMatch(123, 'live-match', 'manual')); }
function pair(round = 1): RoundPair {
  return {
    player: { round, side: 'player', symbols: ['seven', 'seven', 'seven'], payout: 1200, total: round * 1200, upgrades: [] },
    rival: { round, side: 'rival', symbols: ['cherry', 'cherry', 'cherry'], payout: 120, total: round * 120, upgrades: [] },
  };
}
function playingSnapshot(last?: RoundPair, result = false): MatchSnapshot {
  const snapshot = readySnapshot();
  snapshot.status = result ? 'result' : 'playing';
  snapshot.elapsed = result ? 60 : last ? 5 : 0;
  snapshot.remaining = 60 - snapshot.elapsed;
  if (last) {
    snapshot.round = last.player.round;
    snapshot.rounds = { player: last.player.round, rival: last.rival.round };
    snapshot.scores = { player: last.player.total, rival: last.rival.total };
    snapshot.stats = {
      player: { wins: { cherry: 0, bell: 0, seven: snapshot.round }, bestSpin: { round: 1, payout: 1200 } },
      rival: { wins: { cherry: snapshot.round, bell: 0, seven: 0 }, bestSpin: { round: 1, payout: 120 } },
    };
  }
  if (result) snapshot.winner = last ? 'player' : 'draw';
  return snapshot;
}

function setup(factory?: LiveSessionFactory) {
  const clock = new Clock();
  const sessions: Session[] = [];
  const rounds: Array<{ spin: SpinView; stopped: (celebrate?: boolean) => void }> = [];
  const rivalRounds: typeof rounds = [];
  const presentation: GamePresentation = {
    playSpin: vi.fn((spin: SpinView, stopped: (celebrate?: boolean) => void) => { (spin.side === 'player' ? rounds : rivalRounds).push({ spin, stopped }); }),
    resetScene: vi.fn(), stopScene: vi.fn(), celebrateResult: vi.fn((_winner, ready) => ready?.()), playSound: vi.fn(), stopSound: vi.fn(), setEffectsMuted: vi.fn(), focus: vi.fn(),
  };
  let visible = true;
  const vm = new GameViewModel({
    clock, random: () => 0.25, isVisible: () => visible, presentation,
    liveFactory: factory ?? (async handlers => { const session = new Session(handlers); sessions.push(session); return session; }),
  });
  return { vm, clock, rounds, rivalRounds, sessions, presentation, setVisible: (value: boolean) => { visible = value; vm.visibilityChanged(); } };
}

async function beginCpu(h: ReturnType<typeof setup>) {
  const start = h.vm.startCpu();
  await h.clock.advance(1650);
  await start;
}

function spendCpuBankroll(h: ReturnType<typeof setup>): void {
  h.vm.setBet(5);
  h.vm.requestSpin();
  expect(h.rounds.at(-1)?.spin).toMatchObject({ bet: 5, payout: 0, total: 25 });
  h.vm.purchaseUpgrade('steady');
  h.vm.purchaseUpgrade('steady');
}

it('purchases during CPU play, retains spending after stopping, and resets on rematch', async () => {
  const h = setup();
  await beginCpu(h);
  h.vm.requestSpin();
  const started = structuredClone(h.rounds[0].spin);
  h.vm.purchaseUpgrade('steady');
  expect(h.vm.state.scores.player).toBe(19);
  expect(h.vm.state.snapshot.upgrades.player).toEqual(['steady']);
  expect(h.rounds[0].spin).toEqual(started);
  h.rounds[0].stopped();
  expect(h.vm.state.scores.player).toBe(started.total - 10);
  await h.clock.advance(60000);
  const spent = h.vm.state.snapshot.upgradeSpent;
  h.vm.purchaseUpgrade('jackpot');
  expect(h.vm.state.snapshot.upgradeSpent).toBe(spent);
  await beginCpu(h);
  expect(h.vm.state.scores.player).toBe(30);
  expect(h.vm.state.snapshot.upgrades.player).toEqual([]);
  h.vm.dispose();
});

async function beginLive(h: ReturnType<typeof setup>) {
  await h.vm.connectLive('private-invite-value');
  const start = h.vm.start();
  await h.clock.advance(1650);
  await start;
  const session = h.sessions.at(-1)!;
  expect(session.messages.at(-1)).toEqual({ type: 'start' });
  session.emit({ type: 'snapshot', snapshot: playingSnapshot() });
  return session;
}

describe('game view model', () => {
  it('keeps the AI voice gate open with a retryable microphone error when setup disconnects first', async () => {
    let session!: Session;
    const h = setup(async handlers => {
      session = new Session(handlers);
      session.connect = vi.fn(async () => {
        handlers.disconnect();
        throw new Error('permission_denied');
      });
      return session;
    });
    await h.vm.connectLive('private-invite-value');
    expect(h.vm.state).toMatchObject({
      mode: 'idle',
      gate: { visible: true, connecting: false, message: expect.stringContaining('Microphone permission was denied') },
    });
    expect(h.presentation.focus).toHaveBeenLastCalledWith('gate');
    expect(session.disconnect).toHaveBeenCalledOnce();
    h.vm.dispose();
  });

  it('suggests audio-only retry when video setup cannot become ready', async () => {
    const h = setup(async handlers => {
      const session = new Session(handlers);
      session.connect = vi.fn(async () => {
        handlers.disconnect();
        throw new Error('voice_connect_failed');
      });
      return session;
    });
    await h.vm.connectLive('private-invite-value', true);
    expect(h.vm.state.gate).toMatchObject({ visible: true, message: expect.stringContaining('Turn off live video') });
    h.vm.dispose();
  });

  it('hides an ended avatar video while keeping the live voice session and future video choice', async () => {
    const h = setup();
    await h.vm.connectLive('private-invite-value', true);
    const session = h.sessions.at(-1)!;
    expect(h.vm.state.connection).toMatchObject({ voiceReady: true, showVideo: true });
    session.handlers.route?.();
    expect(h.vm.state.connection).toEqual(expect.objectContaining({
      voiceReady: true,
      showVideo: false,
      text: 'Live video ended · Voice continues',
    }));
    h.vm.dispose();
  });

  it('keeps setup errors for the classified retry instead of switching to CPU before rejection', async () => {
    const h = setup(async handlers => {
      const session = new Session(handlers);
      session.connect = vi.fn(async () => {
        handlers.message({ type: 'error', code: 'session_rejected', message: 'internal provider detail', recoverable: false });
        handlers.disconnect();
        throw new Error('session_failed');
      });
      return session;
    });
    await h.vm.connectLive('private-invite-value');
    expect(h.vm.state).toMatchObject({
      mode: 'idle',
      gate: { visible: true, connecting: false, message: 'AI voice did not become ready. Retry AI voice, or play a CPU duel.' },
    });
    h.vm.dispose();
  });

  it('keeps an expired voice lobby visible so the player can reconnect instead of silently falling back to CPU', async () => {
    const h = setup();
    const session = await beginLive(h);
    session.emit({
      type: 'error', code: 'lobby_timeout', recoverable: false,
      message: 'AI voice waited too long. Reconnect AI voice to start a full duel.',
    });
    expect(h.vm.state).toMatchObject({
      mode: 'idle',
      gate: { visible: true, message: expect.stringContaining('Reconnect AI voice') },
    });
    expect(h.presentation.focus).toHaveBeenLastCalledWith('gate');
    h.vm.dispose();
  });

  it('waits for the current BET acknowledgement before spinning and rolls back a rejected BET', async () => {
    const h = setup();
    const session = await beginLive(h);
    h.vm.setBet(5);
    expect(h.vm.state.snapshot.bets.player).toBe(5);
    h.vm.requestSpin();
    expect(session.spins).toBe(0);
    h.vm.setBet(1);
    expect(session.bets).toBe(1);
    session.emit({ type: 'bet_status', commandId: 'old-bet', accepted: true, bet: 1 });
    expect(h.vm.state.snapshot.bets.player).toBe(5);
    session.emit({ type: 'bet_status', commandId: 'bet-1', accepted: false, bet: 3 });
    expect(h.vm.state.snapshot.bets.player).toBe(3);
    h.vm.requestSpin();
    expect(session.spins).toBe(1);
    h.vm.setBet(1);
    session.emit({ type: 'bet_status', commandId: 'bet-2', accepted: true, bet: 1 });
    expect(h.vm.state.snapshot.bets.player).toBe(1);
    h.vm.leave();
    session.emit({ type: 'bet_status', commandId: 'bet-2', accepted: false, bet: 3 });
    expect(h.vm.state.snapshot.bets.player).toBe(1);
  });

  it('keeps debug connection state separate from the CPU duel', () => {
    const h = setup();
    h.vm.setAiDebugConfiguration({ gptLive: true, responses: true, liveAvatar: true, liveKit: true });
    h.vm.setAiDebugResponses('connecting');
    expect(h.vm.state).toMatchObject({ mode: 'idle', aiDebug: { responses: 'connecting', runtime: { gptLive: 'idle', liveAvatar: 'idle', liveKit: 'idle' } } });
    h.vm.setAiDebugRuntime('gptLive', 'connected');
    expect(h.vm.state.aiDebug.runtime.gptLive).toBe('connected');
    h.vm.dispose();
  });

  it('runs the rival while funded and waits for its final stop after the $30 bankroll is exhausted', async () => {
    const h = setup();
    const observed = vi.fn();
    const unsubscribe = h.vm.subscribe(observed);
    expect(observed).toHaveBeenCalledOnce();
    await beginCpu(h);
    expect(h.vm.state.startControl).toMatchObject({ disabled: false, label: 'SPIN' });
    await h.clock.advance(60000);
    expect(h.rounds).toHaveLength(0);
    expect(h.rivalRounds).toHaveLength(17);
    expect(h.vm.state.startControl.label).toBe('LAST SPIN');
    expect(h.vm.state.result).toBeNull();
    const stopsBeforeResult = vi.mocked(h.presentation.stopScene).mock.calls.length;
    h.rivalRounds.at(-1)!.stopped();
    expect(h.vm.state.result).toMatchObject({ rounds: { player: 0, rival: 17 }, scores: { player: 30, rival: h.rivalRounds.at(-1)!.spin.total } });
    expect(h.presentation.celebrateResult).toHaveBeenCalledOnce();
    expect(h.presentation.stopScene).toHaveBeenCalledTimes(stopsBeforeResult);
    unsubscribe();
    h.vm.dispose();
    expect(h.clock.timers.size).toBe(0);
  });

  it('ignores repeated inputs while spinning and ignores an old stop callback after leaving and starting again', async () => {
    const h = setup();
    await beginCpu(h);
    h.vm.requestSpin();
    for (let i = 0; i < 20; i++) h.vm.requestSpin();
    expect(h.rounds).toHaveLength(1);
    expect(h.vm.state.startControl.spinState).toBe('spinning');
    const first = h.rounds[0];
    expect(h.vm.state.scores).toEqual({ player: 29, rival: 30 });
    await h.clock.advance(1060);
    first.stopped();
    expect(h.vm.state.scores).toEqual({ player: first.spin.total, rival: 30 });
    expect(h.vm.state.lastSpin?.player?.round).toBe(first.spin.round);
    await h.clock.advance(1200);
    expect(h.rounds).toHaveLength(1);
    h.vm.requestSpin();
    expect(h.vm.state.lastSpin?.player).toBeUndefined();
    const interrupted = h.rounds[1];
    h.vm.requestSpin();
    h.vm.leave();
    expect(h.clock.timers.size).toBe(0);
    await beginCpu(h);
    const fresh = h.vm.state;
    interrupted.stopped();
    expect(h.vm.state).toEqual(fresh);
    expect(h.vm.state.snapshot.round).toBe(0);
    h.vm.dispose();
  });

  it('keeps the base reels across former upgrade times and cancels a hidden queued spin', async () => {
    const h = setup();
    await beginCpu(h);
    await h.clock.advance(44000);
    expect(h.vm.state.snapshot.upgrades).toEqual({ player: [], rival: [] });
    h.vm.requestSpin();
    expect(h.rounds[0].spin.upgrades).toEqual([]);
    expect(h.rivalRounds.at(-1)!.spin.upgrades).toEqual([]);
    h.vm.requestSpin();
    h.setVisible(false);
    await h.clock.advance(1200);
    h.rounds[0].stopped(false);
    h.setVisible(true);
    await h.clock.advance(2000);
    expect(h.rounds).toHaveLength(1);
    h.vm.dispose();
  });

  it('holds live scores and the final result for the actual stop without replacing the live caption', async () => {
    const h = setup();
    const session = await beginLive(h);
    expect(JSON.stringify(h.vm.state)).not.toContain('private-invite-value');
    const last = pair();
    h.vm.requestSpin();
    session.emit({ type: 'spin', ...last });
    session.emit({ type: 'spin_status', commandId: 'spin-1', accepted: true, retryAfterMs: 1100 });
    session.emit({ type: 'snapshot', snapshot: playingSnapshot(last), lastSpin: last });
    expect(h.rounds).toHaveLength(1);
    expect(h.vm.state.scores).toEqual({ player: 0, rival: 0 });
    session.emit({ type: 'transcript', role: 'assistant', delta: '古い試合中の字幕' });
    const final = playingSnapshot(last, true);
    session.emit({ type: 'snapshot', snapshot: final, lastSpin: last });
    expect(h.vm.state.result).toBeNull();
    expect(h.vm.state.line).toBe('…');
    expect(h.vm.state.startControl.label).toBe('LAST SPIN');
    session.emit({ type: 'transcript', role: 'assistant', delta: 'いい' });
    session.emit({ type: 'match_ended', snapshot: final });
    session.emit({ type: 'snapshot', snapshot: final, lastSpin: last });
    session.emit({ type: 'transcript', role: 'assistant', delta: '勝負だったね。' });
    const stopsBeforeResult = vi.mocked(h.presentation.stopScene).mock.calls.length;
    vi.mocked(h.presentation.celebrateResult).mockImplementationOnce(() => undefined);
    h.rounds[0].stopped();
    expect(h.vm.state.result).toBeNull();
    h.rivalRounds[0].stopped();
    expect(h.vm.state.result).toBeNull();
    expect(h.vm.state.startControl.label).toBe('LAST SPIN');
    expect(h.presentation.playSound).not.toHaveBeenCalledWith('victory');
    // A live message may publish fresh state while the cabinet is still turning.
    session.emit({ type: 'snapshot', snapshot: final, lastSpin: last });
    expect(h.vm.state.result).toBeNull();
    session.emit({ type: 'voice_status', status: 'closed' });
    expect(h.vm.state.line).toBe('いい勝負だったね。');
    const ready = vi.mocked(h.presentation.celebrateResult).mock.calls.at(-1)![1]!;
    ready();
    expect(h.vm.state.scores).toEqual(final.scores);
    expect(h.vm.state.result).toEqual(final);
    expect(h.vm.state.line).toBe('いい勝負だったね。');
    expect(h.presentation.celebrateResult).toHaveBeenCalledOnce();
    expect(h.presentation.stopScene).toHaveBeenCalledTimes(stopsBeforeResult);
    await h.clock.advance(3000);
    expect(h.vm.state.line).toBe('いい勝負だったね。');
    session.emit({ type: 'voice_status', status: 'closed' });
    expect(h.vm.state.line).toBe('いい勝負だったね。');
    const soundsBeforeDisposal = vi.mocked(h.presentation.playSound).mock.calls.length;
    h.vm.dispose();
    ready();
    expect(h.presentation.playSound).toHaveBeenCalledTimes(soundsBeforeDisposal);
    expect(session.disconnect).toHaveBeenCalledOnce();
  });

  it('starts a fresh caption after an interruption and clears conversation feedback on expiry and disconnect', async () => {
    const h = setup();
    const session = await beginLive(h);
    session.emit({ type: 'transcript', role: 'assistant', delta: '私が勝って' });
    expect(h.vm.state.conversation).toBe('replying');
    session.emit({ type: 'voice_interrupt' });
    expect(h.vm.state.line).toBe('Listening…');
    expect(h.vm.state.conversation).toBe('listening');
    session.emit({ type: 'transcript', role: 'user', delta: '今どっちが上？' });
    session.emit({ type: 'transcript', role: 'assistant', delta: '今は' });
    session.emit({ type: 'transcript', role: 'assistant', delta: '同点だね。' });
    expect(h.vm.state.line).toBe('今は同点だね。');
    expect(h.vm.state.heard).toBe('YOU: 今どっちが上？');
    await h.clock.advance(3000);
    expect(h.vm.state.conversation).toBe('idle');
    expect(h.vm.state.line).toBe('今は同点だね。');
    session.emit({ type: 'voice_interrupt' });
    session.emit({ type: 'voice_status', status: 'closed' });
    expect(h.vm.state.conversation).toBe('idle');
    h.vm.dispose();
    expect(h.clock.timers.size).toBe(0);
  });

  it('holds the pre-change timer briefly while applying an authoritative +10 second extension', async () => {
    const h = setup();
    const session = await beginLive(h);
    const before = playingSnapshot();
    before.elapsed = 54; before.remaining = 6; before.scores = { player: 24, rival: 27 };
    const after = { ...before, duration: 70 as const, remaining: 16 };
    session.emit({ type: 'time_extension', decision: 'accepted', before, after, line: 'しょうがないな、10秒伸ばしてあげる。まだ諦めないでよ？' });
    expect(h.vm.state).toMatchObject({ snapshot: { duration: 70, remaining: 16 }, timeExtension: { before: 6, after: 16 }, line: 'しょうがないな、10秒伸ばしてあげる。まだ諦めないでよ？' });
    expect(h.presentation.playSound).toHaveBeenCalledWith('ruleChange');
    await h.clock.advance(1350);
    expect(h.vm.state.timeExtension).toBeNull();
    expect(h.vm.state.snapshot.remaining).toBe(16);
    h.vm.dispose();
  });

  it('keeps a confirmed loan through an older lender reel stop, then uses later totals without double counting', async () => {
    const h = setup();
    const session = await beginLive(h);
    const inFlight: SpinView = { side: 'player', round: 1, symbols: ['cherry', 'bell', 'seven'], payout: 0, total: 25 };
    session.emit({ type: 'side_spin', spin: inFlight });
    expect(h.vm.state.scores.player).toBe(25);
    const before = playingSnapshot();
    before.elapsed = 8; before.remaining = 52;
    before.scores = before.balances = { player: 25, rival: 0 };
    const after = { ...before, scores: { player: 20, rival: 5 }, balances: { player: 20, rival: 5 }, eventSeq: before.eventSeq + 1 };
    session.emit({ type: 'loan_transfer', direction: 'player_to_rival', amount: 5, before, after, line: 'All right. One more shot.' });
    expect(h.vm.state).toMatchObject({ scores: { player: 20, rival: 5 }, loanTransfer: { direction: 'player_to_rival', amount: 5 } });
    h.rounds[0].stopped();
    expect(h.vm.state.scores).toEqual({ player: 20, rival: 5 });

    const later: SpinView = { ...inFlight, round: 2, total: 19 };
    session.emit({ type: 'side_spin', spin: later });
    h.rounds[1].stopped();
    expect(h.vm.state.scores.player).toBe(19);
    h.vm.dispose();
  });

  it('shows an authoritative rival distraction and clears it from its recovery event or snapshot', async () => {
    const h = setup();
    const session = await beginLive(h);
    session.emit({ type: 'rival_distraction', state: 'started', seconds: 4, line: 'え？ 後ろに誰かいるの？' });
    expect(h.vm.state).toMatchObject({ rivalDistraction: { active: true, seconds: 4 }, rivalMood: 'DISTRACTED...', line: 'え？ 後ろに誰かいるの？' });
    session.emit({ type: 'rival_distraction', state: 'ended', seconds: 4, line: 'もう、何もないじゃない。次は引っかからないよ。' });
    expect(h.vm.state).toMatchObject({ rivalDistraction: null, line: 'もう、何もないじゃない。次は引っかからないよ。' });
    const recovered = playingSnapshot();
    recovered.elapsed = 20; recovered.rivalDistraction = { seconds: 2, untilElapsed: 22 };
    session.emit({ type: 'snapshot', snapshot: recovered });
    expect(h.vm.state.rivalDistraction).toEqual({ active: true, seconds: 2 });
    session.emit({ type: 'snapshot', snapshot: { ...recovered, elapsed: 22, rivalDistraction: undefined } });
    expect(h.vm.state.rivalDistraction).toBeNull();
    h.vm.dispose();
  });

  it('clears a rival distraction when the authoritative result arrives', async () => {
    const h = setup();
    const session = await beginLive(h);
    session.emit({ type: 'rival_distraction', state: 'started', seconds: 2, line: 'え？' });
    const final = playingSnapshot(undefined, true);
    session.emit({ type: 'match_ended', snapshot: final });
    expect(h.vm.state).toMatchObject({ snapshot: { status: 'result' }, rivalDistraction: null });
    h.vm.dispose();
  });

  it('keeps a remote match playable after optional voice failure and replaces payout expiry with the next stopped round', async () => {
    const h = setup();
    const session = await beginLive(h);
    session.handlers.microphone({ active: true, level: 4 });
    expect(h.vm.state.microphone).toEqual({ visible: true, active: true, muted: false, level: 4 });
    h.vm.toggleMicMuted();
    expect(session.setMicMuted).toHaveBeenLastCalledWith(true);
    expect(session.setMuted).toHaveBeenCalledTimes(1);
    expect(h.vm.state.microphone).toEqual({ visible: true, active: true, muted: true, level: 0 });
    session.handlers.microphone({ active: true, level: 4 });
    expect(h.vm.state.microphone.level).toBe(0);
    h.vm.toggleMicMuted();
    expect(session.setMicMuted).toHaveBeenLastCalledWith(false);
    session.emit({ type: 'voice_status', status: 'error', message: 'voice unavailable' });
    expect(h.vm.state.microphone).toEqual({ visible: false, active: false, muted: false, level: 0 });
    expect(h.vm.state).toMatchObject({ mode: 'live', modeBadge: { tone: 'practice' }, connection: { voiceReady: false } });
    h.vm.requestSpin();
    session.emit({ type: 'spin', ...pair(1) });
    await h.clock.advance(1060);
    h.rounds[0].stopped();
    h.rivalRounds[0].stopped();
    expect(h.vm.state.payout).toEqual({ player: 1200, rival: 120 });
    await h.clock.advance(52);
    h.vm.requestSpin();
    session.emit({ type: 'spin', ...pair(2) });
    expect(h.vm.state.payout).toEqual({ player: 1200, rival: 120 });
    await h.clock.advance(1060);
    h.rounds[1].stopped();
    h.rivalRounds[1].stopped();
    await h.clock.advance(100);
    expect(h.vm.state.payout).toEqual({ player: 1200, rival: 120 });
    await h.clock.advance(1600);
    expect(h.vm.state.payout).toBeNull();
    expect(session.spins).toBe(2);
    expect(session.disconnect).not.toHaveBeenCalled();
    h.vm.dispose();
  });

  it('a rival stop cannot release ignored player input or clear its winning payout', async () => {
    const h = setup();
    const session = await beginLive(h);
    const last = pair();
    h.vm.requestSpin();
    session.emit({ type: 'side_spin', spin: last.player });
    h.vm.requestSpin();
    session.emit({ type: 'side_spin', spin: last.rival });
    await h.clock.advance(1150);
    h.rivalRounds[0].stopped();
    expect(session.spins).toBe(1);
    expect(h.vm.state.startControl.spinState).toBe('spinning');
    h.rounds[0].stopped();
    expect(session.spins).toBe(1);
    expect(h.vm.state.payout?.player).toBe(1200);
    await h.clock.advance(500);
    session.emit({ type: 'side_spin', spin: { ...pair(2).rival, payout: 0, total: 120, symbols: ['cherry', 'bell', 'seven'] } });
    h.rivalRounds[1].stopped();
    expect(h.vm.state.payout).toEqual({ player: 1200, rival: 0 });
    expect(h.vm.state.line).not.toContain('BIG WIN');
    h.vm.dispose();
  });

  it('keeps settled bankrolls through duplicate live snapshots and older spin messages', async () => {
    const h = setup();
    const session = await beginLive(h);
    h.presentation.playSpin = (_spin, stopped) => stopped();
    const playerOne: SpinView = { side: 'player', round: 1, symbols: ['cherry', 'cherry', 'cherry'], payout: 3, total: 32 };
    const rivalOne: SpinView = { side: 'rival', round: 1, symbols: ['bell', 'bell', 'bell'], payout: 6, total: 33 };
    session.emit({ type: 'side_spin', spin: playerOne });
    session.emit({ type: 'side_spin', spin: rivalOne });
    expect(h.vm.state.scores).toEqual({ player: 32, rival: 33 });

    const snapshot = {
      ...readySnapshot(),
      status: 'playing' as const,
      elapsed: 2,
      remaining: 58,
      round: 1,
      rounds: { player: 1, rival: 1 },
      balances: { player: 32, rival: 33 },
      scores: { player: 32, rival: 33 },
    };
    session.emit({ type: 'snapshot', snapshot, lastSpins: { player: playerOne, rival: rivalOne } });
    expect(h.vm.state.scores).toEqual({ player: 32, rival: 33 });

    const playerTwo: SpinView = { side: 'player', round: 2, symbols: ['cherry', 'bell', 'seven'], payout: 0, total: 31 };
    session.emit({ type: 'side_spin', spin: playerTwo });
    session.emit({ type: 'side_spin', spin: playerOne });
    expect(h.vm.state.scores).toEqual({ player: 31, rival: 33 });
    h.vm.dispose();
  });

  it('does not announce a false comeback while the other winning spin is still stopping', async () => {
    const h = setup();
    const session = await beginLive(h);
    session.emit({ type: 'voice_status', status: 'error' });
    const rival = { ...pair().rival, payout: 120, total: 120 };
    session.emit({ type: 'side_spin', spin: rival });
    h.rivalRounds[0].stopped();
    const player = { ...pair().player, symbols: ['bell', 'bell', 'bell'] as SpinView['symbols'], payout: 240, total: 240 };
    session.emit({ type: 'side_spin', spin: player });
    session.emit({ type: 'side_spin', spin: { ...rival, round: 2, payout: 240, total: 360 } });
    h.rounds[0].stopped();
    expect(h.vm.state.scores).toEqual({ player: 240, rival: 120 });
    expect(h.presentation.playSound).not.toHaveBeenCalledWith('lead');
    h.rivalRounds[1].stopped();
    expect(h.vm.state.scores).toEqual({ player: 240, rival: 360 });
    expect(h.presentation.playSound).not.toHaveBeenCalledWith('lead');
    session.emit({ type: 'side_spin', spin: { ...player, round: 2, total: 480 } });
    h.rounds[1].stopped();
    expect(h.presentation.playSound).not.toHaveBeenCalledWith('lead');
    expect(h.vm.state.cue).toMatchObject({ kind: 'jackpot' });
    h.vm.dispose();
  });

  it('offers one CPU borrow card, applies it once, and rejects a delayed stale reply', async () => {
    const h = setup();
    await beginCpu(h);
    spendCpuBankroll(h);
    const choice = h.vm.state.textChoice;
    expect(choice).toMatchObject({ kind: 'borrow', question: 'BORROW $5?' });
    h.vm.respondTextChoice(choice!.token, true);
    expect(h.vm.state).toMatchObject({ scores: { player: 5, rival: 25 }, loanTransfer: { direction: 'rival_to_player', amount: 5 }, textChoice: null });
    h.vm.respondTextChoice(choice!.token, true);
    expect(h.vm.state.scores).toEqual({ player: 5, rival: 25 });
    h.vm.dispose();
  });

  it('expires a CPU card both on its timer and before a delayed click can apply it', async () => {
    const h = setup();
    await beginCpu(h);
    spendCpuBankroll(h);
    const choice = h.vm.state.textChoice!;
    h.clock.time = choice.expiresAt + 1;
    h.vm.respondTextChoice(choice.token, true);
    expect(h.vm.state).toMatchObject({ textChoice: null, scores: { player: 0, rival: 30 } });
    h.vm.dispose();

    const normal = setup();
    await beginCpu(normal);
    spendCpuBankroll(normal);
    await normal.clock.advance(5000);
    expect(normal.vm.state.textChoice).toBeNull();
    normal.vm.leave();
    expect(normal.vm.state.textChoice).toBeNull();
    normal.vm.dispose();
  });

  it('keeps text decision cards out of every live voice state', async () => {
    const h = setup();
    const session = await beginLive(h);
    const broke = playingSnapshot();
    broke.scores = broke.balances = { player: 0, rival: 10 };
    session.emit({ type: 'snapshot', snapshot: broke });
    expect(h.vm.state.textChoice).toBeNull();
    session.emit({ type: 'voice_status', status: 'error', message: 'voice unavailable' });
    expect(h.vm.state).toMatchObject({ mode: 'live', connection: { voiceReady: false }, textChoice: null });
    h.vm.dispose();
  });

  it('settles a cancelled countdown and discards sessions or connection failures arriving after a new CPU match', async () => {
    const pendingFactory = deferred<LiveSession>();
    const h = setup(() => pendingFactory.promise);
    const cancelledCountdown = h.vm.startCpu();
    await h.clock.advance(100);
    h.vm.leave();
    await cancelledCountdown;
    expect(h.vm.state.gate.visible).toBe(true);
    const connecting = h.vm.connectLive('old-secret');
    h.vm.leave();
    await beginCpu(h);
    const late = new Session({ message: () => undefined, disconnect: () => undefined, microphone: () => undefined, aiStatus: () => undefined });
    pendingFactory.resolve(late);
    await connecting;
    expect(late.connect).not.toHaveBeenCalled();
    expect(late.disconnect).toHaveBeenCalledOnce();
    expect(h.vm.state).toMatchObject({ mode: 'practice', snapshot: { status: 'playing' }, startControl: { disabled: false } });
    h.vm.dispose();

    const connection = deferred<void>();
    let old!: Session;
    const second = setup(async handlers => {
      old = new Session(handlers);
      old.connect = vi.fn(() => connection.promise);
      return old;
    });
    const attempt = second.vm.connectLive('old-secret');
    await Promise.resolve();
    expect(old.connect).toHaveBeenCalledOnce();
    await beginCpu(second);
    const current = second.vm.state;
    old.emit({ type: 'voice_status', status: 'ready' });
    old.handlers.microphone({ active: true, level: 5 });
    connection.reject(new Error('old connection failed'));
    await attempt;
    expect(second.vm.state).toEqual(current);
    expect(old.disconnect).toHaveBeenCalledOnce();
    second.vm.dispose();
  });
});
