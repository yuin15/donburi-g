import type { Side, SpinView } from '../../shared/protocol';
import { PAYOUT } from '../domain/game';
import type { RivalExpression } from './RivalExpressions';

export type RivalReactionKind =
  | 'both-jackpot' | 'player-jackpot' | 'rival-jackpot'
  | 'player-lead' | 'rival-lead' | 'both-win' | 'player-win' | 'rival-win'
  | 'close-finish' | 'quiet' | 'player-miss' | 'rival-miss';

export interface RivalReaction {
  kind: RivalReactionKind;
  text: string;
  expression: RivalExpression;
}

const SCENES: Record<RivalReactionKind, {
  expression: RivalReaction['expression'];
  alternateExpression?: RivalReaction['expression'];
  lines: readonly string[];
}> = {
  'both-jackpot': {
    expression: 'surprised',
    lines: ["Both of us hit sevens?!","Sevens on both reels! What a round!","Two big wins at once!"],
  },
  'player-jackpot': {
    expression: 'stunned',
    lines: ["Whoa! Three sevens?!","That changes things.","Now THAT is a big win!"],
  },
  'rival-jackpot': {
    expression: 'ecstatic',
    lines: ["Sevens for me!","Big win! I'll take that.","Three sevens. Nice!"],
  },
  'player-lead': {
    expression: 'frustrated',
    lines: ["You took the lead!","You're ahead now. Game on!","That hit put you in front."],
  },
  'rival-lead': {
    expression: 'teasing',
    lines: ["I'm in the lead!","That hit put me ahead."],
  },
  'both-win': {
    expression: 'surprised',
    lines: ["Coins for both of us!","We both hit. What a race!"],
  },
  'player-win': {
    expression: 'surprised',
    lines: ["Nice hit. I saw that!","Coins for you! Well played."],
  },
  'rival-win': {
    expression: 'happy',
    alternateExpression: 'wink',
    lines: ["A hit! Coins for me.","Nice. I'll take those coins."],
  },
  'close-finish': {
    expression: 'tense',
    lines: ["Still close. Every spin counts.","This could go either way.","A tight finish. Keep going!"],
  },
  quiet: {
    expression: 'wry-smile',
    lines: ["No hits that time. Next spin!","Nothing yet. Still time!"],
  },
  'player-miss': {
    expression: 'wry-smile',
    lines: ["So close. Try another!","Not this time. Keep spinning."],
  },
  'rival-miss': {
    expression: 'disappointed',
    lines: ["Ah, just missed it!","I'm going again. Watch me."],
  },
};

function selectKind(
  player: SpinView,
  rival: SpinView,
  remaining: number,
  comeback: 'player' | 'rival' | null,
): RivalReactionKind {
  const playerJackpot = player.payout >= PAYOUT.seven;
  const rivalJackpot = rival.payout >= PAYOUT.seven;
  if (playerJackpot && rivalJackpot) return 'both-jackpot';
  if (rivalJackpot) return 'rival-jackpot';
  if (playerJackpot) return 'player-jackpot';
  if (comeback) return comeback === 'player' ? 'player-lead' : 'rival-lead';
  if (player.payout > 0 && rival.payout > 0) return 'both-win';
  if (player.payout > 0) return 'player-win';
  if (rival.payout > 0) return 'rival-win';
  if (remaining > 0 && remaining <= 10 && Math.abs(player.total - rival.total) <= PAYOUT.bell) return 'close-finish';
  return 'quiet';
}

/** CPU-only commentary on confirmed rounds. It never predicts or alters an outcome. */
export class RivalReactions {
  private variants = new Map<RivalReactionKind, number>();

  reset(): void {
    this.variants.clear();
  }

  next(player: SpinView, rival: SpinView, remaining: number, comeback: 'player' | 'rival' | null): RivalReaction {
    return this.select(selectKind(player, rival, remaining, comeback));
  }

  nextSpin(spin: SpinView, scores: Record<Side, number>, remaining: number, comeback: Side | null): RivalReaction {
    const otherSide = spin.side === 'player' ? 'rival' : 'player';
    // Only this stop can announce a payout; never repeat the other side's previous hit.
    const other: SpinView = { ...spin, side: otherSide, payout: 0, total: scores[otherSide] };
    const kind = spin.side === 'player' ? selectKind(spin, other, remaining, comeback) : selectKind(other, spin, remaining, comeback);
    return this.select(kind === 'quiet' ? spin.side === 'player' ? 'player-miss' : 'rival-miss' : kind);
  }

  private select(kind: RivalReactionKind): RivalReaction {
    const scene = SCENES[kind];
    const variant = this.variants.get(kind) ?? 0;
    this.variants.set(kind, (variant + 1) % scene.lines.length);
    return { kind, text: scene.lines[variant], expression: variant % 2 && scene.alternateExpression ? scene.alternateExpression : scene.expression };
  }
}
