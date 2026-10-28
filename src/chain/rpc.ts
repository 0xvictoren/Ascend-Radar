/** Small JSON-RPC client: retries, bounded concurrency, small batches, getLogs splitting. */

export interface RpcLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  blockTimestamp?: string;
  transactionHash: string;
  transactionIndex: string;
  logIndex: string;
}

export interface LogFilter {
  address?: string | string[];
  topics?: (string | string[] | null)[];
  fromBlock: number;
  toBlock: number;
}

export class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hex = (n: number) => `0x${n.toString(16)}`;

/** Limits how many requests are in flight at once. */
export class Limiter {
  private active = 0;
  private queue: (() => void)[] = [];
  private readonly max: number;
  constructor(max: number) {
    this.max = max;
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

export class Rpc {
  readonly url: string;
  private id = 0;
  private limiter: Limiter;
  private readonly opts: { concurrency?: number; batchSize?: number; retries?: number };

  constructor(url: string, opts: { concurrency?: number; batchSize?: number; retries?: number } = {}) {
    this.url = url;
    this.opts = opts;
    this.limiter = new Limiter(opts.concurrency ?? 4);
  }

  private async post(body: unknown): Promise<unknown> {
    const retries = this.opts.retries ?? 5;
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await this.limiter.run(() =>
          fetch(this.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) }),
        );
        if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
        return await res.json();
      } catch (err) {
        if (attempt >= retries) throw err;
        await sleep(400 * 2 ** attempt);
      }
    }
  }

  async call<T = string>(method: string, params: unknown[]): Promise<T> {
    const retries = this.opts.retries ?? 5;
    for (let attempt = 0; ; attempt++) {
      const j = (await this.post({ jsonrpc: '2.0', id: ++this.id, method, params })) as { result?: T; error?: { code: number; message: string } };
      if (!j.error) return j.result as T;
      // code 3 = execution reverted, -32005 = too many results: retrying will not help
      if (j.error.code === 3 || j.error.code === -32005 || attempt >= retries) throw new RpcError(j.error.code, j.error.message);
      await sleep(400 * 2 ** attempt);
    }
  }

  /**
   * Runs calls in small JSON-RPC batches (the public endpoint rejects large
   * ones). Items that fail inside a batch are retried one by one; a revert
   * resolves to null instead of throwing.
   */
  async batch<T = string>(calls: { method: string; params: unknown[] }[]): Promise<(T | null)[]> {
    const size = this.opts.batchSize ?? 10;
    const out = new Array<T | null>(calls.length).fill(null);
    const chunks: number[][] = [];
    for (let i = 0; i < calls.length; i += size) chunks.push([...Array(Math.min(size, calls.length - i)).keys()].map((k) => i + k));
    await Promise.all(
      chunks.map(async (idx) => {
        const body = idx.map((i) => ({ jsonrpc: '2.0', id: i, method: calls[i]!.method, params: calls[i]!.params }));
        const res = (await this.post(body)) as { id: number; result?: T; error?: { code: number } }[] | { error: unknown };
        const rows = Array.isArray(res) ? res : [];
        const done = new Set<number>();
        for (const r of rows) {
          if (r.error) continue;
          out[r.id] = r.result ?? null;
          done.add(r.id);
        }
        for (const i of idx) {
          if (done.has(i)) continue;
          try {
            out[i] = await this.call<T>(calls[i]!.method, calls[i]!.params);
          } catch (err) {
            if (!(err instanceof RpcError && err.code === 3)) throw err;
          }
        }
      }),
    );
    return out;
  }

  async blockNumber(): Promise<number> {
    return Number(await this.call('eth_blockNumber', []));
  }

  async ethCall(to: string, data: string): Promise<string | null> {
    try {
      return await this.call('eth_call', [{ to, data }, 'latest']);
    } catch (err) {
      if (err instanceof RpcError && err.code === 3) return null;
      throw err;
    }
  }

  /** eth_getLogs over any range: halves the range whenever the node's result cap is hit. */
  async getLogs(f: LogFilter): Promise<RpcLog[]> {
    if (Array.isArray(f.address) && f.address.length === 0) return [];
    try {
      return await this.call<RpcLog[]>('eth_getLogs', [{ address: f.address, topics: f.topics, fromBlock: hex(f.fromBlock), toBlock: hex(f.toBlock) }]);
    } catch (err) {
      if (!(err instanceof RpcError && err.code === -32005) || f.fromBlock >= f.toBlock) throw err;
      const mid = Math.floor((f.fromBlock + f.toBlock) / 2);
      const left = await this.getLogs({ ...f, toBlock: mid });
      const right = await this.getLogs({ ...f, fromBlock: mid + 1 });
      return left.concat(right);
    }
  }
}
