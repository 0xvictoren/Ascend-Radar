import { loadConfig } from '../config.ts';
import { RadarEngine } from '../core/engine.ts';
import type { Address } from '../core/types.ts';
import { simulate, type Scenario } from '../ingest/simulator.ts';

export interface BacktestResult {
  launches: number;
  rugs: number;
  caught: number;
  missed: number;
  falsePositives: number;
  honest: number;
  precision: number;
  recall: number;
  fpRate: number;
  medianLeadBlocks: number;
  byScenario: Record<string, { n: number; flagged: number }>;
}

/**
 * Replays labelled launches through the engine. A rug counts as caught only if
 * Radar rated it high-risk BEFORE the dump started; any high-risk rating of an
 * honest launch is a false positive.
 *
 * On simulated data this validates the pipeline, not real-world accuracy:
 * the headline number for judges must come from real HyperEVM/Elysium history.
 */
export function backtest(seed: number, launches: number): BacktestResult {
  const sim = simulate({ seed, launches });
  const cfg = loadConfig({ hubs: new Set(sim.hubs) });
  const engine = new RadarEngine(cfg);
  const firstFlag = new Map<Address, number>();
  engine.on('report', (r) => {
    if (r.level === 'high' && !firstFlag.has(r.token)) firstFlag.set(r.token, r.block);
  });
  for (const e of sim.events) engine.handle(e);

  let caught = 0;
  let missed = 0;
  let falsePositives = 0;
  const leads: number[] = [];
  const byScenario: Record<string, { n: number; flagged: number }> = {};
  for (const l of sim.labels) {
    const flag = firstFlag.get(l.token);
    const row = (byScenario[l.scenario as Scenario] ??= { n: 0, flagged: 0 });
    row.n++;
    if (l.rug) {
      if (flag !== undefined && l.rugBlock !== undefined && flag < l.rugBlock) {
        caught++;
        row.flagged++;
        leads.push(l.rugBlock - flag);
      } else missed++;
    } else if (flag !== undefined) {
      falsePositives++;
      row.flagged++;
    }
  }
  const rugs = caught + missed;
  const honest = sim.labels.length - rugs;
  leads.sort((a, b) => a - b);
  return {
    launches: sim.labels.length,
    rugs,
    caught,
    missed,
    falsePositives,
    honest,
    precision: caught + falsePositives ? caught / (caught + falsePositives) : 0,
    recall: rugs ? caught / rugs : 0,
    fpRate: honest ? falsePositives / honest : 0,
    medianLeadBlocks: leads.length ? leads[Math.floor(leads.length / 2)]! : 0,
    byScenario,
  };
}

if (import.meta.main) {
  const seed = Number(process.env.SIM_SEED ?? 7);
  const n = Number(process.argv[2] ?? 500);
  const r = backtest(seed, n);
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  console.log(`\nAscend Radar backtest (simulated, seed ${seed})`);
  console.log(`Launches ${r.launches} · rugs ${r.rugs} · honest ${r.honest}`);
  console.log(`Caught before dump: ${r.caught}/${r.rugs} (recall ${pct(r.recall)})`);
  console.log(`False positives:    ${r.falsePositives}/${r.honest} (FP rate ${pct(r.fpRate)}) · precision ${pct(r.precision)}`);
  console.log(`Median warning lead: ${r.medianLeadBlocks} blocks before the dump\n`);
  console.log('By scenario (flagged / total):');
  for (const [k, v] of Object.entries(r.byScenario)) console.log(`  ${k.padEnd(12)} ${String(v.flagged).padStart(4)} / ${v.n}`);
  console.log('\nNote: simulated data validates the pipeline only. Real accuracy needs HyperEVM/Elysium history.\n');
}
