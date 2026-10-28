import type { RadarConfig } from '../config.ts';
import type { AscendedProgress, Cluster, CreatorRole, RiskLevel, RiskReason } from '../core/types.ts';

/** Everything the scorer needs, extracted from token state. Pure data so it is easy to test. */
export interface RiskFeatures {
  clusters: Cluster[];
  /** % of supply held by the top 10 wallets (pool excluded) */
  top10Pct: number;
  /** % of supply bought by non-dev wallets in the launch (snipe) window */
  firstBlockPct: number;
  /** share (0..1) of tokens acquired by dev-linked wallets that they have since sold */
  devSoldShare: number;
  uniqueHolders: number;
  mcap: number;
  volume: number;
  role: CreatorRole;
  listingReserveBps: number;
  /** earlier tokens by the same deployer (or its funders) that Radar marked as rugs */
  deployerPriorRugs: number;
  ascended: boolean;
  /** % below all-time-high price */
  drawdownPct: number;
  /** price collapsed while dev-linked wallets sold out */
  rugged: boolean;
}

const fmt = (n: number) => `${n.toFixed(1)}%`;
const int = (n: number) => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/**
 * Transparent weighted rules. Every point removed has a reason a buyer can read
 * and verify on-chain; there is deliberately no opaque model here.
 */
export function scoreRisk(f: RiskFeatures, cfg: RadarConfig): { score: number; level: RiskLevel; reasons: RiskReason[] } {
  const reasons: RiskReason[] = [];
  const add = (id: string, impact: number, detail: string) => reasons.push({ id, impact, detail });

  // dev-linked groups are scored once, under dev_holds / dev_sold, not again as bundles
  const bundles = f.clusters.filter((c) => c.members.length >= 2 && !c.devLinked);
  const bundleHeld = bundles.reduce((s, c) => s + c.heldPct, 0);
  const bundleBought = bundles.reduce((s, c) => s + c.boughtPct, 0);
  const devHeld = f.clusters.filter((c) => c.devLinked).reduce((s, c) => s + c.heldPct, 0);
  const biggest = bundles[0];

  if (bundleHeld >= 30) add('bundle_heavy', -35, `Linked wallets hold ${fmt(bundleHeld)} of supply`);
  else if (bundleHeld >= 15) add('bundle', -20, `Linked wallets hold ${fmt(bundleHeld)} of supply`);
  else if (bundleHeld >= 5) add('bundle_light', -8, `Linked wallets hold ${fmt(bundleHeld)} of supply`);
  else if (bundleBought >= 15) add('bundle_exited', -10, `Linked wallets bought ${fmt(bundleBought)} early and have mostly sold`);
  if (biggest && biggest.members.length >= 2 && bundleHeld >= 5) {
    reasons[reasons.length - 1]!.detail += ` (largest group: ${biggest.members.length} wallets, ${biggest.links[0] ?? 'linked'})`;
  }

  const devGroup = f.clusters.filter((c) => c.devLinked).reduce((n, c) => n + c.members.length, 0);
  const devDesc = (pct: number) => `Dev-linked wallets hold ${fmt(pct)}${devGroup > 1 ? ` across ${devGroup} wallets` : ''}`;
  if (devHeld >= 20) add('dev_holds', -40, devDesc(devHeld));
  else if (devHeld >= 12) add('dev_holds', -25, devDesc(devHeld));
  else if (devHeld >= 6) add('dev_holds', -10, devDesc(devHeld));
  // Splitting a dev position across hidden wallets is a separate, stronger signal than holding openly.
  const devBought = f.clusters.filter((c) => c.devLinked).reduce((s, c) => s + c.boughtPct, 0);
  if (devGroup >= 3 && devBought >= 12) {
    add('dev_hidden_wallets', -25, `Dev bought through ${devGroup - 1} linked wallets (${fmt(devBought)} of supply)`);
  }

  if (f.rugged) add('rugged', -60, `Rugged: price ${fmt(f.drawdownPct)} below peak after dev-linked wallets sold out`);
  if (f.devSoldShare >= 0.5) add('dev_sold', -40, `Dev-linked wallets sold ${fmt(f.devSoldShare * 100)} of their tokens`);
  else if (f.devSoldShare >= 0.2) add('dev_sold', -15, `Dev-linked wallets sold ${fmt(f.devSoldShare * 100)} of their tokens`);

  if (f.top10Pct >= 50) add('concentration', -20, `Top 10 wallets hold ${fmt(f.top10Pct)}`);
  else if (f.top10Pct >= 30) add('concentration', -10, `Top 10 wallets hold ${fmt(f.top10Pct)}`);

  if (f.firstBlockPct >= 20) add('sniped', -10, `${fmt(f.firstBlockPct)} of supply sniped at launch`);

  if (f.deployerPriorRugs > 0) {
    add('serial_deployer', -30, `Deployer is linked to ${f.deployerPriorRugs} earlier rug${f.deployerPriorRugs > 1 ? 's' : ''}`);
  }

  if (f.role === 'creator') add('approved_creator', 5, 'Ascend-approved active creator');
  if (f.role === 'takeover') add('takeover', 3, 'Community takeover approved by Ascend');
  if (f.listingReserveBps > 0) add('listing_reserve', 5, `Creator reserves ${(f.listingReserveBps / 100).toFixed(0)}% of fees for a HyperCore listing`);
  if (f.uniqueHolders >= 200) add('holders', 5, `${f.uniqueHolders} unique holders`);
  if (f.ascended) add('ascended', 10, 'Reached Ascended status');

  // Positive signals never offset a severe red flag: they are shown, but not counted.
  const severe = reasons.some((r) => r.impact <= -25);
  const total = reasons.reduce((s, r) => s + (severe && r.impact > 0 ? 0 : r.impact), 0);
  if (severe) for (const r of reasons) if (r.impact > 0) r.impact = 0;
  const score = Math.max(0, Math.min(100, 100 + total));
  const level: RiskLevel = score < cfg.highRiskBelow ? 'high' : score < cfg.cautionBelow ? 'caution' : 'low';
  reasons.sort((a, b) => a.impact - b.impact);
  return { score, level, reasons };
}

/**
 * Progress towards Ascend's "Ascended" status. The criteria names come from
 * Ascend's lifecycle docs; the thresholds are placeholders in config.
 */
export function ascendedProgress(f: RiskFeatures, cfg: RadarConfig): AscendedProgress {
  const t = cfg.ascended;
  const coordinated = f.clusters.filter((c) => c.members.length >= 2 || c.devLinked).reduce((s, c) => s + c.heldPct, 0);
  const criteria = [
    { id: 'mcap', label: 'Market cap', value: f.mcap, target: t.minMcap, met: f.mcap >= t.minMcap },
    { id: 'holders', label: 'Unique holders', value: f.uniqueHolders, target: t.minHolders, met: f.uniqueHolders >= t.minHolders },
    { id: 'volume', label: 'Volume', value: f.volume, target: t.minVolume, met: f.volume >= t.minVolume },
    {
      id: 'coordinated',
      label: 'Coordinated holdings (max)',
      value: coordinated,
      target: t.maxCoordinatedPct,
      met: coordinated <= t.maxCoordinatedPct,
    },
  ];
  const partial = criteria.map((c) =>
    c.id === 'coordinated'
      ? c.met ? 1 : Math.max(0, 1 - (c.value - c.target) / Math.max(c.target, 1))
      : Math.min(1, c.value / c.target),
  );
  const likelihood = f.ascended ? 100 : Math.round((partial.reduce((s, p) => s + p, 0) / criteria.length) * 100);
  const blockers = criteria.filter((c) => !c.met).map((c) =>
    c.id === 'coordinated'
      ? `Coordinated wallets hold ${c.value.toFixed(1)}% (max ${c.target}%)`
      : `${c.label} ${int(c.value)} / ${int(c.target)}`,
  );
  return { likelihood, criteria, blockers };
}
