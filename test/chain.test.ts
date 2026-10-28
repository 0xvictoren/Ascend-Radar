import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeString, int, padAddress, units } from '../src/chain/abi.ts';
import { TOPIC } from '../src/chain/elysium.ts';
import { keccak256, selector } from '../src/chain/keccak.ts';
import type { Rpc } from '../src/chain/rpc.ts';
import { loadConfig } from '../src/config.ts';
import { RadarEngine } from '../src/core/engine.ts';
import type { Address, ChainEvent } from '../src/core/types.ts';
import { realBacktest } from '../src/backtest/real.ts';
import { ProError, Subscriptions } from '../src/pro/subscription.ts';
import { chargeX402 } from '../src/pro/x402.ts';
import { Store } from '../src/store/db.ts';

const a = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address;

describe('keccak256', () => {
  it('matches Ethereum vectors and the topics seen on Elysium', () => {
    assert.equal(keccak256(''), '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
    assert.equal(TOPIC.transfer, '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef');
    // read from AscendLaunchpad / CLPoolManager logs on the testnet
    assert.equal(TOPIC.launched, '0xa75ce47c3ff6fc75b5270d713acafcfb8149c5f91a73679d659fa90798ecfab4');
    assert.equal(TOPIC.swapInfinity, '0x04206ad2b7c0f463bff3dd4f33c5735b0f2957a351e4f79763a4fa9e775dd237');
    assert.equal(TOPIC.swapV4, '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f');
    assert.equal(selector('poolManager()'), '0xdc4c90d3');
  });

  it('handles inputs longer than one block', () => {
    assert.equal(keccak256('a'.repeat(200)).length, 66);
    assert.notEqual(keccak256('a'.repeat(136)), keccak256('a'.repeat(135)));
  });
});

describe('abi helpers', () => {
  it('decodes signed words, units and strings', () => {
    assert.equal(int('f'.repeat(64)), -1n);
    assert.equal(int('0'.repeat(63) + '5'), 5n);
    assert.equal(units(1_500_000n, 6), 1.5);
    assert.equal(units(-(10n ** 18n) * 3n, 18), -3);
    const encoded = `0x${'20'.padStart(64, '0')}${'4'.padStart(64, '0')}${Buffer.from('PEPE').toString('hex').padEnd(64, '0')}`;
    assert.equal(decodeString(encoded), 'PEPE');
  });
});

describe('engine with Elysium-style events', () => {
  it('credits claimed fee tokens to the creator and records a role handoff', () => {
    const engine = new RadarEngine(loadConfig({}, 'elysium'));
    const T = a(500);
    const DEV = a(1);
    const ev = (e: Record<string, unknown>) => engine.handle({ ts: 1, ...e } as ChainEvent);
    ev({ kind: 'launch', token: T, symbol: 'X', name: 'X', deployer: DEV, pool: a(9), quote: 'USDC', totalSupply: 1_000_000_000, block: 10 });
    ev({ kind: 'feeClaim', token: T, by: DEV, amount: 5, tokenAmount: 1_000_000, block: 20 });
    const s = engine.tokens.get(T)!;
    assert.equal(s.balances.get(DEV), 1_000_000);
    ev({ kind: 'creatorRole', token: T, role: 'handoff', operator: a(2), block: 30 });
    assert.equal(engine.alerts.at(-1)!.title, 'Creator role handed off: X');
  });
});

describe('Store', () => {
  it('commits events with their cursor and replays them in order', () => {
    const store = new Store(':memory:');
    const e1 = { kind: 'stage', token: a(1), stage: 'ascended', block: 5, ts: 1 } as ChainEvent;
    const e2 = { kind: 'stage', token: a(2), stage: 'launch', block: 6, ts: 2 } as ChainEvent;
    store.commit([e1, e2], 'cursor', { block: 6 });
    assert.deepEqual([...store.events()], [e1, e2]);
    assert.deepEqual(store.get('cursor'), { block: 6 });
  });
});

describe('Subscriptions', () => {
  const USDC = a(0xc0);
  const TREASURY = a(0x7e);
  const PAYER = a(0xbe);
  const receipt = (amount: bigint) => ({
    status: '0x1',
    logs: [{ address: USDC, topics: [TOPIC.transfer, padAddress(PAYER), padAddress(TREASURY)], data: `0x${amount.toString(16).padStart(64, '0')}` }],
  });
  const fakeRpc = (amount: bigint) => ({
    call: async () => receipt(amount),
    ethCall: async () => `0x${'6'.padStart(64, '0')}`,
  }) as unknown as Rpc;

  it('issues a key for a USDC payment to the treasury and refuses to reuse it', async () => {
    const store = new Store(':memory:');
    const subs = new Subscriptions({ treasury: TREASURY, usdc: USDC, priceUsdc: 25, days: 30 }, store, fakeRpc(50_000_000n));
    const tx = `0x${'ab'.repeat(32)}`;
    const now = 1_000_000;
    const r = await subs.activate(tx, now);
    assert.equal(r.wallet, PAYER);
    assert.equal(r.expires, now + 2 * 30 * 86_400_000, 'two periods paid');
    assert.ok(subs.check(r.key, now + 1));
    assert.equal(subs.check(r.key, r.expires + 1), null);
    await assert.rejects(subs.activate(tx, now), (err: unknown) => err instanceof ProError && err.status === 409);
  });

  it('rejects underpayment', async () => {
    const subs = new Subscriptions({ treasury: TREASURY, usdc: USDC, priceUsdc: 25, days: 30 }, new Store(':memory:'), fakeRpc(1_000_000n));
    await assert.rejects(subs.activate(`0x${'cd'.repeat(32)}`), (err: unknown) => err instanceof ProError && err.status === 402);
  });
});

describe('x402', () => {
  it('answers 402 with payment requirements when no payment is attached', async () => {
    let status = 0;
    let body = '';
    const res = { writeHead: (s: number) => { status = s; }, end: (b: string) => { body = b; }, setHeader: () => {} };
    const ok = await chargeX402({ headers: {} } as never, res as never, {
      facilitatorUrl: 'http://127.0.0.1:1', network: 'base-sepolia', asset: a(0xc0), assetName: 'USDC', assetVersion: '2', payTo: a(0x7e), priceAtomic: '1000',
    }, 'http://localhost/api/v1/risk/x', 'risk');
    assert.equal(ok, false);
    assert.equal(status, 402);
    const j = JSON.parse(body);
    assert.equal(j.x402Version, 1);
    assert.equal(j.accepts[0].scheme, 'exact');
    assert.equal(j.accepts[0].maxAmountRequired, '1000');
  });
});

describe('real backtest labelling', () => {
  const T = a(500);
  const DEV = a(1);
  const base = (block: number) => ({ block, ts: block });
  const launch = { kind: 'launch', token: T, symbol: 'R', name: 'R', deployer: DEV, pool: a(9), quote: 'USDC', totalSupply: 1_000_000_000, ...base(100) } as ChainEvent;
  const buys = (from: number, n: number, price: number) =>
    Array.from({ length: n }, (_, i) => ({ kind: 'swap', token: T, trader: a(1000 + from + i), side: 'buy', tokenAmount: 1_000_000, quoteAmount: price, ...base(from + i) }) as ChainEvent);

  it('labels a creator dump with a price collapse as a rug, timed at the first creator exit', () => {
    const events: ChainEvent[] = [
      launch,
      { kind: 'swap', token: T, trader: DEV, side: 'buy', tokenAmount: 300_000_000, quoteAmount: 300, ...base(100) } as ChainEvent,
      ...buys(200, 12, 10),
      { kind: 'swap', token: T, trader: DEV, side: 'sell', tokenAmount: 300_000_000, quoteAmount: 100, ...base(400) } as ChainEvent,
      ...buys(500, 2, 0.5),
    ];
    const r = realBacktest(events, loadConfig({}, 'elysium'), { minTrades: 10, minBuyers: 3, exitShare: 0.5, dropPct: 0.7, team: new Set() });
    const row = r.rows[0]!;
    assert.equal(row.label, 'rug');
    assert.equal(row.dumpBlock, 400);
    assert.equal(row.caught, row.flagBlock !== null && row.flagBlock < 400);
  });

  it('marks launches with too little trading as thin, not clean', () => {
    const r = realBacktest([launch, ...buys(200, 3, 10)], loadConfig({}, 'elysium'), { minTrades: 10, minBuyers: 3, exitShare: 0.5, dropPct: 0.7, team: new Set() });
    assert.equal(r.rows[0]!.label, 'thin');
  });
});
