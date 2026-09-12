import type { Side, UpgradeId } from '../../shared/protocol';
import { submitUpgrade, type MatchState } from '../domain/game';

/** Use input time, not the last (possibly throttled) render timer tick. */
export function submitCpuUpgrade(
  state: MatchState,
  side: Side,
  offerIndex: 0 | 1,
  upgradeId: UpgradeId,
  startedAt: number,
): boolean {
  return submitUpgrade(state, side, offerIndex, upgradeId, (performance.now() - startedAt) / 1000);
}
