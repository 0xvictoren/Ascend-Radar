import type { Address, ChainEvent } from '../core/types.ts';

/**
 * Synthetic Ascend-style launches for development, demos and the backtest
 * harness until Elysium mainnet data exists. Tokens launch straight into a
 * USDC-quoted pool (no bonding curve), modelled here as a constant-product pool
 * with virtual USDC reserves.
 *
 * Scenarios include deliberately hard cases: "stealth" rugs whose wallets are
 * funded independently from exchanges (Radar should miss these), and honest
 * teams whose linked wallets never dump (Radar may flag these).
 */

export type Scenario = 'organic' | 'team' | 'bundle_rug' | 'dev_dump' | 'slow_rug' | 'stealth_rug';

export interface LaunchLabel {
  token: Address;
  symbol: string;
  scenario: Scenario;
  rug: boolean;
  launchBlock: number;
  /** first block of the dump, for rugs */
  rugBlock?: number;
}

export interface SimOutput {
  events: ChainEvent[];
  labels: LaunchLabel[];
  hubs: Address[];
}

export interface SimOptions {
  seed: number;
  launches: number;
  startBlock?: number;
  startTs?: number;
  /** blocks between consecutive launches (average) */
  launchSpacing?: number;
}

const SCENARIOS: [Scenario, number][] = [
  ['organic', 0.52],
  ['team', 0.08],
  ['bundle_rug', 0.15],
  ['dev_dump', 0.11],
  ['slow_rug', 0.08],
  ['stealth_rug', 0.06],
];

const SUPPLY = 1_000_000_000;
const VIRTUAL_USDC = 10_000;

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Intent {
  block: number;
  seq: number;
  trader: Address;
  /** buy: USDC amount; sell: fraction of current holdings */
  side: 'buy' | 'sell';
  value: number;
}

export function simulate(opts: SimOptions): SimOutput {
  const rnd = mulberry32(opts.seed);
  const startBlock = opts.startBlock ?? 1_000_000;
  const startTs = opts.startTs ?? 1_790_000_000;
  const spacing = opts.launchSpacing ?? 120;

  const between = (lo: number, hi: number) => lo + rnd() * (hi - lo);
  const int = (lo: number, hi: number) => Math.floor(between(lo, hi + 1));
  const chance = (p: number) => rnd() < p;
  const addr = (): Address => {
    let s = '0x';
    for (let i = 0; i < 40; i++) s += Math.floor(rnd() * 16).toString(16);
    return s as Address;
  };
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const lognormal = (median: number, sigma: number) => {
    const u = Math.max(1e-9, rnd());
    const v = rnd();
    return median * Math.exp(sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v));
  };

  const hubs = [addr(), addr(), addr()]; // exchange hot wallets / bridge
  const rugMasters = [addr(), addr(), addr(), addr()];

  const events: (ChainEvent & { seq: number })[] = [];
  const labels: LaunchLabel[] = [];
  let seq = 0;
  const ts = (block: number) => startTs + (block - startBlock);
  const push = (e: ChainEvent) => events.push({ ...e, seq: seq++ });
  const fund = (from: Address, to: Address, block: number, amount = between(50, 3000)) =>
    push({ kind: 'funding', from, to, asset: 'USDC', amount, block, ts: ts(block) });
  const fromHub = (to: Address, block: number) => fund(pick(hubs), to, block);

  for (const m of rugMasters) fromHub(m, startBlock - 50_000);

  let launchBlock = startBlock;
  for (let i = 0; i < opts.launches; i++) {
    launchBlock += int(Math.round(spacing * 0.3), Math.round(spacing * 1.7));
    const L = launchBlock;
    const scenario = weighted(SCENARIOS, rnd());
    const token = addr();
    const symbol = makeSymbol(rnd);
    const deployer = addr();
    const intents: Intent[] = [];
    const tokenTransfers: { block: number; from: Address; to: Address; share: number }[] = [];
    const buy = (trader: Address, block: number, usd: number) => intents.push({ block, seq: seq++, trader, side: 'buy', value: usd });
    const sell = (trader: Address, block: number, frac: number) => intents.push({ block, seq: seq++, trader, side: 'sell', value: frac });

    const isRug = scenario === 'bundle_rug' || scenario === 'dev_dump' || scenario === 'slow_rug' || scenario === 'stealth_rug';
    if (isRug && chance(0.6)) fund(pick(rugMasters), deployer, L - int(200, 20_000));
    else fromHub(deployer, L - int(200, 20_000));

    push({ kind: 'launch', token, symbol, name: `${symbol} Token`, deployer, pool: addr(), quote: 'USDC', totalSupply: SUPPLY, block: L, ts: ts(L) });

    // Organic flow exists in every scenario; rugs need exit liquidity.
    const life = int(600, 3600);
    const hype = isRug ? between(0.6, 1.6) : lognormal(1, 0.8);
    const organicN = Math.max(15, Math.round(int(40, 260) * hype));
    for (let k = 0; k < organicN; k++) {
      const w = addr();
      const b = L + Math.floor(Math.pow(rnd(), 1.6) * life) + 1;
      fromHub(w, b - int(30, 30_000));
      buy(w, b, Math.min(8_000, lognormal(120, 1.1)));
      if (chance(0.45)) sell(w, b + int(20, life), between(0.3, 1));
    }
    // Independent snipers in the launch block.
    for (let k = int(1, 4); k > 0; k--) {
      const w = addr();
      fromHub(w, L - int(50, 5_000));
      buy(w, L, between(150, 1_500));
      if (chance(0.6)) sell(w, L + int(5, 400), between(0.5, 1));
    }

    let rugBlock: number | undefined;
    switch (scenario) {
      case 'organic': {
        buy(deployer, L, between(50, 700));
        if (chance(0.3)) sell(deployer, L + int(300, life), between(0.1, 0.35));
        break;
      }
      case 'team': {
        buy(deployer, L, between(100, 600));
        for (let k = int(2, 4); k > 0; k--) {
          const w = addr();
          fund(deployer, w, L - int(10, 500), between(200, 800));
          buy(w, L + int(0, 2), between(150, 700));
          if (chance(0.3)) sell(w, L + int(600, life), between(0.05, 0.2));
        }
        break;
      }
      case 'bundle_rug': {
        const master = chance(0.5) ? deployer : addr();
        if (master !== deployer) {
          fromHub(master, L - int(1_000, 20_000));
          if (chance(0.7)) fund(master, deployer, L - int(100, 900));
        }
        const twoHop = chance(0.5);
        const mids = twoHop ? [addr(), addr()] : [master];
        if (twoHop) for (const m of mids) fund(master, m, L - int(600, 3_000));
        const size = between(300, 1_200);
        const wallets: Address[] = [];
        for (let k = int(5, 14); k > 0; k--) {
          const w = addr();
          wallets.push(w);
          fund(pick(mids), w, L - int(5, 500));
          buy(w, L + (chance(0.75) ? 0 : 1), size * between(0.92, 1.08));
        }
        buy(deployer, L, between(100, 800));
        rugBlock = L + int(120, 900);
        for (const w of wallets) sell(w, rugBlock + int(0, 6), 1);
        sell(deployer, rugBlock + int(0, 3), 1);
        break;
      }
      case 'dev_dump': {
        buy(deployer, L, between(2_000, 5_500));
        rugBlock = L + int(200, 1_500);
        sell(deployer, rugBlock, chance(0.5) ? 1 : 0.6);
        sell(deployer, rugBlock + int(2, 40), 1);
        break;
      }
      case 'slow_rug': {
        buy(deployer, L, between(1_500, 3_500));
        rugBlock = L + int(300, 900);
        const n = int(4, 8);
        for (let k = 0; k < n; k++) {
          const w = addr();
          tokenTransfers.push({ block: L + int(30, 250), from: deployer, to: w, share: 1 / (n - k) });
          sell(w, rugBlock + k * int(10, 120), 1);
        }
        break;
      }
      case 'stealth_rug': {
        buy(deployer, L, between(50, 300));
        rugBlock = L + int(300, 900);
        for (let k = int(5, 10); k > 0; k--) {
          const w = addr();
          fromHub(w, L - int(500, 40_000));
          const b = L + int(0, 15);
          buy(w, b, between(200, 1_800));
          sell(w, rugBlock + int(0, 30), 1);
        }
        break;
      }
    }

    // Ascend lifecycle signals: approved creators, listing reserves, Ascended, community takeovers.
    const at = (block: number) => ({ block, ts: ts(block) });
    if (!isRug && chance(0.25)) push({ kind: 'creatorRole', token, role: 'creator', operator: deployer, ...at(L + int(60, 600)) });
    if (!isRug && chance(0.3)) push({ kind: 'listingReserve', token, bps: pick([1_000, 2_000, 2_500, 5_000]), ...at(L + int(120, 900)) });
    if (!isRug && hype > 1.6 && chance(0.6)) push({ kind: 'stage', token, stage: 'ascended', ...at(L + Math.round(life * between(0.6, 0.95))) });
    if (rugBlock !== undefined && chance(0.15)) push({ kind: 'creatorRole', token, role: 'takeover', operator: addr(), ...at(rugBlock + int(600, 2_000)) });

    labels.push({ token, symbol, scenario, rug: isRug, launchBlock: L, ...(rugBlock !== undefined ? { rugBlock } : {}) });

    // Execute intents and token transfers in block order against the pool.
    let q = VIRTUAL_USDC;
    let t = SUPPLY;
    const kConst = q * t;
    const holdings = new Map<Address, number>();
    type Step = { block: number; seq: number; run: () => void };
    const steps: Step[] = intents.map((it) => ({
      block: it.block,
      seq: it.seq,
      run: () => {
        if (it.side === 'buy') {
          const out = t - kConst / (q + it.value);
          if (out <= 0) return;
          q += it.value;
          t -= out;
          holdings.set(it.trader, (holdings.get(it.trader) ?? 0) + out);
          push({ kind: 'swap', token, trader: it.trader, side: 'buy', tokenAmount: out, quoteAmount: it.value, block: it.block, ts: ts(it.block) });
        } else {
          const have = holdings.get(it.trader) ?? 0;
          const amt = have * Math.min(1, it.value);
          if (amt <= SUPPLY * 1e-9) return;
          const out = q - kConst / (t + amt);
          t += amt;
          q -= out;
          holdings.set(it.trader, have - amt);
          push({ kind: 'swap', token, trader: it.trader, side: 'sell', tokenAmount: amt, quoteAmount: out, block: it.block, ts: ts(it.block) });
        }
      },
    }));
    for (const tr of tokenTransfers) {
      steps.push({
        block: tr.block,
        seq: seq++,
        run: () => {
          const have = holdings.get(tr.from) ?? 0;
          const amt = have * tr.share;
          if (amt <= 0) return;
          holdings.set(tr.from, have - amt);
          holdings.set(tr.to, (holdings.get(tr.to) ?? 0) + amt);
          push({ kind: 'transfer', token, from: tr.from, to: tr.to, amount: amt, block: tr.block, ts: ts(tr.block) });
        },
      });
    }
    steps.sort((a, b) => a.block - b.block || a.seq - b.seq);
    for (const s of steps) s.run();
  }

  events.sort((a, b) => a.block - b.block || a.seq - b.seq);
  return { events: events.map(({ seq: _seq, ...e }) => e as ChainEvent), labels, hubs };
}

function weighted<T>(items: [T, number][], r: number): T {
  let acc = 0;
  for (const [item, w] of items) {
    acc += w;
    if (r < acc) return item;
  }
  return items[items.length - 1]![0];
}

const SYLLABLES = ['HY', 'PE', 'ZEN', 'KAI', 'MO', 'LUX', 'ORB', 'NEO', 'PUR', 'VAL', 'SKY', 'ELY', 'ASC', 'RA', 'TOR', 'FLO'];
function makeSymbol(rnd: () => number): string {
  const n = rnd() < 0.5 ? 2 : 3;
  let s = '';
  for (let i = 0; i < n; i++) s += SYLLABLES[Math.floor(rnd() * SYLLABLES.length)]!;
  return s.slice(0, 7);
}
