import { addr, decodeString, int, SEL, uint, units, words } from '../chain/abi.ts';
import { Blockscout } from '../chain/blockscout.ts';
import { ASCEND_LAUNCHPADS, ELYSIUM_TESTNET, LAUNCHPAD_INFRA_GETTERS, LISTING_SET_ASIDE_BPS, TOKEN_DECIMALS, TOPIC } from '../chain/elysium.ts';
import { Rpc, type RpcLog } from '../chain/rpc.ts';
import type { Address, ChainEvent, EventOf } from '../core/types.ts';
import type { Store } from '../store/db.ts';
import { FundingResolver } from './funding.ts';
import type { DataSource } from './source.ts';

export interface ElysiumOptions {
  rpcUrl: string;
  explorerApi: string;
  launchpads: Address[];
  store: Store;
  /** the engine's hub set; discovered hubs (faucets, bridges) are added to it */
  hubs: Set<Address>;
  /** first block to index; defaults to the first Ascend launch */
  fromBlock?: number;
  /** blocks per indexing step */
  chunkBlocks?: number;
  pollMs?: number;
  /** buyers within this many blocks of launch get their funding resolved */
  earlyWindowBlocks: number;
  earlyBuyerLimit: number;
  /** USD price per quote token, by address; USD-named quotes default to 1 */
  quoteUsd?: Record<string, number>;
  hubTxThreshold: number;
  fundingPages: number;
  fundingDepth: number;
  log?: (msg: string) => void;
}

interface Pool {
  poolId: string;
  token: Address;
  quote: Address;
  tokenIs0: boolean;
  creator: Address;
  launchBlock: number;
  launchTx: string;
  quoteDecimals: number;
  quoteUsd: number;
  earlyBuyers: number;
}

interface Erc20Meta {
  name: string;
  symbol: string;
  decimals: number;
}

interface Item {
  key: [number, number, number];
  event: ChainEvent;
}

const CURSOR = 'elysium.cursor';
const HUBS = 'elysium.hubs';
const ZERO = '0x0000000000000000000000000000000000000000';
const DEAD = '0x000000000000000000000000000000000000dead';
const lc = (a: string) => a.toLowerCase() as Address;
const num = (h: string | undefined) => (h ? Number(h) : 0);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ElysiumSource extends DataSource {
  /** index from the cursor to the current head, without a live loop */
  syncToHead(onProgress?: (cursor: number, head: number) => void): Promise<void>;
}

/**
 * Indexes Ascend on Elysium into Radar's normalized events.
 *
 * - `Launched` (launchpad) -> launch; the atomic dev-buy (the launchpad's own
 *   swap in the launch tx) -> a buy by the creator role
 * - `Swap` (Infinity CLPoolManager or v4 PoolManager) on an Ascend pool -> swap,
 *   attributed to the transaction sender; a bid `Filled` in the same tx adds to a sell
 * - token `Transfer` between two wallets (EOAs) outside swaps -> transfer. Pool,
 *   vault, treasury and router legs are never emitted, and contracts are skipped
 *   so a staking or router contract cannot link its users together.
 * - `CreatorTransferred` -> creatorRole 'handoff'; `CreatorClaimed` -> feeClaim;
 *   `ListingSetAside` -> listingReserve (20% of creator quote fees)
 * - funding (HYPE + USDC) for early buyers and creators, from the explorer
 *
 * Every emitted event is stored with the cursor that produced it, so restarts
 * replay from SQLite and resume where indexing stopped.
 */
export function elysiumSource(opts: ElysiumOptions): ElysiumSource {
  const log = opts.log ?? ((m: string) => console.log(`[elysium] ${m}`));
  const rpc = new Rpc(opts.rpcUrl, { concurrency: 4, batchSize: 10 });
  const bs = new Blockscout(opts.explorerApi, 3);
  const store = opts.store;
  const launchpads = opts.launchpads.map(lc);
  const pools = new Map<string, Pool>();
  const byToken = new Map<Address, Pool>();
  const poolManagers = new Set<Address>();
  const infra = new Set<Address>([...launchpads, ZERO as Address, DEAD as Address]);
  const quoteTokens = new Set<string>();
  const listingSeen = new Set<string>();
  let resolver: FundingResolver;
  let cursor = 0;
  let headTs = 0;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let initialized = false;

  async function cachedCall<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const hit = store.cached<T>(key);
    if (hit !== undefined) return hit;
    const v = await fn();
    store.cache(key, v);
    return v;
  }

  async function erc20(a: Address): Promise<Erc20Meta> {
    return cachedCall(`erc20:v1:${a}`, async () => {
      const [name, symbol, decimals] = await rpc.batch([SEL.name, SEL.symbol, SEL.decimals].map((data) => ({ method: 'eth_call', params: [{ to: a, data }, 'latest'] })));
      return { name: decodeString(name ?? null), symbol: decodeString(symbol ?? null) || '???', decimals: decimals ? Number(BigInt(decimals)) : 18 };
    });
  }

  async function discoverInfra(): Promise<void> {
    const found = await cachedCall(`infra:v1:${launchpads.join(',')}`, async () => {
      const calls = launchpads.flatMap((lp) => LAUNCHPAD_INFRA_GETTERS.map((g) => ({ lp, sig: g.sig, data: g.data })));
      const res = await rpc.batch(calls.map((c) => ({ method: 'eth_call', params: [{ to: c.lp, data: c.data }, 'latest'] })));
      const out: { pm: string[]; other: string[] } = { pm: [], other: [] };
      res.forEach((r, i) => {
        if (!r || r.length < 66) return;
        const a = addr(r);
        if (a === ZERO) return;
        if (calls[i]!.sig === 'poolManager()') out.pm.push(a);
        else out.other.push(a);
      });
      return out;
    });
    for (const pm of found.pm) poolManagers.add(lc(pm));
    for (const a of [...found.pm, ...found.other]) infra.add(lc(a));
  }

  async function registerLaunch(l: RpcLog): Promise<Pool> {
    const w = words(l.data);
    const token = addr(l.topics[2]!);
    const quote = addr(w[0]!);
    const q = await erc20(quote);
    quoteTokens.add(quote);
    const usd = opts.quoteUsd?.[quote] ?? 1;
    if (opts.quoteUsd?.[quote] === undefined && !/usd/i.test(q.symbol)) {
      log(`quote ${q.symbol} (${quote}) has no USD price set; valuing 1 ${q.symbol} = $1 (set QUOTE_USD)`);
      opts.quoteUsd = { ...opts.quoteUsd, [quote]: 1 };
    }
    const pool: Pool = {
      poolId: l.topics[1]!,
      token,
      quote,
      tokenIs0: BigInt(token) < BigInt(quote),
      creator: addr(l.topics[3]!),
      launchBlock: num(l.blockNumber),
      launchTx: l.transactionHash,
      quoteDecimals: q.decimals,
      quoteUsd: usd,
      earlyBuyers: 0,
    };
    pools.set(pool.poolId, pool);
    byToken.set(token, pool);
    return pool;
  }

  async function txSenders(hashes: string[]): Promise<Map<string, Address>> {
    const out = new Map<string, Address>();
    const missing: string[] = [];
    for (const h of new Set(hashes)) {
      const hit = store.cached<string>(`txfrom:${h}`);
      if (hit) out.set(h, hit as Address);
      else missing.push(h);
    }
    const res = await rpc.batch<{ from: string } | null>(missing.map((h) => ({ method: 'eth_getTransactionByHash', params: [h] })));
    store.tx(() => {
      missing.forEach((h, i) => {
        const from = res[i]?.from;
        if (!from) return;
        out.set(h, lc(from));
        store.cache(`txfrom:${h}`, lc(from));
      });
    });
    return out;
  }

  async function contracts(addresses: Address[]): Promise<Set<Address>> {
    const out = new Set<Address>();
    const missing: Address[] = [];
    for (const a of new Set(addresses)) {
      const hit = store.cached<boolean>(`code:${a}`);
      if (hit === undefined) missing.push(a);
      else if (hit) out.add(a);
    }
    const res = await rpc.batch(missing.map((a) => ({ method: 'eth_getCode', params: [a, 'latest'] })));
    store.tx(() => {
      missing.forEach((a, i) => {
        const isContract = (res[i] ?? '0x').length > 2;
        store.cache(`code:${a}`, isContract);
        if (isContract) out.add(a);
      });
    });
    return out;
  }

  async function getTokenTransfers(from: number, to: number): Promise<RpcLog[]> {
    const tokens = [...byToken.keys()];
    const out: RpcLog[] = [];
    for (let i = 0; i < tokens.length; i += 100) {
      out.push(...(await rpc.getLogs({ address: tokens.slice(i, i + 100), topics: [TOPIC.transfer], fromBlock: from, toBlock: to })));
    }
    return out;
  }

  /** Index [from, to] and return the events in emission order. */
  async function processRange(from: number, to: number): Promise<ChainEvent[]> {
    const lpLogs = await rpc.getLogs({
      address: launchpads,
      topics: [[TOPIC.launched, TOPIC.creatorTransferred, TOPIC.creatorClaimed, TOPIC.listingSetAside, TOPIC.filled]],
      fromBlock: from,
      toBlock: to,
    });
    const items: Item[] = [];
    const at = (l: RpcLog) => ({ block: num(l.blockNumber), ts: num(l.blockTimestamp) });
    const key = (l: RpcLog, bump = 0): [number, number, number] => [num(l.blockNumber), num(l.transactionIndex), num(l.logIndex) + bump];

    const launchLogs = lpLogs.filter((l) => l.topics[0] === TOPIC.launched).sort((a, b) => num(a.blockNumber) - num(b.blockNumber));
    const newPools: Pool[] = [];
    for (const l of launchLogs) {
      if (pools.has(l.topics[1]!)) continue;
      newPools.push(await registerLaunch(l));
    }
    const metas = await Promise.all(newPools.map((p) => erc20(p.token)));
    newPools.forEach((p, i) => {
      const l = launchLogs.find((x) => x.topics[1] === p.poolId)!;
      const m = metas[i]!;
      // sorts before every other log of the launch tx, so the dev-buy lands after it
      items.push({
        key: [num(l.blockNumber), num(l.transactionIndex), -1],
        event: { kind: 'launch', token: p.token, symbol: m.symbol, name: m.name, deployer: p.creator, pool: p.poolId as Address, quote: (store.cached<Erc20Meta>(`erc20:v1:${p.quote}`)?.symbol ?? 'USDC'), totalSupply: 1_000_000_000, ...at(l) },
      });
    });

    const swapLogs = (await rpc.getLogs({ address: [...poolManagers], topics: [[TOPIC.swapInfinity, TOPIC.swapV4]], fromBlock: from, toBlock: to })).filter((l) => pools.has(l.topics[1]!));
    const fills = new Map<string, RpcLog>();
    for (const l of lpLogs) if (l.topics[0] === TOPIC.filled && pools.has(l.topics[1]!)) fills.set(`${l.transactionHash}:${l.topics[1]}`, l);
    const launchTxs = new Set([...pools.values()].filter((p) => p.launchBlock >= from).map((p) => p.launchTx));
    const senders = await txSenders([...swapLogs, ...fills.values()].filter((l) => !launchTxs.has(l.transactionHash)).map((l) => l.transactionHash));

    const swapTxs = new Set<string>();
    const earlyWallets = new Set<Address>(newPools.map((p) => p.creator));
    const usedFills = new Set<string>();
    const pushSwap = (l: RpcLog, p: Pool, tokenDelta: bigint, quoteDelta: bigint) => {
      const trader = l.transactionHash === p.launchTx ? p.creator : senders.get(l.transactionHash);
      if (!trader) return;
      const side = tokenDelta > 0n ? 'buy' : 'sell';
      const tokenAmount = Math.abs(units(tokenDelta, TOKEN_DECIMALS));
      const quoteAmount = Math.abs(units(quoteDelta, p.quoteDecimals)) * p.quoteUsd;
      if (tokenAmount <= 0) return;
      swapTxs.add(l.transactionHash);
      const block = num(l.blockNumber);
      if (side === 'buy' && block - p.launchBlock <= opts.earlyWindowBlocks && p.earlyBuyers < opts.earlyBuyerLimit) {
        p.earlyBuyers++;
        earlyWallets.add(trader);
      }
      items.push({ key: key(l), event: { kind: 'swap', token: p.token, trader, side, tokenAmount, quoteAmount, txHash: l.transactionHash, ...at(l) } });
    };

    for (const l of swapLogs) {
      const p = pools.get(l.topics[1]!)!;
      const w = words(l.data);
      // Infinity and v4 both log amounts from the swapper's side: positive = received
      const a0 = int(w[0]!);
      const a1 = int(w[1]!);
      let tokenDelta = p.tokenIs0 ? a0 : a1;
      let quoteDelta = p.tokenIs0 ? a1 : a0;
      const fill = fills.get(`${l.transactionHash}:${p.poolId}`);
      if (fill && tokenDelta < 0n) {
        // the bid filled part of this sell; the Swap row only carries the AMM's share
        const fw = words(fill.data);
        tokenDelta -= uint(fw[0]!);
        quoteDelta += uint(fw[3]!);
        usedFills.add(`${l.transactionHash}:${p.poolId}`);
      }
      pushSwap(l, p, tokenDelta, quoteDelta);
    }
    for (const [k, l] of fills) {
      if (usedFills.has(k)) continue;
      const p = pools.get(l.topics[1]!)!;
      const fw = words(l.data);
      pushSwap(l, p, -uint(fw[0]!), uint(fw[3]!));
    }

    const claimTxs = new Set<string>();
    for (const l of lpLogs) {
      const p = pools.get(l.topics[1]!);
      if (!p) continue;
      if (l.topics[0] === TOPIC.creatorTransferred) {
        items.push({ key: key(l), event: { kind: 'creatorRole', token: p.token, role: 'handoff', operator: addr(l.topics[2]!), ...at(l) } });
      } else if (l.topics[0] === TOPIC.creatorClaimed) {
        claimTxs.add(l.transactionHash);
        const w = words(l.data);
        items.push({
          key: key(l),
          event: { kind: 'feeClaim', token: p.token, by: addr(l.topics[2]!), amount: units(uint(w[1]!), p.quoteDecimals) * p.quoteUsd, tokenAmount: units(uint(w[0]!), TOKEN_DECIMALS), ...at(l) },
        });
      } else if (l.topics[0] === TOPIC.listingSetAside && !listingSeen.has(p.poolId)) {
        listingSeen.add(p.poolId);
        items.push({ key: key(l), event: { kind: 'listingReserve', token: p.token, bps: LISTING_SET_ASIDE_BPS, ...at(l) } });
      }
    }

    // Wallet-to-wallet token transfers only: swap, launch and claim legs are accounted above.
    const transferLogs = (await getTokenTransfers(from, to)).filter(
      (l) => !swapTxs.has(l.transactionHash) && !launchTxs.has(l.transactionHash) && !claimTxs.has(l.transactionHash),
    );
    const candidates = transferLogs
      .map((l) => ({ l, from: addr(l.topics[1]!), to: addr(l.topics[2]!) }))
      .filter((t) => !infra.has(t.from) && !infra.has(t.to) && t.from !== t.to);
    const isContract = await contracts(candidates.flatMap((t) => [t.from, t.to]));
    for (const t of candidates) {
      if (isContract.has(t.from) || isContract.has(t.to)) continue;
      const p = byToken.get(lc(t.l.address))!;
      items.push({ key: key(t.l), event: { kind: 'transfer', token: p.token, from: t.from, to: t.to, amount: units(uint(words(t.l.data)[0]!), TOKEN_DECIMALS), ...at(t.l) } });
    }

    items.sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.key[2] - b.key[2]);

    // Funding happened before the buys it explains, so it is emitted first.
    const { events: funding, newHubs } = await resolver.resolve(earlyWallets);
    if (newHubs.length) {
      for (const h of newHubs) opts.hubs.add(h);
      store.set(HUBS, [...opts.hubs]);
    }
    return [...funding, ...items.map((i) => i.event)];
  }

  async function init(emit: (e: ChainEvent) => void): Promise<void> {
    if (initialized) return;
    initialized = true;
    for (const h of store.get<Address[]>(HUBS) ?? []) opts.hubs.add(h);
    await discoverInfra();
    resolver = new FundingResolver(bs, store, {
      quoteTokens,
      infra,
      hubTxThreshold: opts.hubTxThreshold,
      maxPages: opts.fundingPages,
      depth: opts.fundingDepth,
    });
    for (const h of opts.hubs) resolver.hubs.add(h);

    const saved = store.get<{ block: number; ts: number }>(CURSOR);
    if (saved) {
      cursor = saved.block;
      headTs = saved.ts;
      // rebuild the pool registry for everything already indexed
      const launches = await rpc.getLogs({ address: launchpads, topics: [TOPIC.launched], fromBlock: 0, toBlock: cursor });
      for (const l of launches) await registerLaunch(l);
      const funded = new Set<Address>();
      let n = 0;
      for (const e of store.events()) {
        if (e.kind === 'funding') funded.add(e.to);
        if (e.kind === 'listingReserve') listingSeen.add(byToken.get(e.token)?.poolId ?? '');
        if (e.kind === 'swap' && e.side === 'buy') {
          const p = byToken.get(e.token);
          if (p && e.block - p.launchBlock <= opts.earlyWindowBlocks) p.earlyBuyers++;
        }
        emit(e);
        n++;
      }
      resolver.markDone(funded);
      log(`replayed ${n.toLocaleString()} stored events up to block ${cursor.toLocaleString()}`);
    } else {
      const first = opts.fromBlock ?? (await rpc.getLogs({ address: launchpads, topics: [TOPIC.launched], fromBlock: 0, toBlock: await rpc.blockNumber() }))
        .reduce((m, l) => Math.min(m, num(l.blockNumber)), Number.MAX_SAFE_INTEGER);
      cursor = (first === Number.MAX_SAFE_INTEGER ? await rpc.blockNumber() : first) - 1;
      log(`no stored state; indexing from block ${(cursor + 1).toLocaleString()}`);
    }
  }

  async function step(emit: (e: ChainEvent) => void, head: number): Promise<void> {
    const to = Math.min(head, cursor + (opts.chunkBlocks ?? 500_000));
    const events = await processRange(cursor + 1, to);
    const lastTs = events.reduce((m, e) => Math.max(m, e.ts), headTs);
    store.commit(events, CURSOR, { block: to, ts: lastTs });
    cursor = to;
    headTs = lastTs;
    for (const e of events) emit(e);
  }

  async function syncToHead(emit: (e: ChainEvent) => void, onProgress?: (cursor: number, head: number) => void): Promise<void> {
    // Targets the head seen at the start; the chain makes ~4 blocks/s, so chasing it would never finish.
    const head = await rpc.blockNumber();
    while (cursor < head && !stopped) {
      await step(emit, head);
      onProgress?.(cursor, head);
    }
  }

  return {
    name: 'elysium-testnet',
    hubs: [],
    start(emit) {
      void (async () => {
        try {
          await init(emit);
          await syncToHead(emit, (c, h) => log(`indexed to ${c.toLocaleString()} / ${h.toLocaleString()} · ${pools.size} pools`));
          log(`live at block ${cursor.toLocaleString()}`);
        } catch (err) {
          log(`sync failed: ${(err as Error).message}`);
        }
        const poll = async () => {
          if (stopped) return;
          try {
            await syncToHead(emit);
          } catch (err) {
            log(`poll failed: ${(err as Error).message}`);
            await sleep(5_000);
          }
          timer = setTimeout(poll, opts.pollMs ?? 2_000);
        };
        void poll();
      })();
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
    head: () => ({ block: cursor, ts: headTs }),
    async syncToHead(onProgress) {
      await init(() => {});
      await syncToHead(() => {}, onProgress);
    },
  };
}

/** Builds the Elysium source from environment variables, with testnet defaults. */
export function elysiumFromEnv(store: Store, hubs: Set<Address>, cfg: { earlyWindowBlocks: number; earlyBuyerLimit: number }): ElysiumSource {
  const env = process.env;
  const list = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) as Address[];
  const quoteUsd: Record<string, number> = {};
  for (const pair of list(env.QUOTE_USD)) {
    const [a, price] = pair.split(':');
    if (a && price) quoteUsd[a] = Number(price);
  }
  return elysiumSource({
    rpcUrl: env.ELYSIUM_RPC_URL || ELYSIUM_TESTNET.rpc,
    explorerApi: env.ELYSIUM_EXPLORER_API || ELYSIUM_TESTNET.explorerApi,
    launchpads: env.ASCEND_LAUNCHPADS ? list(env.ASCEND_LAUNCHPADS) : ASCEND_LAUNCHPADS,
    store,
    hubs,
    ...(env.ELYSIUM_FROM_BLOCK ? { fromBlock: Number(env.ELYSIUM_FROM_BLOCK) } : {}),
    chunkBlocks: Number(env.ELYSIUM_CHUNK_BLOCKS || 500_000),
    pollMs: Number(env.ELYSIUM_POLL_MS || 2_000),
    earlyWindowBlocks: cfg.earlyWindowBlocks,
    earlyBuyerLimit: cfg.earlyBuyerLimit,
    quoteUsd,
    hubTxThreshold: Number(env.HUB_TX_THRESHOLD || 2_000),
    fundingPages: Number(env.FUNDING_PAGES || 2),
    fundingDepth: 2,
  });
}
