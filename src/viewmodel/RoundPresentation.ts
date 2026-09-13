import type { MatchSnapshot, Side, SpinView } from '../../shared/protocol';

interface PresentationPort {
  play: (spin: SpinView, stopped: (celebrate?: boolean) => void) => void;
  settled: (spin: SpinView, celebrate: boolean) => void;
  ended: (snapshot: MatchSnapshot) => void;
}

/** Each side owns its animation and score. A result waits for both final stops. */
export class RoundPresentation {
  scores = { player: 0, rival: 0 };
  private latest: Record<Side, number> = { player: 0, rival: 0 };
  private revealed: Record<Side, number> = { player: 0, rival: 0 };
  private revision = 0;
  private result: MatchSnapshot | null = null;
  private didEnd = false;
  private upgradeSpent = 0;

  constructor(private readonly port: PresentationPort) {}

  get isSettled(): boolean {
    return this.revealed.player >= this.latest.player && this.revealed.rival >= this.latest.rival;
  }

  reset(scores: Record<Side, number> = { player: 0, rival: 0 }): void {
    this.revision += 1;
    this.latest = { player: 0, rival: 0 };
    this.revealed = { player: 0, rival: 0 };
    this.scores = { ...scores };
    this.result = null;
    this.didEnd = false;
    this.upgradeSpent = 0;
  }

  syncPurchases(spent: number): void {
    const difference = spent - this.upgradeSpent;
    this.upgradeSpent = spent;
    this.scores = { ...this.scores, player: this.scores.player - difference };
  }

  spin(spin: SpinView): boolean {
    const { side, round } = spin;
    if (round <= this.latest[side] || this.didEnd) return false;
    this.latest[side] = round;
    const purchaseAdjustment = () => side === 'player' ? this.upgradeSpent - (spin.upgradeSpent ?? 0) : 0;
    this.scores = { ...this.scores, [side]: spin.total - spin.payout - purchaseAdjustment() };
    const revision = this.revision;
    this.port.play(spin, (celebrate = true) => {
      if (revision !== this.revision || round !== this.latest[side] || round <= this.revealed[side]) return;
      this.revealed[side] = round;
      this.scores = { ...this.scores, [side]: spin.total - purchaseAdjustment() };
      this.port.settled(spin, celebrate);
      this.flushResult();
    });
    return true;
  }

  end(snapshot: MatchSnapshot): void {
    this.result = snapshot;
    this.flushResult();
  }

  private flushResult(): void {
    if (!this.result || this.didEnd || (['player', 'rival'] as const).some(side => this.revealed[side] < this.result!.rounds[side])) return;
    this.didEnd = true;
    this.scores = { ...this.result.scores };
    this.port.ended(this.result);
  }
}
