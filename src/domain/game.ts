export type SymbolId='cherry'|'bell'|'seven';
export type UpgradeId='steady'|'jackpot';
export type Side='player'|'rival';
export interface ReelState{symbols:SymbolId[]}
export interface SpinResult{round:number;side:Side;symbols:[SymbolId,SymbolId,SymbolId];payout:number;total:number}
export interface MatchState{status:'ready'|'playing'|'result';remaining:number;round:number;scores:Record<Side,number>;reels:Record<Side,ReelState>;upgrades:Record<Side,UpgradeId[]>;winner?:Side|'draw'}
export const MATCH_SECONDS=60;
export const SPIN_INTERVAL=2;
export const UPGRADE_SECONDS=[40,20] as const;
const PAYOUT:Record<SymbolId,number>={cherry:120,bell:240,seven:1200};
const BASE:SymbolId[]=['cherry','bell','seven','cherry','bell','cherry','bell','cherry','seven'];
export function createMatch():MatchState{return{status:'ready',remaining:MATCH_SECONDS,round:0,scores:{player:0,rival:0},reels:{player:{symbols:[...BASE]},rival:{symbols:[...BASE]}},upgrades:{player:[],rival:[]}}}
export function applyUpgrade(state:MatchState,side:Side,id:UpgradeId){if(state.upgrades[side].length>=2)return;const add=id==='steady'?'cherry':'seven';state.reels[side].symbols.push(add,add);state.upgrades[side].push(id)}
export function spin(state:MatchState,side:Side,rng=Math.random):SpinResult{const reel=state.reels[side].symbols;const symbols=[0,1,2].map(()=>reel[Math.floor(rng()*reel.length)]) as [SymbolId,SymbolId,SymbolId];const payout=symbols.every(v=>v===symbols[0])?PAYOUT[symbols[0]]:0;state.scores[side]+=payout;return{round:state.round,side,symbols,payout,total:state.scores[side]}}
export function finish(state:MatchState){state.status='result';state.remaining=0;state.winner=state.scores.player===state.scores.rival?'draw':state.scores.player>state.scores.rival?'player':'rival'}