import { createMatch, startMatch, advanceMatch, submitUpgrade } from '../src/domain/game.ts';

const strategies = { SS: ['steady', 'steady'], SJ: ['steady', 'jackpot'], JS: ['jackpot', 'steady'], JJ: ['jackpot', 'jackpot'] };
const samples = 10_000;
const seedAt = (index) => Math.imul(index, 0x9e3779b1) >>> 0;

function play(seed, player, rival) {
  // Historical upgrade balance only; current public matches have no upgrades.
  const state = createMatch(seed, 'balance-analysis', 'automatic', { upgrades: true });
  startMatch(state);
  for (const [index, time] of [[0, 20], [1, 40]]) {
    advanceMatch(state, time);
    submitUpgrade(state, 'player', index, player[index]);
    submitUpgrade(state, 'rival', index, rival[index]);
  }
  advanceMatch(state, 50);
  const at50 = { ...state.scores };
  advanceMatch(state, 60);
  return { state, at50 };
}

console.log('10,000 hashed seeds per matchup, both seat assignments (20,000 matches/cell). Draws excluded from win counts, not from denominator.');
for (const [a, strategyA] of Object.entries(strategies)) {
  for (const [b, strategyB] of Object.entries(strategies)) {
    let wins = 0, draws = 0, comeback = 0;
    const scoresA = [], scoresB = [];
    for (let i = 1; i <= samples; i++) {
      for (const swap of [false, true]) {
        const { state, at50 } = play(seedAt(i), swap ? strategyB : strategyA, swap ? strategyA : strategyB);
        const sideA = swap ? 'rival' : 'player', sideB = swap ? 'player' : 'rival';
        const scoreA = state.scores[sideA], scoreB = state.scores[sideB];
        scoresA.push(scoreA); scoresB.push(scoreB);
        if (scoreA > scoreB) { wins++; if (at50[sideA] < at50[sideB]) comeback++; }
        if (scoreA === scoreB) draws++;
      }
    }
    const mean = (scores) => scores.reduce((sum, score) => sum + score, 0) / scores.length;
    scoresA.sort((x, y) => x - y);
    console.log(JSON.stringify({ matchup: `${a}/${b}`, matches: samples * 2, win: wins / (samples * 2), draw: draws / (samples * 2), comeback: comeback / (samples * 2), mean: mean(scoresA), opponentMean: mean(scoresB), p10: scoresA[samples * .2], median: scoresA[samples], p90: scoresA[samples * 1.8] }));
  }
}

const found = new Set();
for (let i = 1; i <= samples && found.size < 4; i++) {
  const seed = seedAt(i);
  const { state, at50 } = play(seed, strategies.SS, strategies.JJ);
  const types = [state.winner];
  if (at50.player < at50.rival && state.winner === 'player') types.push('comeback');
  for (const type of types) if (!found.has(type)) {
    found.add(type);
    console.log(JSON.stringify({ fixture: type, seed, at50, scores: state.scores }));
  }
}
