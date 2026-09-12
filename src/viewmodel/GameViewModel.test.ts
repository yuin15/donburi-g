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
  disconnect = vi.fn(async () => undefined);
  setMuted = vi.fn();
  constructor(readonly handlers: LiveSessionHandlers) {}
  connect = vi.fn(async () => {
    this.handlers.message({ type: 'voice_status', status: 'ready' });
    this.handlers.message({ type: 'snapshot', snapshot: readySnapshot() });
  });
  send(message: ClientMessage): void { this.messages.push(message); }
  sendSpin(): string { return `spin-${++this.spins}`; }
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
    resetScene: vi.fn(), stopScene: vi.fn(), celebrateResult: vi.fn(), playSound: vi.fn(), stopSound: vi.fn(), setEffectsMuted: vi.fn(), focus: vi.fn(),
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
  it('runs the rival for a whole match without any player input and waits for its final stop', async () => {
    const h = setup();
    const observed = vi.fn();
    const unsubscribe = h.vm.subscribe(observed);
    expect(observed).toHaveBeenCalledOnce();
    await beginCpu(h);
    expect(h.vm.state.startControl).toMatchObject({ disabled: false, label: 'SPIN' });
    await h.clock.advance(60000);
    expect(h.rounds).toHaveLength(0);
    expect(h.rivalRounds).toHaveLength(30);
    expect(h.vm.state.startControl.label).toBe('LAST SPIN');
    expect(h.vm.state.result).toBeNull();
    h.rivalRounds.at(-1)!.stopped();
    expect(h.vm.state.result).toMatchObject({ rounds: { player: 0, rival: 30 }, scores: { player: 0, rival: h.rivalRounds.at(-1)!.spin.total } });
    expect(h.presentation.celebrateResult).toHaveBeenCalledOnce();
    unsubscribe();
    h.vm.dispose();
    expect(h.clock.timers.size).toBe(0);
  });

  it('stores only one extra spin and ignores an old stop callback after leaving and starting again', async () => {
    const h = setup();
    await beginCpu(h);
    h.vm.requestSpin();
    for (let i = 0; i < 20; i++) h.vm.requestSpin();
    expect(h.rounds).toHaveLength(1);
    expect(h.vm.state.startControl.spinState).toBe('queued');
    const first = h.rounds[0];
    expect(h.vm.state.scores).toEqual({ player: 0, rival: 0 });
    await h.clock.advance(1060);
    first.stopped();
    expect(h.vm.state.scores).toEqual({ player: first.spin.total, rival: 0 });
    await h.clock.advance(52);
    expect(h.rounds).toHaveLength(2);
    const obsolete = h.rounds[1];
    await h.clock.advance(1060);
    obsolete.stopped();
    await h.clock.advance(3000);
    expect(h.rounds).toHaveLength(2);
    h.vm.requestSpin();
    const interrupted = h.rounds[2];
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
    h.rounds[0].stopped();
    expect(h.vm.state.result).toBeNull();
    h.rivalRounds[0].stopped();
    expect(h.vm.state.scores).toEqual(final.scores);
    expect(h.vm.state.result).toEqual(final);
    expect(h.vm.state.line).toBe('いい勝負だったね。');
    expect(h.presentation.celebrateResult).toHaveBeenCalledOnce();
    await h.clock.advance(3000);
    expect(h.vm.state.line).toBe('いい勝負だったね。');
    session.emit({ type: 'voice_status', status: 'closed' });
    expect(h.vm.state.line).toBe('いい勝負だったね。');
    h.vm.dispose();
    expect(session.disconnect).toHaveBeenCalledOnce();
  });

  it('keeps a remote match playable after optional voice failure and replaces payout expiry with the next stopped round', async () => {
    const h = setup();
    const session = await beginLive(h);
    session.emit({ type: 'voice_status', status: 'error', message: 'voice unavailable' });
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
    await h.clock.advance(1100);
    expect(h.vm.state.payout).toBeNull();
    expect(session.spins).toBe(2);
    expect(session.disconnect).not.toHaveBeenCalled();
    h.vm.dispose();
  });

  it('a rival stop cannot release a queued player input or clear its winning payout', async () => {
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
    expect(h.vm.state.startControl.spinState).toBe('queued');
    h.rounds[0].stopped();
    expect(session.spins).toBe(2);
    expect(h.vm.state.payout?.player).toBe(1200);
    await h.clock.advance(500);
    session.emit({ type: 'side_spin', spin: { ...pair(2).rival, payout: 0, total: 120, symbols: ['cherry', 'bell', 'seven'] } });
    h.rivalRounds[1].stopped();
    expect(h.vm.state.payout).toEqual({ player: 1200, rival: 0 });
    expect(h.vm.state.line).not.toContain('BIG WIN');
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
    expect(h.presentation.playSound).toHaveBeenCalledWith('lead');
    expect(h.vm.state.cue).toBeNull();
    expect(h.vm.state.line).toContain('lead');
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
    const late = new Session({ message: () => undefined, disconnect: () => undefined });
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
    connection.reject(new Error('old connection failed'));
    await attempt;
    expect(second.vm.state).toEqual(current);
    expect(old.disconnect).toHaveBeenCalledOnce();
    second.vm.dispose();
  });
});
