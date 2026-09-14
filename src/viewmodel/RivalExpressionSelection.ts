import type { MatchSnapshot } from '../../shared/protocol';
import { PAYOUT } from '../domain/game';
import type { RivalExpression } from './RivalExpressions';

interface AmbientExpressionContext {
  scores: Readonly<MatchSnapshot['scores']>;
  remaining: number;
  playing: boolean;
  spinning: boolean;
  countdown: boolean;
  textChoice: boolean;
  listening: boolean;
  distracted: boolean;
}

/** Called only after the held reel reaction; never changes a match or conversation. */
export function selectAmbientRivalExpression(context: AmbientExpressionContext): RivalExpression {
  if (context.countdown) return 'anticipation';
  if (context.distracted) return 'shy-smile';
  if (context.textChoice || context.listening) return 'thoughtful';
  if (!context.playing) return context.spinning ? 'anticipation' : 'neutral';
  const gap = context.scores.player - context.scores.rival;
  if (context.remaining > 0 && context.remaining <= 10) {
    if (Math.abs(gap) <= PAYOUT.bell) return 'tense';
    if (gap > 0) return 'anxious';
  }
  if (context.spinning) return 'anticipation';
  return gap > 0 ? 'frustrated' : gap < 0 ? 'confident' : 'focused';
}

/** Result portraits stay fixed, including while the final voice caption arrives. */
export function selectResultRivalExpression(snapshot: Pick<MatchSnapshot, 'scores' | 'winner'>): RivalExpression {
  if (snapshot.winner === 'player') return 'disappointed';
  if (snapshot.winner === 'rival') return snapshot.scores.rival - snapshot.scores.player <= PAYOUT.bell ? 'relieved' : 'ecstatic';
  return 'wry-smile';
}
