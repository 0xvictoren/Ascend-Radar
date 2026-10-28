import type { Address } from '../core/types.ts';

export interface FundingEdge {
  from: Address;
  to: Address;
  asset: string;
  amount: number;
  block: number;
}

/** Who funded whom. Used to find wallets controlled by the same operator. */
export class FundingGraph {
  private incoming = new Map<Address, FundingEdge[]>();

  add(edge: FundingEdge): void {
    const list = this.incoming.get(edge.to);
    if (list) list.push(edge);
    else this.incoming.set(edge.to, [edge]);
  }

  fundersOf(wallet: Address, beforeBlock: number, lookback: number): FundingEdge[] {
    return (this.incoming.get(wallet) ?? []).filter(
      (e) => e.block <= beforeBlock && e.block >= beforeBlock - lookback,
    );
  }

  /**
   * Funding ancestors up to `depth` hops, skipping hubs (CEX hot wallets, bridges)
   * so that two strangers withdrawing from the same exchange are not linked.
   */
  ancestors(
    wallet: Address,
    beforeBlock: number,
    opts: { depth: number; lookback: number; hubs: Set<Address> },
  ): Set<Address> {
    const out = new Set<Address>();
    let frontier: Address[] = [wallet];
    for (let d = 0; d < opts.depth; d++) {
      const next: Address[] = [];
      for (const w of frontier) {
        for (const e of this.fundersOf(w, beforeBlock, opts.lookback)) {
          if (opts.hubs.has(e.from) || out.has(e.from) || e.from === wallet) continue;
          out.add(e.from);
          next.push(e.from);
        }
      }
      frontier = next;
    }
    return out;
  }
}
