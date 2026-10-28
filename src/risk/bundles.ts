import type { Address, Cluster } from '../core/types.ts';
import type { FundingGraph } from './funding-graph.ts';

export interface EarlyBuy {
  wallet: Address;
  block: number;
  tokenAmount: number;
  quoteAmount: number;
}

export interface ClusterInput {
  earlyBuys: EarlyBuy[];
  deployer: Address;
  /** extra wallets known to belong to the dev (operator, token-transfer recipients) */
  devWallets: Set<Address>;
  /** wallet pairs linked by direct token transfers */
  tokenLinks: [Address, Address][];
  balances: Map<Address, number>;
  totalSupply: number;
  graph: FundingGraph;
  depth: number;
  lookback: number;
  hubs: Set<Address>;
  sameBlockMinGroup: number;
  /** bucket size in blocks; 1 = literally the same block */
  sameBlockWindow?: number;
  sameBlockSizeTolerance: number;
}

class UnionFind {
  private parent = new Map<Address, Address>();
  find(a: Address): Address {
    let p = this.parent.get(a) ?? a;
    if (p !== a) {
      p = this.find(p);
      this.parent.set(a, p);
    }
    return p;
  }
  union(a: Address, b: Address): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/**
 * Groups early buyers that are likely one operator:
 *  - direct funding between them, or a shared non-hub funder within `depth` hops
 *  - direct token transfers between them
 *  - 3+ near-identical buys landing in the same block
 * A cluster is dev-linked if it touches the deployer or any known dev wallet.
 */
export function detectClusters(input: ClusterInput): Cluster[] {
  const uf = new UnionFind();
  const linkReasons = new Map<Address, Set<string>>();
  const note = (a: Address, b: Address, why: string) => {
    uf.union(a, b);
    for (const w of [a, b]) {
      const s = linkReasons.get(w) ?? new Set<string>();
      s.add(why);
      linkReasons.set(w, s);
    }
  };

  const buyers = [...new Set(input.earlyBuys.map((b) => b.wallet))];
  const firstBuyBlock = new Map<Address, number>();
  for (const b of input.earlyBuys) {
    if (!firstBuyBlock.has(b.wallet)) firstBuyBlock.set(b.wallet, b.block);
  }

  // Shared funders / direct funding. The deployer and dev wallets are included
  // as nodes so that "dev funded the bundle" links them.
  const nodes = new Set<Address>([...buyers, input.deployer, ...input.devWallets]);
  const byAncestor = new Map<Address, Address[]>();
  for (const w of nodes) {
    const at = firstBuyBlock.get(w) ?? Number.MAX_SAFE_INTEGER;
    const anc = input.graph.ancestors(w, at, {
      depth: input.depth,
      lookback: input.lookback,
      hubs: input.hubs,
    });
    for (const a of anc) {
      if (nodes.has(a)) note(w, a, `funded by ${short(a)}`);
      const list = byAncestor.get(a);
      if (list) list.push(w);
      else byAncestor.set(a, [w]);
    }
  }
  for (const [ancestor, members] of byAncestor) {
    const [first, ...rest] = members;
    if (!first) continue;
    for (const m of rest) note(first, m, `shared funder ${short(ancestor)}`);
  }

  for (const [a, b] of input.tokenLinks) {
    if (nodes.has(a) || nodes.has(b)) {
      nodes.add(a);
      nodes.add(b);
      note(a, b, 'token transfer between wallets');
    }
  }

  // Same-block (or same short window, on fast chains), near-identical buys.
  const window = Math.max(1, input.sameBlockWindow ?? 1);
  const byBlock = new Map<number, EarlyBuy[]>();
  for (const b of input.earlyBuys) {
    const bucket = Math.floor(b.block / window);
    const list = byBlock.get(bucket);
    if (list) list.push(b);
    else byBlock.set(bucket, [b]);
  }
  for (const group of byBlock.values()) {
    if (group.length < input.sameBlockMinGroup) continue;
    const sorted = [...group].sort((x, y) => x.quoteAmount - y.quoteAmount);
    // sliding window of buys within tolerance of each other
    let start = 0;
    for (let end = 0; end < sorted.length; end++) {
      while (sorted[end]!.quoteAmount > sorted[start]!.quoteAmount * (1 + input.sameBlockSizeTolerance)) start++;
      if (end - start + 1 >= input.sameBlockMinGroup) {
        for (let i = start; i < end; i++) note(sorted[i]!.wallet, sorted[end]!.wallet, 'same-block equal-size buys');
      }
    }
  }

  const devSet = new Set<Address>([input.deployer, ...input.devWallets]);
  const groups = new Map<Address, Address[]>();
  for (const w of nodes) {
    const root = uf.find(w);
    const list = groups.get(root);
    if (list) list.push(w);
    else groups.set(root, [w]);
  }

  const boughtBy = new Map<Address, number>();
  for (const b of input.earlyBuys) boughtBy.set(b.wallet, (boughtBy.get(b.wallet) ?? 0) + b.tokenAmount);

  const clusters: Cluster[] = [];
  for (const members of groups.values()) {
    const devLinked = members.some((m) => devSet.has(m));
    const buyerMembers = members.filter((m) => boughtBy.has(m) || devSet.has(m));
    // A cluster matters if it is 2+ linked buyers, or any dev-linked group that bought.
    if (buyerMembers.length < 2 && !(devLinked && buyerMembers.some((m) => boughtBy.has(m)))) continue;
    const held = members.reduce((s, m) => s + (input.balances.get(m) ?? 0), 0);
    const bought = members.reduce((s, m) => s + (boughtBy.get(m) ?? 0), 0);
    const links = new Set<string>();
    for (const m of members) for (const r of linkReasons.get(m) ?? []) links.add(r);
    clusters.push({
      id: uf.find(members[0]!),
      members: members.sort(),
      links: [...links].slice(0, 6),
      devLinked,
      heldPct: (held / input.totalSupply) * 100,
      boughtPct: (bought / input.totalSupply) * 100,
    });
  }
  return clusters.sort((a, b) => b.boughtPct - a.boughtPct);
}
