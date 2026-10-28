import { Limiter } from './rpc.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface BsAddressRef {
  hash: string;
  is_contract?: boolean;
}

export interface BsTx {
  block_number: number;
  from: BsAddressRef;
  to: BsAddressRef | null;
  value: string;
  hash: string;
}

export interface BsInternalTx {
  block_number: number;
  from: BsAddressRef;
  to: BsAddressRef | null;
  value: string;
  transaction_hash: string;
}

export interface BsTokenTransfer {
  block_number: number;
  from: BsAddressRef;
  to: BsAddressRef;
  token: { address_hash?: string; address?: string; decimals?: string | null; symbol?: string | null };
  total: { value: string; decimals?: string | null };
}

interface Page<T> {
  items: T[];
  next_page_params: Record<string, string | number> | null;
}

/**
 * Blockscout v2 API client. Native HYPE transfers emit no logs, so funding
 * history (who sent a wallet its first gas and USDC) comes from the explorer.
 */
export class Blockscout {
  readonly base: string;
  private limiter: Limiter;
  constructor(base: string, concurrency = 3) {
    this.base = base;
    this.limiter = new Limiter(concurrency);
  }

  async get<T>(path: string, params: Record<string, string | number> = {}): Promise<T> {
    const url = `${this.base}${path}${Object.keys(params).length ? `?${new URLSearchParams(params as Record<string, string>)}` : ''}`;
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await this.limiter.run(() => fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30_000) }));
        if (res.status === 404) return { items: [], next_page_params: null } as T;
        if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
        if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
        return (await res.json()) as T;
      } catch (err) {
        if (attempt >= 5) throw err;
        await sleep(500 * 2 ** attempt);
      }
    }
  }

  /** Walks pages until `stop` says enough or `maxPages` is reached. Pages come newest first. */
  async pages<T>(path: string, params: Record<string, string>, maxPages: number, stop?: (items: T[]) => boolean): Promise<T[]> {
    const out: T[] = [];
    let next: Record<string, string | number> | null = {};
    for (let p = 0; p < maxPages && next; p++) {
      const page: Page<T> = await this.get<Page<T>>(path, { ...params, ...next });
      out.push(...page.items);
      if (stop?.(page.items)) break;
      next = page.next_page_params;
    }
    return out;
  }

  incomingTxs(wallet: string, maxPages: number) {
    return this.pages<BsTx>(`/addresses/${wallet}/transactions`, { filter: 'to' }, maxPages);
  }

  incomingInternal(wallet: string, maxPages: number) {
    return this.pages<BsInternalTx>(`/addresses/${wallet}/internal-transactions`, { filter: 'to' }, maxPages);
  }

  incomingTokenTransfers(wallet: string, maxPages: number) {
    return this.pages<BsTokenTransfer>(`/addresses/${wallet}/token-transfers`, { filter: 'to', type: 'ERC-20' }, maxPages);
  }

  async txCount(address: string): Promise<number> {
    const c = await this.get<{ transactions_count?: string }>(`/addresses/${address}/counters`);
    return Number(c.transactions_count ?? 0);
  }
}
