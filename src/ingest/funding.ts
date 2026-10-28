import { units } from '../chain/abi.ts';
import type { Blockscout } from '../chain/blockscout.ts';
import type { Address, EventOf } from '../core/types.ts';
import type { Store } from '../store/db.ts';

type FundingEvent = EventOf<'funding'>;

export interface FundingOptions {
  /** ERC-20s that count as funding (the launch quotes, i.e. USDC) */
  quoteTokens: Set<string>;
  /** protocol contracts (pool managers, vaults, launchpads): never funders */
  infra: Set<string>;
  /** a funder with at least this many transactions is a hub (faucet, bridge, exchange) */
  hubTxThreshold: number;
  /** explorer pages read per wallet and kind (50 rows each) */
  maxPages: number;
  /** funding hops resolved behind each wallet */
  depth: number;
}

interface CachedFunding {
  edges: FundingEvent[];
  /** funder -> is a contract (from the explorer's own flag) */
  contracts: Record<string, boolean>;
}

const ZERO = '0x0000000000000000000000000000000000000000';
const lc = (a: string) => a.toLowerCase() as Address;
const ts = (iso: unknown) => (typeof iso === 'string' ? Math.floor(Date.parse(iso) / 1000) : 0);

/**
 * Resolves who funded a wallet with HYPE (gas) or USDC, from the explorer, and
 * which funders are hubs. Hubs (faucets, bridges, exchange hot wallets,
 * contracts) are reported so the engine never links wallets through them: on
 * a testnet, almost every wallet shares the faucet as a funder.
 *
 * Results are cached in the store, so re-syncs and backtests do not hit the
 * explorer again and stay reproducible.
 */
export class FundingResolver {
  readonly hubs = new Set<Address>();
  private done = new Set<Address>();

  private readonly bs: Blockscout;
  private readonly store: Store;
  private readonly opts: FundingOptions;

  constructor(bs: Blockscout, store: Store, opts: FundingOptions) {
    this.bs = bs;
    this.store = store;
    this.opts = opts;
  }

  /** wallets whose funding is already in the event log (e.g. replayed from the store) */
  markDone(wallets: Iterable<Address>): void {
    for (const w of wallets) this.done.add(w);
  }

  /** Funding edges into `wallets` (and their non-hub funders, up to `depth` hops) not emitted before. */
  async resolve(wallets: Iterable<Address>): Promise<{ events: FundingEvent[]; newHubs: Address[] }> {
    const events: FundingEvent[] = [];
    const newHubs: Address[] = [];
    let frontier = [...new Set(wallets)].filter((w) => !this.done.has(w));
    for (let d = 0; d < this.opts.depth && frontier.length; d++) {
      const next = new Set<Address>();
      const results = await Promise.all(frontier.map((w) => this.fundingOf(w)));
      for (const [i, w] of frontier.entries()) {
        this.done.add(w);
        const r = results[i]!;
        const funders = [...new Set(r.edges.map((e) => e.from))];
        const hubFlags = await Promise.all(funders.map((f) => this.isHub(f, r.contracts[f] ?? false)));
        for (const [k, f] of funders.entries()) {
          if (hubFlags[k]) {
            if (!this.hubs.has(f)) {
              this.hubs.add(f);
              newHubs.push(f);
            }
          } else if (!this.done.has(f)) next.add(f);
        }
        events.push(...r.edges);
      }
      frontier = [...next];
    }
    events.sort((a, b) => a.block - b.block);
    return { events, newHubs };
  }

  private async fundingOf(wallet: Address): Promise<CachedFunding> {
    const key = `funding:v1:${wallet}`;
    const hit = this.store.cached<CachedFunding>(key);
    if (hit) return hit;

    const { quoteTokens, infra, maxPages } = this.opts;
    const [txs, internal, transfers] = await Promise.all([
      this.bs.incomingTxs(wallet, maxPages),
      this.bs.incomingInternal(wallet, maxPages),
      this.bs.incomingTokenTransfers(wallet, maxPages),
    ]);
    const edges: FundingEvent[] = [];
    const contracts: Record<string, boolean> = {};
    const ok = (from: string) => from !== wallet && from !== ZERO && !infra.has(from);

    for (const t of [...txs, ...internal]) {
      const from = lc(t.from.hash);
      if (BigInt(t.value || '0') === 0n || !ok(from)) continue;
      contracts[from] = Boolean(t.from.is_contract);
      edges.push({ kind: 'funding', from, to: wallet, asset: 'HYPE', amount: units(BigInt(t.value), 18), block: t.block_number, ts: ts((t as { timestamp?: string }).timestamp) });
    }
    for (const t of transfers) {
      const token = lc(t.token.address_hash ?? t.token.address ?? '');
      const from = lc(t.from.hash);
      if (!quoteTokens.has(token) || !ok(from)) continue;
      contracts[from] = Boolean(t.from.is_contract);
      const decimals = Number(t.total.decimals ?? t.token.decimals ?? 18);
      edges.push({ kind: 'funding', from, to: wallet, asset: t.token.symbol ?? 'USDC', amount: units(BigInt(t.total.value), decimals), block: t.block_number, ts: ts((t as { timestamp?: string }).timestamp) });
    }
    const out = { edges, contracts };
    this.store.cache(key, out);
    return out;
  }

  private async isHub(address: Address, isContract: boolean): Promise<boolean> {
    if (this.hubs.has(address)) return true;
    if (isContract) return true;
    const key = `txcount:v1:${address}`;
    let n = this.store.cached<number>(key);
    if (n === undefined) {
      n = await this.bs.txCount(address);
      this.store.cache(key, n);
    }
    return n >= this.opts.hubTxThreshold;
  }
}
