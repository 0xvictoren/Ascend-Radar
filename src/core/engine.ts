import { EventEmitter } from 'node:events';
import type { RadarConfig } from '../config.ts';
import { detectClusters, type EarlyBuy } from '../risk/bundles.ts';
import { FundingGraph } from '../risk/funding-graph.ts';
import { ascendedProgress, scoreRisk, type RiskFeatures } from '../risk/score.ts';
import type {
  Address,
  Alert,
  AlertKind,
  ChainEvent,
  Cluster,
  CreatorRole,
  EventOf,
  LifecycleStage,
  RiskReport,
} from './types.ts';

export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface Trade {
  block: number;
  ts: number;
  trader: Address;
  side: 'buy' | 'sell';
  quote: number;
  tokens: number;
}

export interface TokenState {
  launch: EventOf<'launch'>;
  balances: Map<Address, number>;
  holderCount: number;
  earlyBuys: EarlyBuy[];
  devWallets: Set<Address>;
  tokenLinks: [Address, Address][];
  acquired: Map<Address, number>;
  sold: Map<Address, number>;
  firstBlockBought: number;
  price: number;
  peakPrice: number;
  volume: number;
  trades: number;
  role: CreatorRole;
  operator: Address;
  listingReserveBps: number;
  feesClaimed: number;
  stage: LifecycleStage;
  candles: Candle[];
  recent: Trade[];
  clusters: Cluster[];
  clustersDirty: boolean;
  report: RiskReport | null;
  history: { block: number; score: number }[];
  rugged: boolean;
  devSellAlerted: number;
  riskAlerted: boolean;
  lastBlock: number;
  lastTs: number;
}

const DEV_SELL_STEPS = [0.2, 0.5, 0.9];
const CANDLE_SECONDS = 60;
const MAX_CANDLES = 720;
const MAX_ALERTS = 2_000;
const MAX_TRADES = 100;

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const usd = (n: number) => `$${Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;

/**
 * Consumes normalized chain events, keeps per-token state, rescores risk and
 * emits alerts. Source-agnostic: the simulator and the Elysium adapter feed it
 * the same events.
 */
export class RadarEngine extends EventEmitter<{ alert: [Alert]; report: [RiskReport] }> {
  readonly cfg: RadarConfig;
  readonly graph = new FundingGraph();
  readonly tokens = new Map<Address, TokenState>();
  readonly alerts: Alert[] = [];
  readonly watched = new Map<Address, string>();
  /** addresses tied to tokens Radar marked as rugs -> those tokens */
  private rugAddresses = new Map<Address, Set<Address>>();
  /** wallet -> tokens where it matters for clustering */
  private walletTokens = new Map<Address, Set<Address>>();
  private alertSeq = 0;

  constructor(cfg: RadarConfig) {
    super();
    this.cfg = cfg;
  }

  watch(wallet: Address, label: string): void {
    this.watched.set(wallet.toLowerCase() as Address, label);
  }

  handle(e: ChainEvent): void {
    switch (e.kind) {
      case 'launch':
        return this.onLaunch(e);
      case 'funding':
        this.graph.add(e);
        for (const t of this.walletTokens.get(e.to) ?? []) this.markDirty(t);
        return;
      case 'swap':
        return this.onSwap(e);
      case 'transfer':
        return this.onTransfer(e);
      case 'creatorRole':
        return this.onRole(e);
      case 'feeClaim': {
        const s = this.tokens.get(e.token);
        if (!s) return;
        s.feesClaimed += e.amount;
        if (e.tokenAmount) {
          // token-side creator fees are tokens the creator can later sell
          this.setBalance(s, e.by, (s.balances.get(e.by) ?? 0) + e.tokenAmount);
          s.acquired.set(e.by, (s.acquired.get(e.by) ?? 0) + e.tokenAmount);
        }
        return;
      }
      case 'listingReserve': {
        const s = this.tokens.get(e.token);
        if (!s) return;
        s.listingReserveBps = e.bps;
        this.rescore(s, e);
        return;
      }
      case 'stage':
        return this.onStage(e);
    }
  }

  private onLaunch(e: EventOf<'launch'>): void {
    const s: TokenState = {
      launch: e,
      balances: new Map(),
      holderCount: 0,
      earlyBuys: [],
      devWallets: new Set(),
      tokenLinks: [],
      acquired: new Map(),
      sold: new Map(),
      firstBlockBought: 0,
      price: 0,
      peakPrice: 0,
      volume: 0,
      trades: 0,
      role: 'deployer',
      operator: e.deployer,
      listingReserveBps: 0,
      feesClaimed: 0,
      stage: 'launch',
      candles: [],
      recent: [],
      clusters: [],
      clustersDirty: true,
      report: null,
      history: [],
      rugged: false,
      devSellAlerted: 0,
      riskAlerted: false,
      lastBlock: e.block,
      lastTs: e.ts,
    };
    this.tokens.set(e.token, s);
    this.track(e.deployer, e.token);
    const prior = this.priorRugs(e.deployer, e.block);
    this.alert(s, 'new_pool', `New pool: ${e.symbol}`, prior > 0
      ? `Deployer ${short(e.deployer)} is linked to ${prior} earlier rug${prior > 1 ? 's' : ''}`
      : `Deployer ${short(e.deployer)} · ${e.quote} pool`, e, e.deployer);
    this.rescore(s, e);
  }

  private onSwap(e: EventOf<'swap'>): void {
    const s = this.tokens.get(e.token);
    if (!s || e.tokenAmount <= 0) return;
    const supply = s.launch.totalSupply;
    const bal = s.balances.get(e.trader) ?? 0;

    if (e.side === 'buy') {
      this.setBalance(s, e.trader, bal + e.tokenAmount);
      s.acquired.set(e.trader, (s.acquired.get(e.trader) ?? 0) + e.tokenAmount);
      // the dev-buy is scored under dev holdings, not as sniping
      if (e.block - s.launch.block <= this.cfg.snipeWindowBlocks && e.trader !== s.launch.deployer) s.firstBlockBought += e.tokenAmount;
      if (e.block - s.launch.block <= this.cfg.earlyWindowBlocks && s.earlyBuys.length < this.cfg.earlyBuyerLimit) {
        s.earlyBuys.push({ wallet: e.trader, block: e.block, tokenAmount: e.tokenAmount, quoteAmount: e.quoteAmount });
        this.track(e.trader, e.token);
        s.clustersDirty = true;
      }
      if (e.quoteAmount >= this.cfg.whaleBuyQuote) {
        this.alert(s, 'whale_buy', `Whale buy: ${s.launch.symbol}`, `${short(e.trader)} bought ${usd(e.quoteAmount)} (${((e.tokenAmount / supply) * 100).toFixed(2)}% of supply)`, e, e.trader);
      }
    } else {
      this.setBalance(s, e.trader, Math.max(0, bal - e.tokenAmount));
      s.sold.set(e.trader, (s.sold.get(e.trader) ?? 0) + e.tokenAmount);
    }

    const price = e.quoteAmount / e.tokenAmount;
    s.price = price;
    s.peakPrice = Math.max(s.peakPrice, price);
    s.volume += e.quoteAmount;
    s.trades++;
    this.candle(s, e.ts, price, e.quoteAmount);
    s.recent.push({ block: e.block, ts: e.ts, trader: e.trader, side: e.side, quote: e.quoteAmount, tokens: e.tokenAmount });
    if (s.recent.length > MAX_TRADES) s.recent.shift();

    const label = this.watched.get(e.trader);
    if (label) {
      this.alert(s, 'watched_wallet', `${label} ${e.side === 'buy' ? 'bought' : 'sold'} ${s.launch.symbol}`, `${usd(e.quoteAmount)} at $${price.toPrecision(3)}`, e, e.trader);
    }

    if (!s.rugged && s.peakPrice > 0 && s.price < s.peakPrice * 0.2 && this.devSoldShare(s) >= 0.5) {
      s.rugged = true;
      this.recordRug(s);
    }

    this.rescore(s, e);

    if (e.side === 'sell' && this.devWallets(s).has(e.trader)) {
      const share = this.devSoldShare(s);
      const step = DEV_SELL_STEPS.filter((x) => share >= x).pop() ?? 0;
      if (step > s.devSellAlerted && share >= this.cfg.devSellAlertPct) {
        s.devSellAlerted = step;
        this.alert(s, 'dev_sell', `Dev selling: ${s.launch.symbol}`, `Dev-linked wallets have sold ${(share * 100).toFixed(0)}% of their tokens (last: ${short(e.trader)}, ${usd(e.quoteAmount)})`, e, e.trader);
      }
    }
  }

  private onTransfer(e: EventOf<'transfer'>): void {
    const s = this.tokens.get(e.token);
    if (!s) return;
    this.setBalance(s, e.from, Math.max(0, (s.balances.get(e.from) ?? 0) - e.amount));
    this.setBalance(s, e.to, (s.balances.get(e.to) ?? 0) + e.amount);
    const devs = this.devWallets(s);
    if (devs.has(e.from)) {
      // tokens moved inside the dev's wallets stay "acquired" by the dev group
      s.devWallets.add(e.to);
      this.track(e.to, e.token);
    } else {
      s.acquired.set(e.to, (s.acquired.get(e.to) ?? 0) + e.amount);
    }
    s.tokenLinks.push([e.from, e.to]);
    s.clustersDirty = true;
    this.rescore(s, e);
  }

  private onRole(e: EventOf<'creatorRole'>): void {
    const s = this.tokens.get(e.token);
    if (!s) return;
    const prev = s.role;
    s.role = e.role;
    s.operator = e.operator;
    const what = {
      takeover: 'Community takeover approved',
      creator: 'Creator approved by Ascend',
      handoff: 'Creator role handed off',
      deployer: 'Reverted to deployer',
    }[e.role];
    this.alert(s, 'role_change', `${what}: ${s.launch.symbol}`, `${prev} → ${e.role}, operator ${short(e.operator)} now receives creator fees`, e, e.operator);
    this.rescore(s, e);
  }

  private onStage(e: EventOf<'stage'>): void {
    const s = this.tokens.get(e.token);
    if (!s) return;
    s.stage = e.stage;
    const label = { launch: 'Launch', ascended: 'Ascended', hypercore_spot: 'HyperCore spot listing', hip3_perp: 'HIP-3 perp market' }[e.stage];
    this.alert(s, 'stage', `${s.launch.symbol} → ${label}`, `Lifecycle stage changed to ${label}`, e);
    this.rescore(s, e);
  }

  /** deployer, operator, explicit dev wallets and every member of a dev-linked cluster */
  devWallets(s: TokenState): Set<Address> {
    const out = new Set<Address>([s.launch.deployer, ...s.devWallets]);
    if (s.role === 'deployer') out.add(s.operator);
    for (const c of s.clusters) if (c.devLinked) for (const m of c.members) out.add(m);
    return out;
  }

  devSoldShare(s: TokenState): number {
    let acquired = 0;
    let sold = 0;
    for (const w of this.devWallets(s)) {
      acquired += s.acquired.get(w) ?? 0;
      sold += s.sold.get(w) ?? 0;
    }
    return acquired > 0 ? Math.min(1, sold / acquired) : 0;
  }

  features(s: TokenState): RiskFeatures {
    const supply = s.launch.totalSupply;
    // single pass top-10 instead of sorting every holder on every swap
    const top: number[] = [];
    for (const b of s.balances.values()) {
      if (top.length < 10) {
        top.push(b);
        top.sort((x, y) => y - x);
      } else if (b > top[9]!) {
        top[9] = b;
        top.sort((x, y) => y - x);
      }
    }
    const top10 = top.reduce((sum, b) => sum + b, 0);
    return {
      clusters: s.clusters,
      top10Pct: (top10 / supply) * 100,
      firstBlockPct: (s.firstBlockBought / supply) * 100,
      devSoldShare: this.devSoldShare(s),
      uniqueHolders: s.holderCount,
      mcap: s.price * supply,
      volume: s.volume,
      role: s.role,
      listingReserveBps: s.listingReserveBps,
      deployerPriorRugs: this.priorRugs(s.launch.deployer, s.launch.block, s.launch.token),
      ascended: s.stage !== 'launch',
      drawdownPct: s.peakPrice > 0 ? (1 - s.price / s.peakPrice) * 100 : 0,
      rugged: s.rugged,
    };
  }

  private rescore(s: TokenState, e: { block: number; ts: number }): void {
    s.lastBlock = e.block;
    s.lastTs = e.ts;
    if (s.clustersDirty) {
      s.clusters = detectClusters({
        earlyBuys: s.earlyBuys,
        deployer: s.launch.deployer,
        devWallets: s.devWallets,
        tokenLinks: s.tokenLinks,
        balances: s.balances,
        totalSupply: s.launch.totalSupply,
        graph: this.graph,
        depth: this.cfg.fundingDepth,
        lookback: this.cfg.fundingLookbackBlocks,
        hubs: this.cfg.hubs,
        sameBlockMinGroup: this.cfg.sameBlockMinGroup,
        sameBlockWindow: this.cfg.sameBlockWindow,
        sameBlockSizeTolerance: this.cfg.sameBlockSizeTolerance,
      });
      s.clustersDirty = false;
    } else {
      const supply = s.launch.totalSupply;
      for (const c of s.clusters) {
        c.heldPct = (c.members.reduce((sum, m) => sum + (s.balances.get(m) ?? 0), 0) / supply) * 100;
      }
    }

    const f = this.features(s);
    const { score, level, reasons } = scoreRisk(f, this.cfg);
    const report: RiskReport = {
      token: s.launch.token,
      score,
      level,
      reasons,
      clusters: s.clusters,
      ascended: ascendedProgress(f, this.cfg),
      block: e.block,
    };
    s.report = report;
    const last = s.history[s.history.length - 1];
    if (!last || last.score !== score) s.history.push({ block: e.block, score });

    if (level === 'high' && !s.riskAlerted) {
      s.riskAlerted = true;
      const top = reasons.filter((r) => r.impact < 0).slice(0, 2).map((r) => r.detail).join('; ');
      this.alert(s, 'risk_high', `High risk: ${s.launch.symbol} (${score}/100)`, top, e);
    } else if (level === 'low') {
      s.riskAlerted = false;
    }
    this.emit('report', report);
  }

  private priorRugs(deployer: Address, atBlock: number, exclude?: Address): number {
    const ids = new Set<Address>([deployer, ...this.graph.ancestors(deployer, atBlock, {
      depth: this.cfg.fundingDepth,
      lookback: this.cfg.fundingLookbackBlocks,
      hubs: this.cfg.hubs,
    })]);
    const rugs = new Set<Address>();
    for (const id of ids) for (const t of this.rugAddresses.get(id) ?? []) if (t !== exclude) rugs.add(t);
    return rugs.size;
  }

  private recordRug(s: TokenState): void {
    const ids = [s.launch.deployer, ...this.graph.ancestors(s.launch.deployer, s.launch.block, {
      depth: this.cfg.fundingDepth,
      lookback: this.cfg.fundingLookbackBlocks,
      hubs: this.cfg.hubs,
    })];
    for (const id of ids) {
      const set = this.rugAddresses.get(id) ?? new Set<Address>();
      set.add(s.launch.token);
      this.rugAddresses.set(id, set);
    }
  }

  private setBalance(s: TokenState, wallet: Address, value: number): void {
    const dust = s.launch.totalSupply * 1e-9;
    const before = (s.balances.get(wallet) ?? 0) > dust;
    const after = value > dust;
    if (after) s.balances.set(wallet, value);
    else s.balances.delete(wallet);
    s.holderCount += Number(after) - Number(before);
  }

  private track(wallet: Address, token: Address): void {
    const set = this.walletTokens.get(wallet) ?? new Set<Address>();
    set.add(token);
    this.walletTokens.set(wallet, set);
  }

  private markDirty(token: Address): void {
    const s = this.tokens.get(token);
    if (s) s.clustersDirty = true;
  }

  private candle(s: TokenState, ts: number, price: number, vol: number): void {
    const t = ts - (ts % CANDLE_SECONDS);
    const last = s.candles[s.candles.length - 1];
    if (last && last.t === t) {
      last.h = Math.max(last.h, price);
      last.l = Math.min(last.l, price);
      last.c = price;
      last.v += vol;
    } else {
      s.candles.push({ t, o: last?.c ?? price, h: price, l: price, c: price, v: vol });
      if (s.candles.length > MAX_CANDLES) s.candles.shift();
    }
  }

  private alert(s: TokenState, kind: AlertKind, title: string, detail: string, e: { block: number; ts: number }, wallet?: Address): void {
    const a: Alert = {
      id: `${e.block}-${++this.alertSeq}`,
      kind,
      token: s.launch.token,
      symbol: s.launch.symbol,
      title,
      detail,
      block: e.block,
      ts: e.ts,
      ...(wallet ? { wallet } : {}),
    };
    this.alerts.push(a);
    if (this.alerts.length > MAX_ALERTS) this.alerts.shift();
    this.emit('alert', a);
  }
}
