import type { MatchSnapshot, Side, SpinView } from '../../shared/protocol';
import { createMatch, getSnapshot, PAYOUT } from '../domain/game';
import type { GameView } from '../view/GameView';
import { RivalReactions } from '../viewmodel/RivalReactions';
import { mountVisualReview, type ReviewExample } from '../view/VisualReview';
import type { GameViewState } from '../viewmodel/GameViewState';

function fixtureStats(scores: MatchSnapshot['scores']): MatchSnapshot['stats'] {
  void scores;
  const side = { wins: { cherry: 0, bell: 0, seven: 0 }, bestSpin: null };
  return { player: structuredClone(side), rival: structuredClone(side) };
}

function fixtureSnapshot(): MatchSnapshot {
  const scores = { player: 30, rival: 30 };
  return {
    ...getSnapshot(createMatch(1, 'visual-fixture')),
    status: 'playing', elapsed: 22, remaining: 38, round: 20, rounds: { player: 20, rival: 11 }, scores,
    upgrades: { player: [], rival: [] },
    stats: fixtureStats(scores), eventSeq: 1,
  };
}

function resultLine(snapshot: MatchSnapshot): string {
  return snapshot.winner === 'player' ? 'You got me. Rematch?' : snapshot.winner === 'rival' ? 'That round is mine. Go again?' : 'A tie! One more round?';
}

function rivalMood(scores: GameViewState['scores'], result = false): string {
  const gap = scores.player - scores.rival;
  if (result) return gap > 0 ? 'Next round is mine.' : gap < 0 ? 'Up for a rematch?' : 'One more to settle it.';
  return gap > 0 ? 'I can still catch you.' : gap < 0 ? 'Catch me if you can.' : '60 seconds. Let\'s play.';
}

/** Explicit DEV fixtures; this module never receives or changes a production VM. */
export function mountGameReview(view: GameView, baseline: GameViewState): void {
  const reactions = new RivalReactions();
  let state = baseline;
  let revision = 0;
  let latestRound = 0;
  let previousLeader: Side | null = null;
  let reactionUntil = 0;
  let payoutTimer = 0;
  let cueTimer = 0;

  const render = (patch: Partial<GameViewState> = {}) => {
    state = { ...state, ...patch };
    view.render(state);
  };
  const clearTimers = () => {
    clearTimeout(payoutTimer);
    clearTimeout(cueTimer);
    payoutTimer = 0;
    cueTimer = 0;
  };
  const reset = (snapshot = getSnapshot(createMatch(1, 'visual-fixture'))) => {
    revision += 1;
    latestRound = 0;
    previousLeader = null;
    reactionUntil = 0;
    clearTimers();
    reactions.reset();
    view.stopSound();
    view.resetScene();
    state = {
      ...baseline, mode: 'practice', snapshot, scores: { ...snapshot.scores }, lastSpin: null,
      gate: { visible: false, connecting: false, message: '' },
      connection: { text: 'DEV · 表示検収（API接続なし）', voiceReady: false, showVideo: false, showVoiceControls: false },
      modeBadge: { text: 'CPU DUEL', tone: 'practice' }, countdown: null,
      startControl: { disabled: false, label: 'SPIN', spinState: 'ready', hint: 'CLICK / SPACE TO SPIN' },
      machineNotice: '3 MATCHING SYMBOLS · CENTER LINE',
      result: null, payout: null, cue: null, timeExtension: null, expression: 'neutral',
      rivalMood: '60 seconds. Let\'s play.', line: 'Think you can beat me?', heard: '',
      conversation: 'idle',
    };
    render();
  };

  const showSnapshot = (snapshot: MatchSnapshot) => {
    const gap = state.scores.player - state.scores.rival;
    render({
      snapshot,
      expression: performance.now() >= reactionUntil ? gap > 0 ? 'frustrated' : gap < 0 ? 'confident' : 'neutral' : state.expression,
      rivalMood: rivalMood(state.scores, snapshot.status === 'result'),
    });
  };

  const settle = (player: SpinView, rival: SpinView, celebrate: boolean, still = false) => {
    clearTimers();
    const leader = player.total > rival.total ? 'player' : player.total < rival.total ? 'rival' : null;
    const comeback = leader && previousLeader && leader !== previousLeader ? leader : null;
    if (leader) previousLeader = leader;
    const reaction = reactions.next(player, rival, state.snapshot.remaining, comeback);
    const cue: GameViewState['cue'] = !celebrate ? null : player.payout >= PAYOUT.seven
      ? { text: 'BIG WIN', kind: 'jackpot' }
      : null;
    reactionUntil = performance.now() + 1600;
    render({
      scores: { player: player.total, rival: rival.total }, lastSpin: { player, rival },
      payout: celebrate && (player.payout || rival.payout) ? { player: player.payout, rival: rival.payout } : null,
      cue, expression: celebrate ? reaction.expression : state.expression,
      line: celebrate ? reaction.text : state.line,
      rivalMood: rivalMood({ player: player.total, rival: rival.total }, state.snapshot.status === 'result'),
    });
    if (celebrate) {
      if (cue) view.playSound(cue.kind);
      else if (player.payout) view.playSound('win');
      else if (rival.payout) view.playSound('rivalWin');
    }
    if (still) return;
    const current = revision;
    if (state.payout) payoutTimer = window.setTimeout(() => {
      if (current === revision) render({ payout: null });
    }, Math.max(player.payout, rival.payout) >= PAYOUT.seven ? 1200 : 650);
    if (cue) cueTimer = window.setTimeout(() => {
      if (current === revision) render({ cue: null });
    }, 1800);
  };

  const showResult = (snapshot: MatchSnapshot) => {
    clearTimers();
    view.stopScene();
    render({
      snapshot, scores: { ...snapshot.scores }, result: snapshot, payout: null, cue: null,
      sessionRecord: { best: Math.max(30, snapshot.scores.player), streak: snapshot.winner === 'player' ? 3 : 0, newBest: snapshot.scores.player > 30 },
      expression: snapshot.winner === 'player' ? 'frustrated' : snapshot.winner === 'rival' ? 'confident' : 'neutral',
      rivalMood: snapshot.winner === 'player' ? 'Next round is mine.' : snapshot.winner === 'rival' ? 'Up for a rematch?' : 'One more to settle it.',
      line: resultLine(snapshot), heard: '',
      startControl: { disabled: false, label: 'REMATCH', spinState: null, hint: `YOU ${snapshot.rounds.player} SPINS · RIVAL ${snapshot.rounds.rival} SPINS` },
    });
    view.celebrateResult(snapshot.winner ?? 'draw');
    view.playSound('result');
  };

  const play = (player: SpinView, rival: SpinView, result: MatchSnapshot | null = null) => {
    const current = revision;
    latestRound = player.round;
    view.scene.setUpgrades(player.upgrades ?? state.snapshot.upgrades.player, rival.upgrades ?? state.snapshot.upgrades.rival);
    view.playSound('spin');
    view.scene.play(player, rival, celebrate => {
      if (current !== revision || player.round !== latestRound) return;
      settle(player, rival, celebrate && !document.hidden);
      if (result) showResult(result);
    });
  };

  const preview = (example: ReviewExample) => {
    const snapshot = fixtureSnapshot();
    reset(snapshot);
    showSnapshot(snapshot);
    view.scene.setUpgrades(snapshot.upgrades.player, snapshot.upgrades.rival);
    if (example === 'normal') view.scene.show(['bell', 'seven', 'cherry']);
    if (example === 'final-seconds') {
      snapshot.remaining = 8; snapshot.elapsed = 52;
      snapshot.scores = { player: 2640, rival: 2760 };
      snapshot.stats = fixtureStats(snapshot.scores);
      view.scene.show(['cherry', 'bell', 'seven']);
      render({ snapshot, scores: snapshot.scores, sessionRecord: { best: 3600, streak: 2, newBest: false },
        machineNotice: 'FINAL SPINS · KEEP GOING', line: 'Eight seconds. Make it count!',
        rivalMood: 'One spin could change it.' });
    }
    if (example === 'extension-accepted' || example === 'extension-rejected') {
      const before = { ...snapshot, elapsed: 54, remaining: 6, duration: 60 as const, scores: { player: 24, rival: 27 }, stats: fixtureStats({ player: 24, rival: 27 }) };
      if (example === 'extension-accepted') {
        const after = { ...before, duration: 70 as const, remaining: 16 };
        render({ snapshot: after, scores: after.scores, timeExtension: { decision: 'accepted', before: before.remaining, after: after.remaining }, line: 'いいよ。あと10秒、見せてみな。', rivalMood: 'RULE CHANGED · ONE MORE CHANCE' });
        view.playSound('ruleChange');
      } else render({ snapshot: before, scores: before.scores, timeExtension: null, line: 'だめ。時間切れまで、このまま勝負しよう。', rivalMood: 'REQUEST DENIED' });
    }
    if (example === 'session-best') {
      snapshot.status = 'result'; snapshot.remaining = 0; snapshot.elapsed = 60;
      snapshot.rounds = { player: 42, rival: 30 }; snapshot.round = 42;
      snapshot.scores = { player: 3600, rival: 3120 }; snapshot.winner = 'player';
      snapshot.stats = fixtureStats(snapshot.scores);
      view.scene.show(['seven', 'seven', 'seven']);
      showResult(snapshot);
    }
    if (['small', 'bell-cherry', 'cherry-bell', 'jackpot', 'rival-jackpot', 'both-jackpot', 'quiet'].includes(example)) {
      const jackpot = example === 'jackpot' || example === 'both-jackpot';
      const player: SpinView = { side: 'player', round: 20, symbols: jackpot ? ['seven', 'seven', 'seven'] : ['bell', 'bell', 'bell'], payout: jackpot ? PAYOUT.seven : PAYOUT.bell, total: jackpot ? 59 : 35 };
      const rival: SpinView = { side: 'rival', round: 11, symbols: ['bell', 'seven', 'cherry'], payout: 0, total: jackpot ? 29 : 19 };
      if (example === 'bell-cherry') { rival.symbols = ['cherry', 'cherry', 'cherry']; rival.payout = PAYOUT.cherry; }
      if (example === 'cherry-bell') { player.symbols = ['cherry', 'cherry', 'cherry']; player.payout = PAYOUT.cherry; rival.symbols = ['bell', 'bell', 'bell']; rival.payout = PAYOUT.bell; }
      if (example === 'rival-jackpot' || example === 'both-jackpot') { rival.symbols = ['seven', 'seven', 'seven']; rival.payout = PAYOUT.seven; rival.total = 49; }
      if (example === 'rival-jackpot' || example === 'quiet') { player.symbols = ['cherry', 'bell', 'seven']; player.payout = 0; }
      previousLeader = example === 'jackpot' ? 'rival' : null;
      snapshot.scores = { player: player.total, rival: rival.total };
      snapshot.stats = fixtureStats(snapshot.scores);
      if (jackpot) { snapshot.remaining = 21; snapshot.elapsed = 39; }
      if (example === 'rival-jackpot') { player.total = 19; snapshot.scores.player = 19; snapshot.remaining = 12; snapshot.elapsed = 48; snapshot.stats = fixtureStats(snapshot.scores); }
      showSnapshot(snapshot);
      view.scene.show(player.symbols, player.payout, rival.symbols, true, rival.payout);
      settle(player, rival, true, true);
    }
    if (example === 'draw' || example === 'defeat') {
      snapshot.status = 'result'; snapshot.remaining = 0; snapshot.elapsed = 60; snapshot.round = 30; snapshot.rounds = { player: 30, rival: 30 };
      snapshot.scores = { player: 1440, rival: example === 'draw' ? 1440 : 2640 };
      snapshot.stats = fixtureStats(snapshot.scores); snapshot.winner = example === 'draw' ? 'draw' : 'rival';
      showResult(snapshot);
    }
    if (example.startsWith('mic-')) {
      showSnapshot(snapshot);
      render({
        mode: 'live', modeBadge: { text: 'DEV · MIC PREVIEW', tone: 'live' },
        connection: { text: 'DEV fixture · No microphone or API connected', voiceReady: true, showVideo: false, showVoiceControls: true },
        microphone: { visible: true, active: true, muted: example === 'mic-muted', level: example === 'mic-live' ? 4 : 0 },
        conversation: example === 'mic-live' ? 'listening' : example === 'mic-reply' ? 'replying' : 'idle',
        line: example === 'mic-live' ? 'Listening…' : example === 'mic-reply' ? 'まだ追いつけるよ。次は私の番！' : "I'm right here. Keep spinning!",
        heard: example === 'mic-live' || example === 'mic-reply' ? 'YOU: まだ追いつけそう？' : '',
      });
    }
    if (example.startsWith('live-') || example === 'rematch-ready') {
      // Fixed caption states check layout only. Live ordering belongs to VM tests.
      snapshot.status = 'result'; snapshot.remaining = 0; snapshot.elapsed = 60; snapshot.round = 30; snapshot.rounds = { player: 30, rival: 30 }; snapshot.winner = 'player';
      showResult(snapshot);
      const error = example === 'live-result-error';
      const ready = example === 'live-caption';
      render({
        mode: 'live', modeBadge: { text: 'DEV · 字幕検収', tone: ready ? 'live' : 'practice' },
        connection: {
          voiceReady: ready, showVideo: ready, showVoiceControls: ready,
          text: error ? '結果の音声を終了しました。対戦結果は確定しています。' : ready ? 'マイク停止 / 結果のひとこと' : '会話接続終了',
        },
        line: error ? resultLine(snapshot) : ready
          ? '検収用の長い字幕です。最後まで接戦だったね。ベルがそろったところは驚いたけれど、まだまだ負けないよ。次の試合も三つの絵柄をそろえて、たくさんのコインを集めよう。もう一回勝負する？'
          : '「検収字幕: いい勝負だったね。」',
      });
      if (example === 'rematch-ready') {
        reset();
        render({ mode: 'live', modeBadge: { text: 'DEV · 字幕検収', tone: 'live' }, startControl: { ...state.startControl, label: '準備中' }, connection: { text: '再戦のAIキャラクターを準備中…', voiceReady: false, showVideo: false, showVoiceControls: false } });
      }
    }
    if (example === 'final') {
      snapshot.status = 'result'; snapshot.round = 30; snapshot.rounds = { player: 30, rival: 30 }; snapshot.remaining = 0; snapshot.elapsed = 60;
      snapshot.scores = { player: 3600, rival: 3240 }; snapshot.winner = 'player'; snapshot.stats = fixtureStats(snapshot.scores);
      showSnapshot(snapshot);
      render({ startControl: { disabled: true, label: 'LAST SPIN', spinState: null, hint: `YOU ${snapshot.rounds.player} SPINS · RIVAL ${snapshot.rounds.rival} SPINS` } });
      play(
        { side: 'player', round: 30, symbols: ['seven', 'seven', 'seven'], payout: 1200, total: 3600 },
        { side: 'rival', round: 30, symbols: ['cherry', 'bell', 'seven'], payout: 0, total: 3240 }, snapshot,
      );
    }
  };

  mountVisualReview({ scene: view.scene, reset, spin: play, snapshot: showSnapshot, preview });
}
