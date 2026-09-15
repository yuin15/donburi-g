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
  /** Grants received while a reel is still spinning must also affect that reel's eventual total. */
  private readonly bonusAdjustments: Record<Side, Map<number, number>> = { player: new Map(), rival: new Map() };
  /** A recovery snapshot can replace an in-flight reel's authoritative total. */
  private readonly recoveredSpins: Record<Side, Map<number, SpinView>> = { player: new Map(), rival: new Map() };

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
    this.bonusAdjustments.player.clear();
    this.bonusAdjustments.rival.clear();
    this.recoveredSpins.player.clear();
    this.recoveredSpins.rival.clear();
  }

  syncPurchases(spent: number): void {
    const difference = spent - this.upgradeSpent;
    this.upgradeSpent = spent;
    this.scores = { ...this.scores, player: this.scores.player - difference };
  }

  syncMutualBonus(amount: number): void {
    for (const side of ['player', 'rival'] as const) {
      // A later spin has an authoritative total that already includes the
      // bonus. Only a reel which began before this grant needs an offset.
      if (this.latest[side] > this.revealed[side]) {
        const round = this.latest[side];
        this.scores = { ...this.scores, [side]: this.scores[side] + amount };
        this.bonusAdjustments[side].set(round, (this.bonusAdjustments[side].get(round) ?? 0) + amount);
      }
    }
  }

  /**
   * Reconcile a stream-gap recovery without treating the replayed reel as a
   * new spin. The snapshot total is authoritative, but its payout remains
   * hidden until the already-running reel stops.
   */
  syncRecoveredSpin(spin: SpinView): boolean {
    const { side, round } = spin;
    if (round !== this.latest[side] || round <= this.revealed[side]) return false;
    this.bonusAdjustments[side].delete(round);
    this.recoveredSpins[side].set(round, spin);
    this.scores = { ...this.scores, [side]: this.previewScore(spin) };
    return true;
  }

  spin(spin: SpinView): boolean {
    const { side, round } = spin;
    if (round <= this.latest[side] || this.didEnd) return false;
    this.latest[side] = round;
    this.scores = { ...this.scores, [side]: this.previewScore(spin) };
    const revision = this.revision;
    this.port.play(spin, (celebrate = true) => {
      if (revision !== this.revision || round !== this.latest[side] || round <= this.revealed[side]) return;
      this.revealed[side] = round;
      const recovered = this.recoveredSpins[side].get(round) ?? spin;
      this.scores = { ...this.scores, [side]: this.settledScore(recovered) };
      this.bonusAdjustments[side].delete(round);
      this.recoveredSpins[side].delete(round);
      this.port.settled(recovered, celebrate);
      this.flushResult();
    });
    return true;
  }

  private purchaseAdjustment(spin: SpinView): number {
    return spin.side === 'player' ? this.upgradeSpent - (spin.upgradeSpent ?? 0) : 0;
  }

  private bonusAdjustment(spin: SpinView): number {
    return this.bonusAdjustments[spin.side].get(spin.round) ?? 0;
  }

  private previewScore(spin: SpinView): number {
    return spin.total - spin.payout - this.purchaseAdjustment(spin) + this.bonusAdjustment(spin);
  }

  private settledScore(spin: SpinView): number {
    return spin.total - this.purchaseAdjustment(spin) + this.bonusAdjustment(spin);
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
