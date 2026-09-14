import { rewardDuration, rewardSymbol } from '../viewmodel/RewardPresentation';
import type { MatchSnapshot, Side, SpinView } from '../../shared/protocol';
import { createMatch, evaluateGrid, getSnapshot, gridFromStops, PAYOUT, STARTING_BALANCE } from '../domain/game';
import type { GameView } from '../view/GameView';
import { RivalReactions } from '../viewmodel/RivalReactions';
import { selectAmbientRivalExpression, selectResultRivalExpression } from '../viewmodel/RivalExpressionSelection';
import { mountVisualReview, type ReviewExample } from '../view/VisualReview';
import type { GameViewState } from '../viewmodel/GameViewState';

function fixtureStats(scores: MatchSnapshot['scores']): MatchSnapshot['stats'] {
  const side = (balance: number) => balance > STARTING_BALANCE
    ? { wins: { cherry: 1, bell: 0, seven: 0 }, bestSpin: { round: 1, payout: PAYOUT.cherry } }
    : { wins: { cherry: 0, bell: 0, seven: 0 }, bestSpin: null };
  return { player: side(scores.player), rival: side(scores.rival) };
}

function setFixtureBalances(snapshot: MatchSnapshot, scores: MatchSnapshot['scores']): void {
  snapshot.scores = { ...scores };
  snapshot.balances = { ...scores };
  snapshot.stats = fixtureStats(scores);
}

function fixtureSpin(side: Side, round: number, stops: [number, number, number], bet: 1 | 3 | 5, before = STARTING_BALANCE): SpinView {
  const grid = gridFromStops(stops);
  const outcome = evaluateGrid(grid, bet);
  return { side, round, symbols: grid[1], grid, stops, bet, winningLines: outcome.winningLines, payout: outcome.payout, total: before - bet + outcome.payout };
}

function fixtureSnapshot(): MatchSnapshot {
  const scores = { player: 24, rival: 18 };
  return {
    ...getSnapshot(createMatch(1, 'visual-fixture')),
    status: 'playing', elapsed: 22, remaining: 38, round: 20, rounds: { player: 20, rival: 11 }, balances: scores, scores,
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
  let spinning = false;
  let payoutTimer = 0;
  let cueTimer = 0;

  const render = (patch: Partial<GameViewState> = {}) => {
    state = { ...state, ...patch };
    if (patch.expression === undefined && !state.result && performance.now() >= reactionUntil) {
      state = { ...state, expression: selectAmbientRivalExpression({
        scores: state.scores, remaining: state.snapshot.remaining, playing: state.snapshot.status === 'playing',
        spinning, countdown: state.countdown !== null,
        textChoice: state.textChoice !== null, listening: state.conversation === 'listening',
        distracted: !!state.rivalDistraction?.active,
      }) };
    }
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
    spinning = false;
    clearTimers();
    reactions.reset();
    view.stopSound();
    view.resetScene();
    state = {
      ...baseline, mode: 'practice', snapshot, scores: { ...snapshot.scores }, balances: { ...snapshot.balances }, bets: { ...snapshot.bets }, lastSpin: null,
      gate: { visible: false, connecting: false, message: '' },
      connection: { text: 'DEV · 表示検収（API接続なし）', voiceReady: false, showVideo: false, showVoiceControls: false },
      modeBadge: { text: 'CPU DUEL', tone: 'practice' }, countdown: null,
      startControl: { disabled: false, label: 'SPIN', spinState: 'ready', hint: '' },
      machineNotice: 'CHOOSE BET · ACTIVE LINES PAY',
      result: null, payout: null, cue: null, timeExtension: null, loanTransfer: null, textChoice: null, rivalDistraction: null, expression: 'neutral',
      rivalMood: '60 seconds. Let\'s play.', line: 'Think you can beat me?', heard: '',
      conversation: 'idle',
    };
    render();
  };

  const showSnapshot = (snapshot: MatchSnapshot) => {
    render({
      snapshot,
      balances: { ...snapshot.balances },
      bets: { ...snapshot.bets },
      rivalMood: rivalMood(state.scores, snapshot.status === 'result'),
    });
  };

  const settle = (player: SpinView, rival: SpinView, celebrate: boolean, still = false) => {
    spinning = false;
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
      else if (player.payout) view.playSound(rewardSymbol(player) === 'bell' ? 'bellWin' : 'win');
      else if (rival.payout) view.playSound('rivalWin');
    }
    if (still) return;
    const current = revision;
    if (state.payout) payoutTimer = window.setTimeout(() => {
      if (current === revision) render({ payout: null });
    }, Math.max(rewardDuration(player.payout, rewardSymbol(player)), rewardDuration(rival.payout, rewardSymbol(rival))));
    if (cue) cueTimer = window.setTimeout(() => {
      if (current === revision) render({ cue: null });
    }, 1800);
  };

  const showResult = (snapshot: MatchSnapshot) => {
    spinning = false;
    clearTimers();
    view.stopScene();
    render({
      snapshot, scores: { ...snapshot.scores }, result: snapshot, payout: null, cue: null,
      sessionRecord: { best: Math.max(STARTING_BALANCE, snapshot.scores.player), streak: snapshot.winner === 'player' ? 3 : 0, newBest: snapshot.scores.player > STARTING_BALANCE },
      expression: selectResultRivalExpression(snapshot),
      rivalMood: snapshot.winner === 'player' ? 'Next round is mine.' : snapshot.winner === 'rival' ? 'Up for a rematch?' : 'One more to settle it.',
      line: resultLine(snapshot), heard: '',
      startControl: { disabled: false, label: 'REMATCH', spinState: null, hint: `YOU ${snapshot.rounds.player} SPINS · RIVAL ${snapshot.rounds.rival} SPINS` },
    });
    view.celebrateResult(snapshot.winner ?? 'draw');
    view.stopSound();
    view.playSound(snapshot.winner === 'player' ? 'victory' : snapshot.winner === 'rival' ? 'defeat' : 'draw');
  };

  const play = (player: SpinView, rival: SpinView, result: MatchSnapshot | null = null) => {
    const current = revision;
    latestRound = player.round;
    spinning = true;
    render();
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
      setFixtureBalances(snapshot, { player: 24, rival: 18 });
      view.scene.show(['cherry', 'bell', 'seven']);
      render({ snapshot, scores: snapshot.scores, sessionRecord: { best: STARTING_BALANCE, streak: 2, newBest: false },
        machineNotice: 'FINAL SPINS · KEEP GOING', line: 'Eight seconds. Make it count!',
        rivalMood: 'One spin could change it.' });
    }
    if (example === 'extension-accepted' || example === 'extension-rejected') {
      const before = { ...snapshot, elapsed: 54, remaining: 6, duration: 60 as const, scores: { player: 24, rival: 27 }, stats: fixtureStats({ player: 24, rival: 27 }) };
      if (example === 'extension-accepted') {
        const after = { ...before, duration: 70 as const, remaining: 16 };
        render({ snapshot: after, scores: after.scores, timeExtension: { decision: 'accepted', before: before.remaining, after: after.remaining }, line: 'しょうがないな、10秒伸ばしてあげる。まだ諦めないでよ？', rivalMood: 'RULE CHANGED · ONE MORE CHANCE' });
        view.playSound('ruleChange');
      } else render({ snapshot: before, scores: before.scores, timeExtension: null, line: 'だめ。時間切れまで、このまま勝負しよう。', rivalMood: 'REQUEST DENIED' });
    }
    if (example === 'extension-offered') {
      snapshot.remaining = 12; snapshot.elapsed = 48;
      snapshot.scores = { player: 24, rival: 27 };
      snapshot.stats = fixtureStats(snapshot.scores);
      render({ snapshot, scores: snapshot.scores, line: 'もう少し時間が欲しい？ 伸ばしてあげようか？', rivalMood: 'ONE MORE CHANCE?' });
    }
    if (example === 'loan-rival-to-player' || example === 'loan-player-to-rival') {
      const direction = example === 'loan-rival-to-player' ? 'rival_to_player' as const : 'player_to_rival' as const;
      const balances = direction === 'rival_to_player' ? { player: 5, rival: 18 } : { player: 18, rival: 5 };
      setFixtureBalances(snapshot, balances);
      render({
        snapshot, scores: balances, balances, loanTransfer: { direction, amount: 5 },
        line: direction === 'rival_to_player' ? 'Fine. Don’t waste it.' : 'All right. One more shot.',
        rivalMood: 'LOAN CONFIRMED',
      });
    }
    if (example === 'text-borrow' || example === 'text-lend' || example === 'text-extend') {
      const kind = example === 'text-borrow' ? 'borrow' as const : example === 'text-lend' ? 'lend' as const : 'extend' as const;
      if (kind === 'borrow') setFixtureBalances(snapshot, { player: 0, rival: 18 });
      if (kind === 'lend') setFixtureBalances(snapshot, { player: 18, rival: 0 });
      if (kind === 'extend') { snapshot.remaining = 12; snapshot.elapsed = 48; }
      const choice = kind === 'borrow'
        ? { token: 1, expiresAt: Number.MAX_SAFE_INTEGER, kind, question: 'BORROW $5?', detail: 'Ask your rival for one more spin.', acceptLabel: 'BORROW $5', declineLabel: 'DECLINE' }
        : kind === 'lend'
          ? { token: 1, expiresAt: Number.MAX_SAFE_INTEGER, kind, question: 'LEND $5?', detail: 'Your rival is out of cash.', acceptLabel: 'LEND $5', declineLabel: 'DECLINE' }
          : { token: 1, expiresAt: Number.MAX_SAFE_INTEGER, kind, question: 'EXTEND THE DUEL?', detail: 'Add 10 seconds for one more chance.', acceptLabel: 'EXTEND +10 SEC', declineLabel: 'DECLINE' };
      render({ snapshot, scores: snapshot.scores, balances: snapshot.balances, textChoice: choice, line: 'Fixture card only — not live gameplay.' });
    }
    if (example === 'distraction-started') {
      view.scene.show(['cherry', 'bell', 'seven'], 0, ['seven', 'bell', 'cherry']);
      view.scene.setRivalDistracted(true);
      render({ rivalDistraction: { active: true, seconds: 4 }, line: 'え？ 後ろに誰かいるの？', rivalMood: 'DISTRACTED...', conversation: 'replying' });
    }
    if (example === 'distraction-recovered') {
      view.scene.show(['cherry', 'bell', 'seven'], 0, ['seven', 'bell', 'cherry']);
      view.scene.setRivalDistracted(false);
      render({ rivalDistraction: null, line: 'もう、何もないじゃない。次は引っかからないよ。', rivalMood: 'BACK IN THE GAME', conversation: 'replying' });
    }
    if (example === 'session-best') {
      snapshot.status = 'result'; snapshot.remaining = 0; snapshot.elapsed = 60;
      snapshot.rounds = { player: 42, rival: 30 }; snapshot.round = 42;
      setFixtureBalances(snapshot, { player: 42, rival: 24 }); snapshot.winner = 'player';
      view.scene.show(['seven', 'seven', 'seven']);
      showResult(snapshot);
    }
    if (['small', 'diagonal', 'bell-cherry', 'cherry-bell', 'jackpot', 'rival-jackpot', 'both-jackpot', 'quiet'].includes(example)) {
      const jackpot = example === 'jackpot' || example === 'both-jackpot';
      // These stops are deliberately central-line-only wins: [0] is cherry,
      // [1] is bell, and [8] is seven. Multi-line fixtures use separate labels.
      let player = fixtureSpin('player', 20, jackpot ? [8, 8, 8] : [0, 0, 0], 1, 25);
      let rival = fixtureSpin('rival', 11, [1, 2, 4], 3, 21);
      if (example === 'diagonal') player = fixtureSpin('player', 20, [0, 2, 7], 5, 25);
      if (example === 'bell-cherry') { player = fixtureSpin('player', 20, [1, 1, 1], 1, 25); rival = fixtureSpin('rival', 11, [0, 0, 0], 1, 21); }
      if (example === 'cherry-bell') { player = fixtureSpin('player', 20, [0, 0, 0], 1, 25); rival = fixtureSpin('rival', 11, [1, 1, 1], 1, 21); }
      if (example === 'rival-jackpot' || example === 'both-jackpot') rival = fixtureSpin('rival', 11, [8, 8, 8], 1, 21);
      if (example === 'rival-jackpot' || example === 'quiet') player = fixtureSpin('player', 20, [1, 2, 4], 3, 25);
      previousLeader = example === 'jackpot' ? 'rival' : null;
      setFixtureBalances(snapshot, { player: player.total, rival: rival.total });
      snapshot.bets = { player: player.bet!, rival: rival.bet! };
      if (jackpot) { snapshot.remaining = 21; snapshot.elapsed = 39; }
      if (example === 'rival-jackpot') { snapshot.remaining = 12; snapshot.elapsed = 48; }
      showSnapshot(snapshot);
      view.scene.showSpins(player, rival, true);
      settle(player, rival, true, true);
    }
    if (example === 'draw' || example === 'defeat') {
      snapshot.status = 'result'; snapshot.remaining = 0; snapshot.elapsed = 60; snapshot.round = 30; snapshot.rounds = { player: 30, rival: 30 };
      setFixtureBalances(snapshot, { player: 24, rival: example === 'draw' ? 24 : 36 }); snapshot.winner = example === 'draw' ? 'draw' : 'rival';
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
      const player = fixtureSpin('player', 30, [8, 8, 8], 1, 25);
      const rival = fixtureSpin('rival', 30, [1, 2, 4], 3, 21);
      setFixtureBalances(snapshot, { player: player.total, rival: rival.total });
      snapshot.bets = { player: player.bet!, rival: rival.bet! };
      snapshot.winner = 'player';
      showSnapshot(snapshot);
      render({ startControl: { disabled: true, label: 'LAST SPIN', spinState: null, hint: `YOU ${snapshot.rounds.player} SPINS · RIVAL ${snapshot.rounds.rival} SPINS` } });
      play(player, rival, snapshot);
    }
  };

  mountVisualReview({ scene: view.scene, reset, spin: play, snapshot: showSnapshot, preview, unlockSound: () => view.unlockSound() });
}
