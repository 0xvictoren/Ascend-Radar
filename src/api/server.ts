import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';
import type { RadarEngine, TokenState } from '../core/engine.ts';
import type { Address, Alert } from '../core/types.ts';
import { ProError, type Subscriptions } from '../pro/subscription.ts';
import { chargeX402, type X402Config } from '../pro/x402.ts';
import type { Store } from '../store/db.ts';

export interface ServerOptions {
  /** persists watched wallets */
  store?: Store;
  /** 'on' gates copy-alerts and the public API behind Pro; 'off' leaves everything open */
  proMode: 'off' | 'on';
  subscriptions?: Subscriptions;
  x402?: X402Config;
  publicUrl: string;
  links: {
    /** token page on Ascend, e.g. https://app.ascendlaunch.xyz/tokens/ */
    buyBase: string;
    /** appended to the buy link, e.g. a referral parameter, once Ascend publishes one */
    buyQuery: string;
    explorer: string;
  };
}

const PUBLIC_DIR = join(import.meta.dirname, '..', '..', 'public');
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

export function summary(engine: RadarEngine, s: TokenState) {
  const r = s.report;
  return {
    token: s.launch.token,
    symbol: s.launch.symbol,
    name: s.launch.name,
    deployer: s.launch.deployer,
    quote: s.launch.quote,
    launchBlock: s.launch.block,
    launchTs: s.launch.ts,
    score: r?.score ?? 100,
    level: r?.level ?? 'low',
    topReason: r?.reasons.find((x) => x.impact < 0)?.detail ?? null,
    price: s.price,
    mcap: s.price * s.launch.totalSupply,
    change: s.candles.length ? (s.price / s.candles[0]!.o - 1) * 100 : 0,
    volume: s.volume,
    trades: s.trades,
    holders: s.holderCount,
    stage: s.stage,
    role: s.role,
    ascendedLikelihood: r?.ascended.likelihood ?? 0,
    devSoldPct: engine.devSoldShare(s) * 100,
    lastTs: s.lastTs,
  };
}

function detail(engine: RadarEngine, s: TokenState) {
  const supply = s.launch.totalSupply;
  const dev = engine.devWallets(s);
  const clusterOf = new Map<Address, number>();
  s.clusters.forEach((c, i) => c.members.forEach((m) => clusterOf.set(m, i)));
  const topHolders = [...s.balances.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 25)
    .map(([wallet, bal]) => ({
      wallet,
      pct: (bal / supply) * 100,
      dev: dev.has(wallet),
      cluster: clusterOf.get(wallet) ?? null,
      label: engine.watched.get(wallet) ?? null,
    }));
  const tag = (w: Address) => (dev.has(w) ? 'dev' : clusterOf.has(w) ? `bundle ${clusterOf.get(w)! + 1}` : engine.watched.get(w) ?? null);
  return {
    ...summary(engine, s),
    report: s.report,
    candles: s.candles,
    history: s.history,
    topHolders,
    trades: s.recent.slice(-50).reverse().map((t) => ({ ...t, tag: tag(t.trader) })),
    listingReserveBps: s.listingReserveBps,
    feesClaimed: s.feesClaimed,
    operator: s.operator,
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    return {};
  }
}

/** The public API's risk payload: everything a bot or wallet needs to warn a buyer. */
function riskPayload(engine: RadarEngine, s: TokenState) {
  const { token, symbol, name, deployer, score, level, stage, role, holders, mcap, volume, devSoldPct } = summary(engine, s);
  return { token, symbol, name, deployer, score, level, stage, role, holders, mcap, volume, devSoldPct, report: s.report };
}

export function startServer(engine: RadarEngine, port: number, status: () => Record<string, unknown>, opts: ServerOptions) {
  const streams = new Set<ServerResponse>();
  const subs = opts.subscriptions;
  const proInfo = () => ({
    mode: opts.proMode,
    subscription: subs ? { treasury: subs.cfg.treasury, usdc: subs.cfg.usdc, priceUsdc: subs.cfg.priceUsdc, days: subs.cfg.days } : null,
    x402: opts.x402 ? { network: opts.x402.network, asset: opts.x402.asset, priceAtomic: opts.x402.priceAtomic, payTo: opts.x402.payTo } : null,
  });
  const keyOf = (req: IncomingMessage, url: URL) => (req.headers['x-radar-key'] as string | undefined) ?? url.searchParams.get('key');
  const isPro = (req: IncomingMessage, url: URL) => opts.proMode === 'off' || subs?.check(keyOf(req, url)) != null;
  for (const [wallet, label] of opts.store?.get<[Address, string][]>('watched') ?? []) engine.watch(wallet, label);
  const changed = new Set<Address>();
  engine.on('report', (r) => changed.add(r.token));
  engine.on('alert', (a: Alert) => {
    for (const res of streams) res.write(`event: alert\ndata: ${JSON.stringify(a)}\n\n`);
  });
  // Token updates are batched so a busy pool does not flood the browser.
  const flush = setInterval(() => {
    if (!changed.size || !streams.size) return changed.clear();
    const rows = [...changed].map((t) => engine.tokens.get(t)).filter((s) => s !== undefined).map((s) => summary(engine, s));
    changed.clear();
    const payload = `event: tokens\ndata: ${JSON.stringify({ rows, status: status() })}\n\n`;
    for (const res of streams) res.write(payload);
  }, 1_000);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'content-type, x-radar-key, x-payment',
        'access-control-expose-headers': 'x-payment-response',
      });
      return res.end();
    }
    try {
      if (path === '/api/status') return json(res, 200, { ...status(), links: opts.links, pro: proInfo() });
      if (path === '/api/pro' && req.method === 'GET') {
        const pro = subs?.check(keyOf(req, url));
        return json(res, 200, { ...proInfo(), active: pro ? { wallet: pro.wallet, expires: pro.expires } : null });
      }
      if (path === '/api/pro/activate' && req.method === 'POST') {
        if (!subs) return json(res, 501, { error: 'subscriptions are not configured (set PRO_TREASURY)' });
        const body = (await readBody(req)) as { txHash?: string };
        try {
          return json(res, 200, await subs.activate(body.txHash ?? ''));
        } catch (err) {
          if (err instanceof ProError) return json(res, err.status, { error: err.message });
          throw err;
        }
      }
      const riskMatch = path.match(/^\/api\/v1\/risk\/(0x[0-9a-fA-F]{40})$/);
      if (riskMatch) {
        const s = engine.tokens.get(riskMatch[1]!.toLowerCase() as Address);
        if (!s) return json(res, 404, { error: 'unknown token' });
        if (!isPro(req, url)) {
          if (!opts.x402) return json(res, 401, { error: 'Pro key required (x-radar-key header)', pro: proInfo() });
          const paid = await chargeX402(req, res, opts.x402, `${opts.publicUrl}${path}`, `Ascend Radar risk report for ${s.launch.symbol}`);
          if (!paid) return;
        }
        return json(res, 200, riskPayload(engine, s));
      }
      if (path === '/api/tokens') {
        const level = url.searchParams.get('level');
        const rows = [...engine.tokens.values()]
          .map((s) => summary(engine, s))
          .filter((r) => !level || r.level === level)
          .sort((a, b) => b.launchBlock - a.launchBlock);
        return json(res, 200, rows);
      }
      const tokenMatch = path.match(/^\/api\/tokens\/(0x[0-9a-fA-F]{40})$/);
      if (tokenMatch) {
        const s = engine.tokens.get(tokenMatch[1]!.toLowerCase() as Address);
        return s ? json(res, 200, detail(engine, s)) : json(res, 404, { error: 'unknown token' });
      }
      if (path === '/api/alerts') {
        const limit = Math.min(500, Number(url.searchParams.get('limit') ?? 100));
        const token = url.searchParams.get('token')?.toLowerCase();
        const rows = engine.alerts.filter((a) => !token || a.token === token).slice(-limit).reverse();
        return json(res, 200, rows);
      }
      if (path === '/api/watch' && req.method === 'POST') {
        if (!isPro(req, url)) return json(res, 401, { error: 'Copy-alerts are a Pro feature', pro: proInfo() });
        const body = (await readBody(req)) as { wallet?: string; label?: string };
        if (!body.wallet || !/^0x[0-9a-fA-F]{40}$/.test(body.wallet)) return json(res, 400, { error: 'wallet required' });
        engine.watch(body.wallet as Address, (body.label ?? 'Watched wallet').slice(0, 40));
        opts.store?.set('watched', [...engine.watched.entries()]);
        return json(res, 200, { ok: true, watched: [...engine.watched.entries()] });
      }
      if (path === '/api/watch') return json(res, 200, [...engine.watched.entries()].map(([wallet, label]) => ({ wallet, label })));
      if (path === '/api/stream') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          'access-control-allow-origin': '*',
        });
        res.write(`event: hello\ndata: ${JSON.stringify(status())}\n\n`);
        streams.add(res);
        req.on('close', () => streams.delete(res));
        return;
      }
      if (path.startsWith('/api/')) return json(res, 404, { error: 'not found' });

      const file = normalize(join(PUBLIC_DIR, path === '/' ? 'index.html' : path));
      if (!file.startsWith(PUBLIC_DIR) || !existsSync(file) || !statSync(file).isFile()) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
      createReadStream(file).pipe(res);
    } catch (err) {
      console.error(err);
      json(res, 500, { error: 'internal error' });
    }
  });

  server.listen(port);
  return { server, close: () => { clearInterval(flush); server.close(); } };
}
