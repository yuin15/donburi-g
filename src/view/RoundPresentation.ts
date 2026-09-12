import type { MatchSnapshot, SpinView } from '../../shared/protocol';

interface PresentationPort {
  play: (player: SpinView, rival: SpinView, stopped: (celebrate?: boolean) => void) => void;
  settled: (player: SpinView, rival: SpinView, celebrate: boolean) => void;
  ended: (snapshot: MatchSnapshot) => void;
}

/** One latest round, never a backlog of obsolete animations after a stalled tab. */
export class RoundPresentation {
  scores = { player: 0, rival: 0 };
  private latestRound = 0;
  private revealedRound = 0;
  private revision = 0;
  private result: MatchSnapshot | null = null;
  private didEnd = false;

  constructor(private readonly port: PresentationPort) {}

  reset(): void {
    this.revision += 1;
    this.latestRound = 0;
    this.revealedRound = 0;
    this.scores = { player: 0, rival: 0 };
    this.result = null;
    this.didEnd = false;
  }

  spin(player: SpinView, rival: SpinView): boolean {
    if (player.round !== rival.round || player.round <= this.latestRound || this.didEnd) return false;
    this.latestRound = player.round;
    const revision = this.revision;
    this.port.play(player, rival, (celebrate = true) => {
      if (revision !== this.revision || player.round !== this.latestRound || player.round <= this.revealedRound) return;
      this.revealedRound = player.round;
      // Both scores become visible together; no false lead change between sides.
      this.scores = { player: player.total, rival: rival.total };
      this.port.settled(player, rival, celebrate);
      this.flushResult();
    });
    return true;
  }

  end(snapshot: MatchSnapshot): void {
    this.result = snapshot;
    this.flushResult();
  }

  private flushResult(): void {
    if (!this.result || this.didEnd || this.revealedRound < this.result.round) return;
    this.didEnd = true;
    this.scores = { ...this.result.scores };
    this.port.ended(this.result);
  }
}
