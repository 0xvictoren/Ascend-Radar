import type { Address } from './core/types.ts';

function num(name: string, fallback: number): number {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : Number(v);
}

export interface RadarConfig {
  /** blocks after launch whose buyers count as "early" for bundle detection */
  earlyWindowBlocks: number;
  /** buys within this many blocks of the launch count as sniped (0 = launch block only) */
  snipeWindowBlocks: number;
  /** buys landing within the same bucket of this many blocks count as "same block" */
  sameBlockWindow: number;
  /** cap on early buyers analysed per token */
  earlyBuyerLimit: number;
  /** how far back a funding edge may be to link wallets */
  fundingLookbackBlocks: number;
  /** funding-graph depth when searching for shared funders */
  fundingDepth: number;
  sameBlockMinGroup: number;
  /** relative size tolerance for same-block buys to count as coordinated */
  sameBlockSizeTolerance: number;
  whaleBuyQuote: number;
  /** alert when dev-linked wallets sell at least this share of what they acquired */
  devSellAlertPct: number;
  highRiskBelow: number;
  cautionBelow: number;
  /**
   * Ascend's docs name the Ascended criteria (market cap, unique holders, volume,
   * no concentrated/coordinated accumulation) but not the thresholds yet.
   * These are placeholders until Ascend publishes them.
   */
  ascended: { minMcap: number; minHolders: number; minVolume: number; maxCoordinatedPct: number };
  /** CEXes, bridges, routers: shared funding from these never links wallets */
  hubs: Set<Address>;
}

/**
 * Block-denominated defaults per chain. The simulator uses ~1 s blocks; Elysium
 * produces a block every ~240 ms, so the same wall-clock windows need 4x the blocks.
 */
export type Profile = 'sim' | 'elysium';
const PROFILES: Record<Profile, { early: number; snipe: number; sameBlock: number; lookback: number }> = {
  sim: { early: 20, snipe: 0, sameBlock: 1, lookback: 200_000 },
  // 10 min early window; 5 s snipe window (Ascend's sniper fee decays from 90% to 1% over 5 s);
  // 2 s "same block" bucket; 30 days of funding history
  elysium: { early: 2_400, snipe: 20, sameBlock: 8, lookback: 30 * 86_400 * 4 },
};

export function loadConfig(overrides: Partial<RadarConfig> = {}, profile: Profile = 'sim'): RadarConfig {
  const p = PROFILES[profile];
  return {
    earlyWindowBlocks: num('EARLY_WINDOW_BLOCKS', p.early),
    snipeWindowBlocks: num('SNIPE_WINDOW_BLOCKS', p.snipe),
    sameBlockWindow: num('SAME_BLOCK_WINDOW', p.sameBlock),
    earlyBuyerLimit: num('EARLY_BUYER_LIMIT', 60),
    fundingLookbackBlocks: num('FUNDING_LOOKBACK_BLOCKS', p.lookback),
    fundingDepth: 2,
    sameBlockMinGroup: 3,
    sameBlockSizeTolerance: 0.15,
    whaleBuyQuote: num('WHALE_BUY_USDC', 5_000),
    devSellAlertPct: 0.2,
    highRiskBelow: 40,
    cautionBelow: 70,
    ascended: { minMcap: 250_000, minHolders: 300, minVolume: 100_000, maxCoordinatedPct: 10 },
    hubs: new Set(
      (process.env.HUB_ADDRESSES ?? '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean) as Address[],
    ),
    ...overrides,
  };
}
