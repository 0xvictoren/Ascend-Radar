import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.ts';
import { RadarEngine } from '../src/core/engine.ts';
import type { Address, ChainEvent } from '../src/core/types.ts';
import { backtest } from '../src/backtest/run.ts';
import { detectClusters } from '../src/risk/bundles.ts';
import { FundingGraph } from '../src/risk/funding-graph.ts';
import { scoreRisk, type RiskFeatures } from '../src/risk/score.ts';

const a = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address;
const HUB = a(999);
const DEV = a(1);
const TOKEN = a(500);

function clusterInput(graph: FundingGraph, buys: { wallet: Address; block: number; quote: number }[]) {
  return {
    earlyBuys: buys.map((b) => ({ wallet: b.wallet, block: b.block, quoteAmount: b.quote, tokenAmount: b.quote * 1000 })),
    deployer: DEV,
    devWallets: new Set<Address>(),
    tokenLinks: [] as [Address, Address][],
    balances: new Map(buys.map((b) => [b.wallet, b.quote * 1000])),
    totalSupply: 1_000_000,
    graph,
    depth: 2,
    lookback: 10_000,
    hubs: new Set([HUB]),
    sameBlockMinGroup: 3,
    sameBlockSizeTolerance: 0.15,
  };
}

describe('detectClusters', () => {
  it('links wallets with a shared funder two hops back', () => {
    const g = new FundingGraph();
    const master = a(10);
    const mid = a(11);
    g.add({ from: master, to: mid, asset: 'USDC', amount: 1, block: 1 });
    g.add({ from: mid, to: a(20), asset: 'USDC', amount: 1, block: 2 });
    g.add({ from: master, to: a(21), asset: 'USDC', amount: 1, block: 2 });
    const clusters = detectClusters(clusterInput(g, [
      { wallet: a(20), block: 100, quote: 50 },
      { wallet: a(21), block: 105, quote: 200 },
    ]));
    assert.equal(clusters.length, 1);
    assert.deepEqual(clusters[0]!.members.filter((m) => m === a(20) || m === a(21)).length, 2);
  });

  it('does not link wallets that only share an exchange hub', () => {
    const g = new FundingGraph();
    g.add({ from: HUB, to: a(20), asset: 'USDC', amount: 1, block: 1 });
    g.add({ from: HUB, to: a(21), asset: 'USDC', amount: 1, block: 1 });
    const clusters = detectClusters(clusterInput(g, [
      { wallet: a(20), block: 100, quote: 50 },
      { wallet: a(21), block: 101, quote: 300 },
    ]));
    assert.equal(clusters.length, 0);
  });

  it('marks clusters funded by the deployer as dev-linked', () => {
    const g = new FundingGraph();
    g.add({ from: DEV, to: a(20), asset: 'USDC', amount: 1, block: 1 });
    g.add({ from: DEV, to: a(21), asset: 'USDC', amount: 1, block: 1 });
    const [c] = detectClusters(clusterInput(g, [
      { wallet: a(20), block: 100, quote: 50 },
      { wallet: a(21), block: 101, quote: 300 },
    ]));
    assert.ok(c?.devLinked);
  });

  it('links 3+ near-identical buys in the same block', () => {
    const clusters = detectClusters(clusterInput(new FundingGraph(), [
      { wallet: a(20), block: 100, quote: 500 },
      { wallet: a(21), block: 100, quote: 510 },
      { wallet: a(22), block: 100, quote: 495 },
      { wallet: a(23), block: 100, quote: 2_000 },
    ]));
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0]!.members.includes(a(23)), false);
    assert.ok(clusters[0]!.links.includes('same-block equal-size buys'));
  });
});

describe('scoreRisk', () => {
  const cfg = loadConfig();
  const base: RiskFeatures = {
    clusters: [],
    top10Pct: 12,
    firstBlockPct: 3,
    devSoldShare: 0,
    uniqueHolders: 250,
    mcap: 50_000,
    volume: 20_000,
    role: 'deployer',
    listingReserveBps: 0,
    deployerPriorRugs: 0,
    ascended: false,
    drawdownPct: 0,
    rugged: false,
  };

  it('rates a clean launch low risk', () => {
    const r = scoreRisk(base, cfg);
    assert.equal(r.level, 'low');
  });

  it('rates a heavy dev-linked bundle high risk and explains why', () => {
    const r = scoreRisk({
      ...base,
      clusters: [{ id: 'x', members: [DEV, a(2), a(3)], links: ['funded by 0x0000…0001'], devLinked: true, heldPct: 35, boughtPct: 35 }],
    }, cfg);
    assert.equal(r.level, 'high');
    assert.ok(r.reasons.some((x) => x.id === 'dev_hidden_wallets'));
    assert.ok(!r.reasons.some((x) => x.id.startsWith('bundle')), 'dev-linked group must not be double-counted as a bundle');
    assert.ok(r.reasons.every((x) => x.detail.length > 0));
  });

  it('penalises serial deployers', () => {
    const r = scoreRisk({ ...base, deployerPriorRugs: 2 }, cfg);
    assert.ok(r.reasons.some((x) => x.id === 'serial_deployer'));
    assert.ok(r.score <= 75);
  });
});

describe('RadarEngine', () => {
  type NoTs<T> = T extends unknown ? Omit<T, 'ts'> : never;
  const ev = (e: NoTs<ChainEvent>): ChainEvent => ({ ...e, ts: 1_000 + e.block }) as ChainEvent;

  it('alerts when the dev sells and records the rug for the next launch', () => {
    const engine = new RadarEngine(loadConfig({ hubs: new Set([HUB]) }));
    const kinds: string[] = [];
    engine.on('alert', (x) => kinds.push(x.kind));
    engine.handle(ev({ kind: 'funding', from: a(77), to: DEV, asset: 'USDC', amount: 1, block: 1 }));
    engine.handle(ev({ kind: 'launch', token: TOKEN, symbol: 'RUG', name: 'Rug', deployer: DEV, pool: a(600), quote: 'USDC', totalSupply: 1_000_000, block: 10 }));
    engine.handle(ev({ kind: 'swap', token: TOKEN, trader: DEV, side: 'buy', tokenAmount: 300_000, quoteAmount: 3_000, block: 10 }));
    engine.handle(ev({ kind: 'swap', token: TOKEN, trader: a(30), side: 'buy', tokenAmount: 10_000, quoteAmount: 500, block: 50 }));
    engine.handle(ev({ kind: 'swap', token: TOKEN, trader: DEV, side: 'sell', tokenAmount: 300_000, quoteAmount: 200, block: 60 }));
    assert.ok(kinds.includes('new_pool'));
    assert.ok(kinds.includes('dev_sell'));
    assert.ok(kinds.includes('risk_high'));

    // New deployer funded by the same wallet that funded the rugger.
    const dev2 = a(2);
    engine.handle(ev({ kind: 'funding', from: a(77), to: dev2, asset: 'USDC', amount: 1, block: 70 }));
    engine.handle(ev({ kind: 'launch', token: a(501), symbol: 'AGAIN', name: 'Again', deployer: dev2, pool: a(601), quote: 'USDC', totalSupply: 1_000_000, block: 80 }));
    const r = engine.tokens.get(a(501))!.report!;
    assert.ok(r.reasons.some((x) => x.id === 'serial_deployer'));
  });

  it('treats wallets that receive tokens from the dev as dev wallets', () => {
    const engine = new RadarEngine(loadConfig());
    engine.handle(ev({ kind: 'launch', token: TOKEN, symbol: 'SLOW', name: 'Slow', deployer: DEV, pool: a(600), quote: 'USDC', totalSupply: 1_000_000, block: 10 }));
    engine.handle(ev({ kind: 'swap', token: TOKEN, trader: DEV, side: 'buy', tokenAmount: 200_000, quoteAmount: 2_000, block: 10 }));
    engine.handle(ev({ kind: 'transfer', token: TOKEN, from: DEV, to: a(40), amount: 200_000, block: 20 }));
    engine.handle(ev({ kind: 'swap', token: TOKEN, trader: a(40), side: 'sell', tokenAmount: 200_000, quoteAmount: 1_500, block: 30 }));
    const s = engine.tokens.get(TOKEN)!;
    assert.equal(engine.devSoldShare(s), 1);
  });
});

describe('backtest harness', () => {
  it('catches most rugs before the dump with few false positives (simulated)', () => {
    // regression guard on simulated data, not a claim about real-world accuracy
    const r = backtest(3, 300);
    assert.ok(r.recall >= 0.45, `recall ${r.recall}`);
    assert.ok(r.fpRate <= 0.05, `fp rate ${r.fpRate}`);
  });
});
