import { discordSink, PUSH_KINDS, telegramSink, type AlertSink } from './alerts/sinks.ts';
import { startServer } from './api/server.ts';
import { ASCEND_APP_URL, ELYSIUM_TESTNET } from './chain/elysium.ts';
import { Rpc } from './chain/rpc.ts';
import { loadConfig } from './config.ts';
import { RadarEngine } from './core/engine.ts';
import type { Address } from './core/types.ts';
import { elysiumFromEnv } from './ingest/elysium.ts';
import { simulatedSource, type DataSource } from './ingest/source.ts';
import { Subscriptions } from './pro/subscription.ts';
import type { X402Config } from './pro/x402.ts';
import { Store } from './store/db.ts';

try {
  process.loadEnvFile();
} catch {
  // no .env file; rely on the real environment
}

const env = process.env;
const port = Number(env.PORT ?? 8787);
const publicUrl = env.PUBLIC_URL ?? `http://localhost:${port}`;
const kind = process.argv.includes('--elysium') ? 'elysium' : (env.SOURCE ?? 'sim');
if (kind !== 'sim' && kind !== 'elysium') throw new Error(`Unknown SOURCE "${kind}" (use "sim" or "elysium")`);

const cfg = loadConfig({}, kind);
// The simulator is ephemeral; the Elysium index persists so restarts resume instead of re-indexing.
const store = new Store(kind === 'elysium' ? (env.DB_PATH ?? 'data/radar.db') : ':memory:');
const source: DataSource = kind === 'sim'
  ? simulatedSource({ seed: Number(env.SIM_SEED ?? 7), speed: Number(env.SIM_SPEED ?? 40) })
  : elysiumFromEnv(store, cfg.hubs, cfg);
for (const h of source.hubs) cfg.hubs.add(h.toLowerCase() as Address);
const engine = new RadarEngine(cfg);

const sinks: AlertSink[] = [];
if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) sinks.push(telegramSink(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, publicUrl));
if (env.DISCORD_WEBHOOK_URL) sinks.push(discordSink(env.DISCORD_WEBHOOK_URL, publicUrl));

// Only push alerts for blocks newer than boot: replayed and backfilled history stays out of Telegram/Discord.
const bootTs = Math.floor(Date.now() / 1000) - 60;
let live = false;
engine.on('alert', (a) => {
  if (!live || !PUSH_KINDS.has(a.kind) || a.ts < bootTs) return;
  for (const sink of sinks) void sink(a);
});

const subscriptions = env.PRO_TREASURY && env.PRO_USDC
  ? new Subscriptions(
    { treasury: env.PRO_TREASURY as Address, usdc: env.PRO_USDC as Address, priceUsdc: Number(env.PRO_PRICE_USDC ?? 25), days: Number(env.PRO_DAYS ?? 30) },
    store,
    new Rpc(env.ELYSIUM_RPC_URL || ELYSIUM_TESTNET.rpc),
  )
  : undefined;
const x402: X402Config | undefined = env.X402_PAY_TO
  ? {
    facilitatorUrl: env.X402_FACILITATOR_URL ?? 'https://x402.org/facilitator',
    network: env.X402_NETWORK ?? 'base-sepolia',
    asset: env.X402_ASSET ?? '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    assetName: env.X402_ASSET_NAME ?? 'USDC',
    assetVersion: env.X402_ASSET_VERSION ?? '2',
    payTo: env.X402_PAY_TO,
    priceAtomic: env.X402_PRICE_ATOMIC ?? '1000',
  }
  : undefined;

const { close } = startServer(engine, port, () => ({ source: source.name, ...source.head(), tokens: engine.tokens.size }), {
  store,
  proMode: env.PRO_MODE === 'on' ? 'on' : 'off',
  subscriptions,
  x402,
  publicUrl,
  links: {
    buyBase: `${env.ASCEND_APP_URL ?? ASCEND_APP_URL}/tokens/`,
    buyQuery: env.ASCEND_BUY_QUERY ?? '',
    explorer: env.EXPLORER_URL ?? ELYSIUM_TESTNET.explorer,
  },
});
source.start((e) => engine.handle(e));
live = true;

console.log(`Ascend Radar · ${source.name} · ${engine.tokens.size} tokens loaded`);
console.log(`Terminal: ${publicUrl}`);
console.log(`Alert sinks: ${sinks.length ? sinks.length : 'none (set TELEGRAM_* or DISCORD_WEBHOOK_URL)'}`);
console.log(`Pro: ${env.PRO_MODE === 'on' ? `on (subscriptions ${subscriptions ? 'ready' : 'off'}, x402 ${x402 ? x402.network : 'off'})` : 'off (everything open)'}`);

const shutdown = () => {
  source.stop();
  close();
  store.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
