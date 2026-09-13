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
  /** Transfers received while a reel is still spinning must also affect that reel's eventual total. */
  private readonly loanAdjustments: Record<Side, Map<number, number>> = { player: new Map(), rival: new Map() };

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
    this.loanAdjustments.player.clear();
    this.loanAdjustments.rival.clear();
  }

  syncPurchases(spent: number): void {
    const difference = spent - this.upgradeSpent;
    this.upgradeSpent = spent;
    this.scores = { ...this.scores, player: this.scores.player - difference };
  }

  syncLoan(direction: 'rival_to_player' | 'player_to_rival', amount: number): void {
    const lender: Side = direction === 'rival_to_player' ? 'rival' : 'player';
    const borrower: Side = lender === 'rival' ? 'player' : 'rival';
    for (const [side, adjustment] of [[lender, -amount], [borrower, amount]] as const) {
      // A later spin has an authoritative total that already includes the
      // loan. Only a reel which began before this transfer needs an offset.
      if (this.latest[side] > this.revealed[side]) {
        const round = this.latest[side];
        this.scores = { ...this.scores, [side]: this.scores[side] + adjustment };
        this.loanAdjustments[side].set(round, (this.loanAdjustments[side].get(round) ?? 0) + adjustment);
      }
    }
  }

  spin(spin: SpinView): boolean {
    const { side, round } = spin;
    if (round <= this.latest[side] || this.didEnd) return false;
    this.latest[side] = round;
    const purchaseAdjustment = () => side === 'player' ? this.upgradeSpent - (spin.upgradeSpent ?? 0) : 0;
    const loanAdjustment = () => this.loanAdjustments[side].get(round) ?? 0;
    this.scores = { ...this.scores, [side]: spin.total - spin.payout - purchaseAdjustment() + loanAdjustment() };
    const revision = this.revision;
    this.port.play(spin, (celebrate = true) => {
      if (revision !== this.revision || round !== this.latest[side] || round <= this.revealed[side]) return;
      this.revealed[side] = round;
      this.scores = { ...this.scores, [side]: spin.total - purchaseAdjustment() + loanAdjustment() };
      this.loanAdjustments[side].delete(round);
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
