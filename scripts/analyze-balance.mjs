const BETS = [1, 3, 5];
const strip = ['cherry', 'bell', 'seven', 'cherry', 'bell', 'cherry', 'bell', 'cherry', 'seven'];
const lines = { 1: [[1, 1, 1]], 3: [[0, 0, 0], [1, 1, 1], [2, 2, 2]], 5: [[0, 0, 0], [1, 1, 1], [2, 2, 2], [0, 1, 2], [2, 1, 0]] };
const payout = { cherry: 3, bell: 6, seven: 30 };
const cell = index => strip[(index + strip.length) % strip.length];
const gridFromStops = stops => [[cell(stops[0] - 1), cell(stops[1] - 1), cell(stops[2] - 1)], [cell(stops[0]), cell(stops[1]), cell(stops[2])], [cell(stops[0] + 1), cell(stops[1] + 1), cell(stops[2] + 1)]];
const evaluateGrid = (grid, bet) => {
  const winningLines = lines[bet].filter(([a, b, c]) => grid[a][0] === grid[b][1] && grid[b][1] === grid[c][2]);
  return { winningLines, payout: winningLines.reduce((sum, [row]) => sum + payout[grid[row][0]], 0) };
};

const outcomes = [];
for (let a = 0; a < 9; a += 1) {
  for (let b = 0; b < 9; b += 1) {
    for (let c = 0; c < 9; c += 1) outcomes.push(gridFromStops([a, b, c]));
  }
}

console.log(JSON.stringify({ method: 'all 729 independent strip stops', payout: { cherry: 3, bell: 6, seven: 30 } }));
for (const bet of BETS) {
  const spins = outcomes.map(grid => evaluateGrid(grid, bet));
  const payouts = spins.map(spin => spin.payout);
  const mean = payouts.reduce((sum, payout) => sum + payout, 0) / payouts.length;
  const variance = payouts.reduce((sum, payout) => sum + (payout - mean) ** 2, 0) / payouts.length;
  const hits = spins.filter(spin => spin.payout > 0).length;
  const multi = spins.filter(spin => spin.winningLines.length > 1).length;
  console.log(JSON.stringify({
    bet,
    expectedPayout: mean,
    expectedReturn: mean / bet,
    expectedNet: mean - bet,
    hitRate: hits / spins.length,
    multiLineRate: multi / spins.length,
    maxPayout: Math.max(...payouts),
    standardDeviation: Math.sqrt(variance),
  }));
}
