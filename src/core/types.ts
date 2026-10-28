export type Address = `0x${string}`;

/**
 * Fee-recipient arrangement per Ascend's fee docs: the default deployer gets
 * 25% of the 1% token fee; an Ascend-approved creator or takeover operator gets 50%.
 * 'handoff' is the on-chain case: the creator role was transferred to another
 * wallet or contract (e.g. a fee router) with no Ascend approval implied.
 */
export type CreatorRole = 'deployer' | 'creator' | 'takeover' | 'handoff';

/** Lifecycle per Ascend docs: Launch -> Ascended -> HyperCore spot -> HIP-3 perps. */
export type LifecycleStage = 'launch' | 'ascended' | 'hypercore_spot' | 'hip3_perp';

interface Base {
  block: number;
  /** unix seconds */
  ts: number;
}

/** Normalized events. Every data source (simulator, Elysium adapter) emits these. */
export type ChainEvent =
  | (Base & {
      kind: 'launch';
      token: Address;
      symbol: string;
      name: string;
      deployer: Address;
      pool: Address;
      quote: string;
      totalSupply: number;
    })
  | (Base & {
      kind: 'swap';
      token: Address;
      trader: Address;
      side: 'buy' | 'sell';
      tokenAmount: number;
      quoteAmount: number;
      txHash?: string;
    })
  /** Wallet-to-wallet token transfer (adapters must not emit pool legs of swaps here). */
  | (Base & { kind: 'transfer'; token: Address; from: Address; to: Address; amount: number })
  /** Native (HYPE) or USDC transfer between wallets, used to build the funding graph. */
  | (Base & { kind: 'funding'; from: Address; to: Address; asset: string; amount: number })
  | (Base & { kind: 'creatorRole'; token: Address; role: CreatorRole; operator: Address })
  /** Creator fee claim: `amount` in quote (USD), `tokenAmount` in tokens paid to `by`. */
  | (Base & { kind: 'feeClaim'; token: Address; by: Address; amount: number; tokenAmount?: number })
  /** Creator directs a share of creator fees to the HyperCore listing claim. */
  | (Base & { kind: 'listingReserve'; token: Address; bps: number })
  | (Base & { kind: 'stage'; token: Address; stage: LifecycleStage });

export type ChainEventKind = ChainEvent['kind'];
export type EventOf<K extends ChainEventKind> = Extract<ChainEvent, { kind: K }>;

export type RiskLevel = 'low' | 'caution' | 'high';

export interface RiskReason {
  id: string;
  /** signed score delta */
  impact: number;
  detail: string;
}

export interface Cluster {
  id: string;
  members: Address[];
  /** why members were linked, e.g. "shared funder 0xabc…", "same-block buys" */
  links: string[];
  devLinked: boolean;
  /** % of total supply currently held by members */
  heldPct: number;
  /** % of total supply bought by members in the early window */
  boughtPct: number;
}

export interface AscendedProgress {
  /** 0..100, share of criteria met (partial credit for progress) */
  likelihood: number;
  criteria: { id: string; label: string; value: number; target: number; met: boolean }[];
  blockers: string[];
}

export interface RiskReport {
  token: Address;
  score: number;
  level: RiskLevel;
  reasons: RiskReason[];
  clusters: Cluster[];
  ascended: AscendedProgress;
  block: number;
}

export type AlertKind =
  | 'new_pool'
  | 'dev_sell'
  | 'risk_high'
  | 'whale_buy'
  | 'role_change'
  | 'stage'
  | 'watched_wallet';

export interface Alert {
  id: string;
  kind: AlertKind;
  token: Address;
  symbol: string;
  title: string;
  detail: string;
  block: number;
  ts: number;
  /** wallet that triggered it, when relevant */
  wallet?: Address;
}
