import type { SpinView } from '../../shared/protocol';
import { PAYOUT } from '../domain/game';

export type RivalReactionKind =
  | 'both-jackpot' | 'player-jackpot' | 'rival-jackpot'
  | 'player-lead' | 'rival-lead' | 'both-win' | 'player-win' | 'rival-win'
  | 'close-finish' | 'quiet';

export interface RivalReaction {
  kind: RivalReactionKind;
  text: string;
  expression: 'neutral' | 'confident' | 'surprised' | 'frustrated';
}

const SCENES: Record<RivalReactionKind, {
  expression: RivalReaction['expression'];
  lines: readonly string[];
}> = {
  'both-jackpot': {
    expression: 'surprised',
    lines: ['ふたりとも7揃い！？ こんなことある？', '1,200点ずつ！ お互い、引かないね。', '同時に大当たり。これは熱いね！'],
  },
  'player-jackpot': {
    expression: 'surprised',
    lines: ['えっ、そこで7揃い！？', '1,200点！？ その一発は大きい！', 'ちょっと待って、その7揃いは強い！'],
  },
  'rival-jackpot': {
    expression: 'confident',
    lines: ['来た、7揃い！ 1,200点いただき。', '私にも7揃い。うれしい！', 'この大当たりは大きいね！'],
  },
  'player-lead': {
    expression: 'frustrated',
    lines: ['抜かれた！ その当たりは効くね。', 'そっちが前に出たね。手強いな。', '逆転された！ いい勝負だね。'],
  },
  'rival-lead': {
    expression: 'confident',
    lines: ['よし、私が前に出た！', 'ここで逆転！ この当たりはうれしい。'],
  },
  'both-win': {
    expression: 'surprised',
    lines: ['ふたりとも当たり！', 'お互いにコイン獲得。いい勝負だね。'],
  },
  'player-win': {
    expression: 'surprised',
    lines: ['当てたね。そのコイン、見逃してないよ。', 'そっちに当たり！ なかなかやるね。'],
  },
  'rival-win': {
    expression: 'confident',
    lines: ['私に当たり！ コインを積めた。', 'よし、こっちもコイン獲得。'],
  },
  'close-finish': {
    expression: 'neutral',
    lines: ['この点差、最後まで分からないね。', '接戦だね。一回の当たりも見逃せない。', '僅差の終盤。思わず見ちゃうね。'],
  },
  quiet: {
    expression: 'neutral',
    lines: ['今回は、お互い空振りだね。', 'ふたりともおあずけ。この間も緊張するね。'],
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
    const kind = selectKind(player, rival, remaining, comeback);
    const scene = SCENES[kind];
    const variant = this.variants.get(kind) ?? 0;
    this.variants.set(kind, (variant + 1) % scene.lines.length);
    return { kind, text: scene.lines[variant], expression: scene.expression };
  }
}
