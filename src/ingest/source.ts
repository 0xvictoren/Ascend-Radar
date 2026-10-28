import type { ChainEvent } from '../core/types.ts';
import { simulate } from './simulator.ts';

/** Anything that can feed the engine: the simulator now, the Elysium adapter later. */
export interface DataSource {
  name: string;
  /** exchange / bridge hot wallets this source knows about */
  hubs: string[];
  start(emit: (e: ChainEvent) => void): void;
  stop(): void;
  head(): { block: number; ts: number };
}

/**
 * Plays simulated launches at `speed` blocks per second. The first
 * `prefillLaunches` are replayed instantly so the terminal has history on boot.
 */
export function simulatedSource(opts: { seed: number; speed: number; launches?: number; prefillLaunches?: number }): DataSource {
  const sim = simulate({ seed: opts.seed, launches: opts.launches ?? 400, launchSpacing: 90 });
  const prefillUntil = sim.labels[opts.prefillLaunches ?? 25]?.launchBlock ?? 0;
  let timer: NodeJS.Timeout | undefined;
  let i = 0;
  let headBlock = sim.events[0]?.block ?? 0;
  let headTs = sim.events[0]?.ts ?? 0;

  return {
    name: `simulator(seed=${opts.seed})`,
    hubs: sim.hubs,
    start(emit) {
      const play = (untilBlock: number) => {
        while (i < sim.events.length && sim.events[i]!.block <= untilBlock) {
          const e = sim.events[i++]!;
          headBlock = e.block;
          headTs = e.ts;
          emit(e);
        }
      };
      play(prefillUntil);
      let cursor = prefillUntil;
      const TICK_MS = 250;
      timer = setInterval(() => {
        cursor += (opts.speed * TICK_MS) / 1000;
        play(Math.floor(cursor));
        headBlock = Math.max(headBlock, Math.floor(cursor));
        if (i >= sim.events.length) clearInterval(timer);
      }, TICK_MS);
    },
    stop() {
      clearInterval(timer);
    },
    head: () => ({ block: headBlock, ts: headTs }),
  };
}
