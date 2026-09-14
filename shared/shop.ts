import type { UpgradeId } from './protocol.js';

export const UPGRADE_PRICES = [15, 15, 15] as const;
export function upgradePrice(upgrades: readonly UpgradeId[], id: UpgradeId): number | null {
  return UPGRADE_PRICES[upgrades.filter(value => value === id).length] ?? null;
}
