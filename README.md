# Ascend Radar

A safety and intelligence terminal for token launches on [Ascend](https://ascendlaunch.gitbook.io/docs), the launchpad on Kinetiq's Elysium L2 (built for Hyperliquid).

Every launch gets a risk score with reasons a buyer can check on-chain. The score is driven by wallet behaviour: linked and bundled buyers, dev-wallet tracking, holder concentration, serial deployers. Radar also shows each token's progress towards Ascend's **Ascended** status and sends alerts for new pools, dev sells, whale buys, creator-role changes and lifecycle stages.

Radar indexes **Ascend's live contracts on the Elysium testnet** (chain 99801). A seeded simulator is still available for demos and regression tests.

## Quick start

```bash
npm install
npm run sync           # index Ascend's Elysium testnet history into data/radar.db (~15-25 min the first time)
npm run dev:elysium    # terminal on http://localhost:8787 with live testnet launches
npm run backtest:real  # score real testnet history, print recall / FP rate, write data/backtest-real.json

npm run dev            # simulated launches instead (no network)
npm run backtest       # simulated backtest (pipeline check only)
npm test
```

Requires Node ≥ 22.18. TypeScript runs natively, and there are no runtime dependencies (SQLite is `node:sqlite`). Copy `.env.example` to `.env` for alerts, Pro and overrides. Run one Radar process per database: `sync` and `dev:elysium` both write to it.

## How it works

```
Elysium RPC + Blockscout ─▶ ElysiumSource ──ChainEvent──▶ RadarEngine ──▶ API (REST + SSE) ──▶ terminal
 (or the simulator)          │ SQLite event log            │ FundingGraph    └──▶ Telegram / Discord
                             └ FundingResolver (hubs)      └ detectClusters, scoreRisk, ascendedProgress
```

| Path | Role |
|---|---|
| `src/chain/elysium.ts` | Testnet endpoints, known AscendLaunchpad deployments, event topics |
| `src/ingest/elysium.ts` | Indexes launches, swaps, wallet transfers, creator handoffs, fee claims and listing set-asides into `ChainEvent`s; backfills, then polls live |
| `src/ingest/funding.ts` | Who funded each early buyer and creator (HYPE + USDC) from the explorer; flags hubs |
| `src/store/db.ts` | SQLite event log + cursor (restart = replay + resume), cache, watches, Pro keys |
| `src/core/engine.ts` | Per-token state, rescoring, rug memory (serial deployers), alerts |
| `src/risk/bundles.ts` | Links early buyers by shared funders (2 hops, hubs excluded), token transfers, and same-window equal-size buys |
| `src/risk/score.ts` | Transparent weighted rules → 0–100 score + reasons; Ascended progress |
| `src/backtest/real.ts` | Backtest on indexed chain history with outcome-only labels |
| `src/pro/` | USDC subscriptions verified on-chain; x402 pay-per-call |
| `src/api/server.ts` | `/api/tokens`, `/api/tokens/:addr`, `/api/alerts`, `/api/watch`, `/api/stream` (SSE), `/api/v1/risk/:addr`, `/api/pro` |

### What the Elysium adapter reads

Ascend runs on hooked PancakeSwap Infinity (and earlier, Uniswap v4) pools, with no bonding curve. The adapter maps the verified `AscendLaunchpad` ABI as follows:

| On-chain | Radar event |
|---|---|
| `Launched(poolId, token, creator, quote, supplySeeded, devBuyTokens)` | `launch`; the atomic dev-buy (the launchpad's own swap in the launch tx) becomes a buy by the creator |
| `Swap` on the pool manager, for Ascend pool ids | `swap`, attributed to the transaction sender. A bid `Filled` in the same tx is added to the sell |
| Token `Transfer` between two EOAs, outside swap, launch and claim txs | `transfer`. Pool, vault, treasury and router legs are never emitted. Contracts are skipped so a staking or router contract cannot link its users together |
| `CreatorTransferred` | `creatorRole: handoff` (no Ascend approval implied) |
| `CreatorClaimed` | `feeClaim`, with claimed tokens credited to the creator |
| `ListingSetAside` | `listingReserve` (20% of creator quote fees, from the contract source) |
| Explorer funding history | `funding` (HYPE + USDC) for early buyers (first 10 minutes), creators, and their funders |

Windows are wall-clock based. Elysium blocks are ~240 ms, so the defaults are a 10-minute early window, a 5-second snipe window (Ascend's sniper fee decays from 90% to 1% over 5 s), 2-second "same block" buckets and 30 days of funding history.

**Hubs.** On a testnet nearly every wallet is funded by the faucet. A funder is treated as a hub, and never links wallets, when it is a contract or has ≥ `HUB_TX_THRESHOLD` transactions. Discovered hubs are persisted. Add exchange and bridge hot wallets with `HUB_ADDRESSES`.

### Scoring principles
- Every point removed has a reason a buyer can verify. There is no opaque model.
- Dev-linked groups are scored once (holdings, sells, hidden wallets), never counted again as a "bundle". The creator's own dev-buy is never counted as sniping.
- Positive signals (approved creator, listing reserve, holders, Ascended) never offset a severe red flag.
- Shared funding from hubs never links wallets.

## Backtests

### Real: Elysium testnet

`npm run backtest:real` replays the indexed history through the engine. Labels come only from explicit on-chain facts, never from Radar's clustering, so the evaluation is not circular:

- **Rug:** the creator wallet named in `Launched` sold or moved out ≥ 50% of the tokens it acquired, and the price then fell ≥ 70% below its pre-dump peak. The dump starts at the creator's **first** sell or outgoing transfer, and Radar must have rated the token high-risk before that block.
- **Clean:** the creator exited < 20%. Any high-risk rating is a false positive.
- **Thin** (< 10 trades or < 3 outside buyers) and **ambiguous** launches are excluded.

**Result on 2026-10-28 (testnet to block 17,571,161): too little signal to measure accuracy yet.**

| | |
|---|---|
| Launches indexed (9 official launchpads) | 443 |
| Swaps / wallet transfers / funding edges | 11,656 / 9 / 1,125 |
| Buys vs sells | 11,166 vs 490 (sells come from just 61 wallets) |
| Thin / ambiguous / clean / rug | 422 / 3 / 17 / 1 |
| Rugs flagged before the dump | 0 / 1 (flagged after the dump) |
| Clean launches flagged | 1 / 17 |

The testnet is mostly buy-only bot and load-test traffic with valueless mock USDC, so there are almost no dumps to predict. The two labelled cases are still informative. The one rug (`BTC`, creator `0x9332…3184`, a 100% exit followed by a 99.6% price drop) scored as *caution* before the dump and was rated high-risk only afterwards. The same creator's next launch (`FGK`) was rated high-risk on launch as a serial deployer whose wallets hold 98% of supply. It counts as a false positive only because it has not dumped (yet). Thresholds were deliberately **not** tuned on this sample. The real accuracy number needs mainnet history: run the same `sync` + `backtest:real` there.

### Simulated (500 launches, seeds 7 / 42 / 1)

| | |
|---|---|
| Rugs flagged before the dump | 50–61% |
| False-positive rate on honest launches | 0.9–1.6% |

The simulator was written alongside the scorer, so these figures only show that the pipeline works.

## Pro

`PRO_MODE=on` gates copy-alerts (`POST /api/watch`) and the public API (`GET /api/v1/risk/:token`). Everything else stays free.

- **Subscription (terminal and API):** send `PRO_PRICE_USDC` USDC (or a multiple, for more periods) to `PRO_TREASURY` on Elysium, then submit the tx hash in the terminal (or `POST /api/pro/activate {txHash}`). Radar verifies the USDC `Transfer` in the receipt, refuses reused hashes and issues a key (`x-radar-key` header). No payment processor is involved, and only key hashes are stored.
- **x402 pay-per-call (API):** without a key, `/api/v1/risk/:token` answers HTTP 402 with x402 v1 `exact` payment requirements. A client retries with `X-PAYMENT`, which Radar verifies and settles through the facilitator before answering. Public facilitators don't support Elysium yet, so the default is Base Sepolia USDC.

## Buying

Each token page has **Buy on Ascend**, linking to `app.ascendlaunch.xyz/tokens/<token>`, and an explorer link. Ascend's referral program pays 20% of referred swap fees in USDC, but Ascend hasn't published how a referral is attached (link parameter or on-chain). Set `ASCEND_BUY_QUERY` once it has, and the buy link carries it.

## Not built yet
1. **Mainnet.** Point `ELYSIUM_RPC_URL`, `ELYSIUM_EXPLORER_API` and `ASCEND_LAUNCHPADS` at mainnet once it is live, then re-run `sync` and `backtest:real`. That is the number to show judges.
2. **Ascended thresholds and lifecycle events.** Ascend hasn't published thresholds or a stage event yet, so `config.ts` still holds placeholders and `stage` alerts only come from the simulator.
3. **Referral attribution** for Buy on Ascend (see above).
4. **Contract-wallet bundles.** Transfers through contracts are skipped to avoid false links, so bundles run through smart wallets or disperse contracts are missed.
