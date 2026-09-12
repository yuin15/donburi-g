import type { MatchSnapshot, Side, SpinView } from '../../shared/protocol';
import { createMatch, getSnapshot, PAYOUT } from '../domain/game';
import type { GameView } from '../view/GameView';
import { RivalReactions } from '../viewmodel/RivalReactions';
import { mountVisualReview, type ReviewExample } from '../view/VisualReview';
import type { GameViewState } from '../viewmodel/GameViewState';

function fixtureStats(scores: MatchSnapshot['scores']): MatchSnapshot['stats'] {
  const side = (total: number, round: number) => ({
    wins: { cherry: (total % PAYOUT.seven) / PAYOUT.cherry, bell: 0, seven: Math.floor(total / PAYOUT.seven) },
    bestSpin: total ? { round, payout: total >= PAYOUT.seven ? PAYOUT.seven : PAYOUT.cherry } : null,
  });
  return { player: side(scores.player, 5), rival: side(scores.rival, 8) };
}

function fixtureSnapshot(): MatchSnapshot {
  const scores = { player: 1440, rival: 1200 };
  return {
    ...getSnapshot(createMatch(1, 'visual-fixture')),
    status: 'playing', elapsed: 46, remaining: 14, round: 21, rounds: { player: 21, rival: 21 }, scores,
    upgrades: { player: [], rival: [] },
    stats: fixtureStats(scores), eventSeq: 1,
  };
}

function resultLine(snapshot: MatchSnapshot): string {
  return snapshot.winner === 'player' ? '「……負けた。もう一回！」' : snapshot.winner === 'rival' ? '「私の勝ち。再戦する？」' : '「引き分け？ 次で決めよう。」';
}

function rivalMood(scores: GameViewState['scores'], result = false): string {
  const gap = scores.player - scores.rival;
  if (result) return gap > 0 ? '次こそ、負けない。' : gap < 0 ? 'もう一度、挑む？' : '決着は、次の勝負で。';
  return gap > 0 ? 'ここから、巻き返す。' : gap < 0 ? 'このまま、逃げきる。' : '正々堂々、60秒。';
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
      connection: { text: 'DEV · 表示検収（API接続なし）', voiceReady: false, showVoiceControls: false },
      modeBadge: { text: 'CPU対戦', tone: 'practice' }, countdown: null,
      startControl: { disabled: true, label: '回転プレビュー', spinState: null, hint: 'クリック / SPACE で回す' },
      machineNotice: '中央の1ラインで判定 · 60秒の獲得コインで勝負',
      result: null, payout: null, cue: null, expression: 'neutral',
      rivalMood: '正々堂々、60秒。', line: '「60秒。私に勝てる？」', heard: '',
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
      ? { text: comeback === 'player' ? '逆転！' : '7揃い！', kind: 'jackpot' }
      : comeback ? { text: comeback === 'player' ? '逆転！' : 'ライバルが逆転！', kind: 'lead' } : null;
    reactionUntil = performance.now() + 1600;
    render({
      scores: { player: player.total, rival: rival.total }, lastSpin: { player, rival },
      payout: celebrate && (player.payout || rival.payout) ? { player: player.payout, rival: rival.payout } : null,
      cue, expression: celebrate ? reaction.expression : state.expression,
      line: celebrate ? `「${reaction.text}」` : state.line,
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
      expression: snapshot.winner === 'player' ? 'frustrated' : snapshot.winner === 'rival' ? 'confident' : 'neutral',
      rivalMood: snapshot.winner === 'player' ? '次こそ、負けない。' : snapshot.winner === 'rival' ? 'もう一度、挑む？' : '決着は、次の勝負で。',
      line: resultLine(snapshot), heard: '',
      startControl: { disabled: false, label: '再戦する', spinState: null, hint: `${snapshot.round}回転の勝負` },
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
    if (['small', 'jackpot', 'rival-jackpot', 'both-jackpot', 'quiet'].includes(example)) {
      const jackpot = example === 'jackpot' || example === 'both-jackpot';
      const player: SpinView = { side: 'player', round: 21, symbols: jackpot ? ['seven', 'seven', 'seven'] : ['cherry', 'cherry', 'cherry'], payout: jackpot ? 1200 : 120, total: jackpot ? 3600 : 1440 };
      const rival: SpinView = { side: 'rival', round: 21, symbols: ['bell', 'seven', 'cherry'], payout: 0, total: jackpot ? 3240 : 1200 };
      if (example === 'rival-jackpot' || example === 'both-jackpot') { rival.symbols = ['seven', 'seven', 'seven']; rival.payout = 1200; rival.total = 3600; }
      if (example === 'rival-jackpot' || example === 'quiet') { player.symbols = ['cherry', 'bell', 'seven']; player.payout = 0; }
      previousLeader = example === 'jackpot' ? 'rival' : null;
      snapshot.scores = { player: player.total, rival: rival.total };
      snapshot.stats = fixtureStats(snapshot.scores);
      if (jackpot) { snapshot.remaining = 8; snapshot.elapsed = 52; }
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
    if (example.startsWith('live-') || example === 'rematch-ready') {
      // Fixed caption states check layout only. Live ordering belongs to VM tests.
      snapshot.status = 'result'; snapshot.remaining = 0; snapshot.elapsed = 60; snapshot.round = 30; snapshot.rounds = { player: 30, rival: 30 }; snapshot.winner = 'player';
      showResult(snapshot);
      const error = example === 'live-result-error';
      const ready = example === 'live-caption';
      render({
        mode: 'live', modeBadge: { text: 'DEV · 字幕検収', tone: ready ? 'live' : 'practice' },
        connection: {
          voiceReady: ready, showVoiceControls: ready,
          text: error ? '結果の音声を終了しました。対戦結果は確定しています。' : ready ? 'マイク停止 / 結果のひとこと' : '会話接続終了',
        },
        line: error ? resultLine(snapshot) : '「検収字幕: いい勝負だったね。」',
      });
      if (example === 'rematch-ready') {
        reset();
        render({ mode: 'live', modeBadge: { text: 'DEV · 字幕検収', tone: 'live' }, startControl: { ...state.startControl, label: '準備中' }, connection: { text: '再戦のAIキャラクターを準備中…', voiceReady: false, showVoiceControls: false } });
      }
    }
    if (example === 'final') {
      snapshot.status = 'result'; snapshot.round = 30; snapshot.rounds = { player: 30, rival: 30 }; snapshot.remaining = 0; snapshot.elapsed = 60;
      snapshot.scores = { player: 3600, rival: 3240 }; snapshot.winner = 'player'; snapshot.stats = fixtureStats(snapshot.scores);
      showSnapshot(snapshot);
      render({ startControl: { disabled: true, label: '最終停止中', spinState: null, hint: `${snapshot.round}回転の勝負` } });
      play(
        { side: 'player', round: 30, symbols: ['seven', 'seven', 'seven'], payout: 1200, total: 3600 },
        { side: 'rival', round: 30, symbols: ['cherry', 'bell', 'seven'], payout: 0, total: 3240 }, snapshot,
      );
    }
  };

  mountVisualReview({ scene: view.scene, reset, spin: play, snapshot: showSnapshot, preview });
}
