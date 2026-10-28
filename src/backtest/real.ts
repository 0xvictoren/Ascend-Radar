import { writeFileSync } from 'node:fs';
import { loadConfig, type RadarConfig } from '../config.ts';
import { RadarEngine } from '../core/engine.ts';
import type { Address, ChainEvent } from '../core/types.ts';
import { Store } from '../store/db.ts';

/**
 * Backtest on real indexed chain history (Elysium testnet today, mainnet later).
 *
 * Labels come only from explicit on-chain facts, never from Radar's own
 * clustering, so the test is not circular:
 *  - creator exit: the creator wallet named in `Launched` sold or moved out at
 *    least `exitShare` of the tokens it acquired (dev-buy, fee claims, buys).
 *    The dump starts at the creator's FIRST sell or outgoing transfer.
 *  - rug: creator exit AND the price fell >= `dropPct` below its pre-dump peak afterwards.
 *  - clean: the creator exited less than 20%. Everything else is ambiguous and excluded.
 * A rug is caught only if Radar rated the token high-risk before the dump's
 * first block. Any high-risk rating of a clean launch is a false positive.
 */

export interface RealBacktestOptions {
  minTrades: number;
  minBuyers: number;
  exitShare: number;
  dropPct: number;
  /** wallets whose launches are reported separately (e.g. Ascend's own test deployer) */
  team: Set<Address>;
}

interface TokenLabelState {
  token: Address;
  symbol: string;
  creator: Address;
  launchBlock: number;
  trades: number;
  buyers: Set<Address>;
  acquired: number;
  exited: number;
  firstExitBlock: number | null;
  peakBeforeExit: number;
  minAfterExit: number;
  lastPrice: number;
  peak: number;
}

export interface TokenRow {
  token: Address;
  symbol: string;
  creator: Address;
  team: boolean;
  label: 'rug' | 'clean' | 'ambiguous' | 'thin';
  trades: number;
  buyers: number;
  creatorExitPct: number;
  dropAfterExitPct: number;
  drawdownPct: number;
  dumpBlock: number | null;
  flagBlock: number | null;
  caught: boolean | null;
  flagReasons: string[];
}

export interface Metrics {
  rugs: number;
  caught: number;
  clean: number;
  falsePositives: number;
  recall: number;
  fpRate: number;
  precision: number;
  medianLeadSeconds: number;
}

export function realBacktest(events: Iterable<ChainEvent>, cfg: RadarConfig, opts: RealBacktestOptions) {
  const engine = new RadarEngine(cfg);
  const flags = new Map<Address, { block: number; ts: number; reasons: string[] }>();
  engine.on('report', (r) => {
    if (r.level === 'high' && !flags.has(r.token)) {
      flags.set(r.token, { block: r.block, ts: 0, reasons: r.reasons.filter((x) => x.impact < 0).map((x) => `${x.impact} ${x.detail}`) });
    }
  });

  const st = new Map<Address, TokenLabelState>();
  const blockTs = new Map<number, number>();
  const exit = (s: TokenLabelState, amount: number, block: number) => {
    if (s.firstExitBlock === null) s.firstExitBlock = block;
    s.exited += amount;
  };

  let n = 0;
  for (const e of events) {
    n++;
    engine.handle(e);
    blockTs.set(e.block, e.ts);
    if (e.kind === 'launch') {
      st.set(e.token, {
        token: e.token, symbol: e.symbol, creator: e.deployer, launchBlock: e.block, trades: 0, buyers: new Set(),
        acquired: 0, exited: 0, firstExitBlock: null, peakBeforeExit: 0, minAfterExit: Infinity, lastPrice: 0, peak: 0,
      });
      continue;
    }
    if (e.kind === 'swap') {
      const s = st.get(e.token);
      if (!s || e.tokenAmount <= 0) continue;
      const price = e.quoteAmount / e.tokenAmount;
      s.trades++;
      s.lastPrice = price;
      s.peak = Math.max(s.peak, price);
      if (e.trader === s.creator) {
        if (e.side === 'buy') s.acquired += e.tokenAmount;
        else exit(s, e.tokenAmount, e.block);
      } else if (e.side === 'buy') s.buyers.add(e.trader);
      if (s.firstExitBlock === null) s.peakBeforeExit = Math.max(s.peakBeforeExit, price);
      else s.minAfterExit = Math.min(s.minAfterExit, price);
    } else if (e.kind === 'transfer') {
      const s = st.get(e.token);
      if (!s) continue;
      if (e.from === s.creator) exit(s, e.amount, e.block);
      if (e.to === s.creator) s.acquired += e.amount;
    } else if (e.kind === 'feeClaim') {
      const s = st.get(e.token);
      if (s && e.by === s.creator) s.acquired += e.tokenAmount ?? 0;
    }
  }

  const rows: TokenRow[] = [];
  for (const s of st.values()) {
    const exitShare = s.acquired > 0 ? Math.min(1, s.exited / s.acquired) : 0;
    const min = s.minAfterExit === Infinity ? s.lastPrice : Math.min(s.minAfterExit, s.lastPrice);
    const drop = s.firstExitBlock !== null && s.peakBeforeExit > 0 ? 1 - min / s.peakBeforeExit : 0;
    const thin = s.trades < opts.minTrades || s.buyers.size < opts.minBuyers;
    const label: TokenRow['label'] = thin ? 'thin'
      : exitShare >= opts.exitShare && drop >= opts.dropPct ? 'rug'
      : exitShare < 0.2 ? 'clean'
      : 'ambiguous';
    const flag = flags.get(s.token);
    const caught = label === 'rug' ? flag !== undefined && flag.block < s.firstExitBlock! : label === 'clean' ? null : null;
    rows.push({
      token: s.token,
      symbol: s.symbol,
      creator: s.creator,
      team: opts.team.has(s.creator),
      label,
      trades: s.trades,
      buyers: s.buyers.size,
      creatorExitPct: exitShare * 100,
      dropAfterExitPct: drop * 100,
      drawdownPct: s.peak > 0 ? (1 - s.lastPrice / s.peak) * 100 : 0,
      dumpBlock: s.firstExitBlock,
      flagBlock: flag?.block ?? null,
      caught,
      flagReasons: flag?.reasons ?? [],
    });
  }

  const metrics = (subset: TokenRow[]): Metrics => {
    const rugs = subset.filter((r) => r.label === 'rug');
    const caughtRows = rugs.filter((r) => r.caught);
    const clean = subset.filter((r) => r.label === 'clean');
    const fps = clean.filter((r) => r.flagBlock !== null);
    const leads = caughtRows
      .map((r) => (blockTs.get(r.dumpBlock!) ?? 0) - (blockTs.get(r.flagBlock!) ?? 0))
      .filter((x) => x >= 0)
      .sort((a, b) => a - b);
    return {
      rugs: rugs.length,
      caught: caughtRows.length,
      clean: clean.length,
      falsePositives: fps.length,
      recall: rugs.length ? caughtRows.length / rugs.length : 0,
      fpRate: clean.length ? fps.length / clean.length : 0,
      precision: caughtRows.length + fps.length ? caughtRows.length / (caughtRows.length + fps.length) : 0,
      medianLeadSeconds: leads.length ? leads[Math.floor(leads.length / 2)]! : 0,
    };
  };

  return {
    events: n,
    launches: rows.length,
    counts: Object.fromEntries((['rug', 'clean', 'ambiguous', 'thin'] as const).map((l) => [l, rows.filter((r) => r.label === l).length])),
    all: metrics(rows),
    community: metrics(rows.filter((r) => !r.team)),
    team: metrics(rows.filter((r) => r.team)),
    rows,
  };
}

if (import.meta.main) {
  try {
    process.loadEnvFile();
  } catch {
    // no .env file
  }
  const store = new Store(process.env.DB_PATH ?? 'data/radar.db');
  if (!store.eventCount()) {
    console.error('No indexed events. Run `npm run sync` first.');
    process.exit(1);
  }
  const cfg = loadConfig({}, 'elysium');
  for (const h of store.get<Address[]>('elysium.hubs') ?? []) cfg.hubs.add(h);
  const team = new Set(((process.env.TEAM_DEPLOYERS ?? '0x5fa637713b819d6314e139291de2bfa7b7cd70eb').split(',')).map((s) => s.trim().toLowerCase() as Address));
  const r = realBacktest(store.events(), cfg, { minTrades: 10, minBuyers: 3, exitShare: 0.5, dropPct: 0.7, team });
  const cursor = store.get<{ block: number }>('elysium.cursor');
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const line = (name: string, m: Metrics) =>
    console.log(`  ${name.padEnd(28)} rugs caught ${String(m.caught).padStart(3)}/${String(m.rugs).padEnd(3)} (${pct(m.recall).padStart(6)}) · FP ${String(m.falsePositives).padStart(3)}/${String(m.clean).padEnd(3)} (${pct(m.fpRate).padStart(6)}) · precision ${pct(m.precision)} · median lead ${m.medianLeadSeconds}s`);

  console.log(`\nAscend Radar backtest: REAL Elysium testnet history (to block ${cursor?.block.toLocaleString() ?? '?'})`);
  console.log(`${r.events.toLocaleString()} events · ${r.launches} launches · labels: ${Object.entries(r.counts).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  console.log('(thin = fewer than 10 trades or 3 outside buyers; ambiguous = creator exited 20-50% or no price collapse)\n');
  line('All launches', r.all);
  line('Community launches', r.community);
  line('Ascend team test launches', r.team);
  console.log('\nTestnet caveat: mock USDC has no value and many launches are protocol tests, so incentives');
  console.log('differ from mainnet. Re-run on mainnet history before quoting these numbers as accuracy.\n');
  const out = process.env.BACKTEST_OUT ?? 'data/backtest-real.json';
  writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), cursor: cursor?.block, ...r }, null, 2));
  console.log(`Per-token rows: ${out}`);
  store.close();
}
