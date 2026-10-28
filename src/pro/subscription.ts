import { createHash, randomBytes } from 'node:crypto';
import { addr, padAddress, SEL, uint } from '../chain/abi.ts';
import { TOPIC } from '../chain/elysium.ts';
import type { Rpc } from '../chain/rpc.ts';
import type { Address } from '../core/types.ts';
import type { Store } from '../store/db.ts';

export interface SubscriptionConfig {
  /** wallet that receives subscription payments */
  treasury: Address;
  /** USDC token on the chain `rpc` points at */
  usdc: Address;
  priceUsdc: number;
  days: number;
}

export interface ProKey {
  wallet: Address;
  expires: number;
  tx: string;
}

const hashKey = (key: string) => createHash('sha256').update(key).digest('hex');

/**
 * Terminal subscriptions paid in USDC, verified on-chain with no payment
 * processor: the buyer sends `priceUsdc` (or a multiple, for more periods) to
 * the treasury, then submits the tx hash. Radar checks the receipt's USDC
 * Transfer, refuses reused hashes, and issues an API key. Only the key's hash is stored.
 */
export class Subscriptions {
  readonly cfg: SubscriptionConfig;
  private readonly store: Store;
  private readonly rpc: Rpc;
  private decimals: number | undefined;

  constructor(cfg: SubscriptionConfig, store: Store, rpc: Rpc) {
    this.cfg = { ...cfg, treasury: cfg.treasury.toLowerCase() as Address, usdc: cfg.usdc.toLowerCase() as Address };
    this.store = store;
    this.rpc = rpc;
  }

  async activate(txHash: string, now = Date.now()): Promise<{ key: string } & ProKey> {
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new ProError(400, 'txHash must be a 32-byte hex hash');
    const hash = txHash.toLowerCase();
    if (this.store.get(`pro.tx:${hash}`)) throw new ProError(409, 'this payment was already used');

    const receipt = await this.rpc.call<{ status: string; logs: { address: string; topics: string[]; data: string }[] } | null>('eth_getTransactionReceipt', [hash]);
    if (!receipt) throw new ProError(404, 'transaction not found (yet)');
    if (receipt.status !== '0x1') throw new ProError(400, 'transaction failed');

    const to = padAddress(this.cfg.treasury);
    let paid = 0n;
    let payer: Address | null = null;
    for (const l of receipt.logs) {
      if (l.address.toLowerCase() !== this.cfg.usdc || l.topics[0] !== TOPIC.transfer || l.topics[2]?.toLowerCase() !== to) continue;
      paid += uint(l.data.slice(2, 66));
      payer ??= addr(l.topics[1]!);
    }
    if (!payer) throw new ProError(400, 'no USDC transfer to the Radar treasury in this transaction');

    this.decimals ??= Number(BigInt((await this.rpc.ethCall(this.cfg.usdc, SEL.decimals)) ?? '0x6'));
    const unit = BigInt(Math.round(this.cfg.priceUsdc * 10 ** this.decimals));
    const periods = Number(paid / unit);
    if (periods < 1) throw new ProError(402, `payment below the ${this.cfg.priceUsdc} USDC price`);

    const key = `rk_${randomBytes(24).toString('hex')}`;
    const pro: ProKey = { wallet: payer, expires: now + periods * this.cfg.days * 86_400_000, tx: hash };
    this.store.tx(() => {
      this.store.set(`pro.tx:${hash}`, true);
      this.store.set(`pro.key:${hashKey(key)}`, pro);
    });
    return { key, ...pro };
  }

  check(key: string | null | undefined, now = Date.now()): ProKey | null {
    if (!key) return null;
    const pro = this.store.get<ProKey>(`pro.key:${hashKey(key)}`);
    return pro && pro.expires > now ? pro : null;
  }
}

export class ProError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
