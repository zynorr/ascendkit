# AscendKit

[![CI](https://github.com/zynorr/ascendkit/actions/workflows/ci.yml/badge.svg)](https://github.com/zynorr/ascendkit/actions/workflows/ci.yml)

**The missing integrator layer for [Ascend](https://ascendlaunch.xyz)'s launchpad on Kinetiq's Elysium testnet.**
Typed SDK, verified simulator, log decoders, CLI, and Telegram bot — so builders can
integrate with the launchpad in minutes instead of reverse-engineering a verified v4 hook.

> Unofficial and unaffiliated. Every constant in this repo is proven against the verified
> on-chain source and live RPC data — no private or off-chain sources.

## Why this exists

Ascend's launchpad is a Uniswap v4 hook with a sealed launch curve, a 90%→1% decaying
sniper tax, a flywheel inventory, creator fee claims, and a HyperCore listing desk.
Its surface for integrators is a single verified contract with no ABI package on npm, no
docs, no decoders, and no fee math. Every builder integrating with it — a bot, a frontend,
an analytics dashboard, a market maker — has to redo the same reverse-engineering.

AscendKit is that work, done once, in TypeScript, with proof.

## Proof, not promises

| Claim | How it's proven | Where |
|---|---|---|
| Byte-identical rebuild of the deployed contracts | The 62 verified sources (vendored from the explorer) compile with solc 0.8.30 to bytecode that matches the live `AscendLaunchpad` and `AscendToken`s, immutables masked | `tools/abi-extract/verify.js` — 10/10 checks |
| Every event topic decodes | 62 committed raw logs across 11 event types, decoded by the typed indexer | `packages/indexer/src/decode.test.ts` |
| poolId is derivable offline | `keccak256(abi.encode(...))` reproduces all 8 live poolIds | `packages/core/src/poolkey.test.ts` |
| Token addresses are predictable before launch | CREATE2 prediction reproduces a real `launch()` tx exactly | `packages/core/src/create2.test.ts` |
| Fee split math is exact | The creator/protocol split + bps breakdown matches all 19 live `ProtocolFeesAllocated` events **to the wei**, dust included | `packages/sim/src/fee.test.ts` |
| All of it runs live | CLI + examples query Elysium testnet end-to-end | `npm run demo` |

24 tests, zero snapshots, every value traceable to `fixtures/` (fetched from
`https://testnet-rpc.elysium.kinetiq.xyz`, block recorded in `fixtures/pools.json`).

## Status

| Milestone | State |
|---|---|
| **M1** — ABI parity harness: vendored sources, byte-identical rebuild, topic/selector/`CREATE2` verification | ✅ done |
| **M2** — SDK CREATE2 prediction, typed decoders, pool list/history/snapshots, verified fee splits, `pools`/`decode`/`watch` CLI | ✅ done |
| **M3** — Fill simulator: replay real `Filled` events to the wei; fee-aware quotes | 🚧 next |
| **M4** — Telegram bot: guided launch wizard + pool watcher | ⏳ |
| **M5** — docs site, npm publish, demo video, submission | ⏳ |

## Quickstart

```bash
npm install
npm run build
npm test                 # 24 tests, no network needed
npm run demo             # offline CREATE2 prediction + live pool tracking
npm run cli -- pools     # 8 real pools on Elysium testnet
```

Try it against a real launch:

```bash
npm run cli -- decode 0x91f35a45ae05d1a2e10e3202845275375bd93790d4d3d39def792a46eb1c8164
# -> launch params, predicted token + poolId (matches the live token), decoded events

npm run cli -- pool 0x20c97309F0e1849d2403F97d56D619845C7b2253
# -> launchedAt, creator, current fee vs schedule, bid inventory, EMA price
```

## SDK tour

```ts
import { poolIdOf, poolKeyOf, predictTokenAddress } from '@ascendkit/core'
import { feePipsNow, splitCreatorFee, splitProtocolFee } from '@ascendkit/sim'
import { listPools, poolHistory, snapshotPool, decodeLaunchpadLog } from '@ascendkit/indexer'

// what will a launch() create, before it happens?
const token = predictTokenAddress({ launchpad, sender, salt, name, symbol })
const poolId = poolIdOf(poolKeyOf(token, quote, { hook: launchpad, poolManager }))

// what does the fee look like right now, and where does it go?
feePipsNow(launchedAt, Math.floor(Date.now() / 1000))   // 900000 -> 10000 pips
const { creator, protocol } = splitCreatorFee(collected.quoteFees)
splitProtocolFee(protocol)                              // { stakerYield, treasury, ecosystem, opex, kntq }

// what happened, typed?
const pools = await listPools(client)
const events = await poolHistory(client, poolId)         // Launched | Collected | Filled | ...
const snapshot = await snapshotPool(client, poolId)      // one multicall, full pool state
```

Runnable versions of all three slices are in [`examples/`](examples/README.md).

## CLI

```
ak config                    chain, addresses, live quote config
ak fee [--launched-at N]     sniper-tax schedule / fee for any launch time
ak pools [--json]            every pool, creators, seed, ages
ak pool <token> [--quote]    full pool state (one multicall)
ak decode <tx|calldata>      launch params, predicted token + poolId, decoded events
ak watch <token>             stream collects, fills, bids, allocations
ak quote|launch|crank|bid    planned — see roadmap (M3/M4)
```

## Telegram bot

`apps/bot` — grammY scaffold wired to the same packages: pool watcher and a launch
wizard where the **creator is a role, not the caller** (the launchpad supports
launch-on-behalf). Builds in CI; demo needs a funded testnet wallet.

## Architecture

```
packages/core     chain + addresses + constants + generated ABI/token bytecode + pool key/CREATE2
packages/sim      fee schedule + verified fee splits (M3: fill simulation, quotes)
packages/indexer  raw eth_getLogs -> typed events, pool history, snapshots
packages/cli      ak / ascendkit binaries (commander, no frills)
apps/bot          Telegram bot (grammY)
tools/abi-extract vendor.js (extract) -> extract.js (solc 0.8.30) -> verify.js (10/10 vs live chain)
fixtures/         raw logs + decoded pools + launch tx, frozen with provenance
```

## Roadmap

- **M3** — Fill simulator: replay the two real `Filled` events to the wei against the
  flywheel band + EMA + clip rules, then power fee-aware quotes. This is the moat:
  nobody else can simulate a fill without the exact math above.
- **M4** — Telegram bot: guided launch wizard (creator role, salt preview with predicted
  token address, dev-buy) and a pool watcher with formatted event cards.
- **M5** — Docs site, npm publish of `@ascendkit/*`, demo video, competition submission.
- **M6** — Hosted read API + webhooks on top of the indexer: subscribe to
  `Launched`/`Collected`/`Filled` with no infra to run.
- **M7** — Generic hook indexer core: track any v4 launchpad hook with a dynamic-fee
  curve; quote adapters (`HYPE`, `USDC`, …); multi-chain as Kinetiq expands.

## Data provenance

All fixtures were fetched from `https://testnet-rpc.elysium.kinetiq.xyz` at the block
recorded in `fixtures/pools.json` (`meta.fetchedAtBlock`). Sources, compiler settings
(`solc 0.8.30`, viaIR, optimizer 200 runs, cancun, bytecodeHash none), ABI, and bytecode
were extracted from the Elysium testnet explorer's verified contract page and are
reproduced in `tools/abi-extract/`. Everything in `fixtures/` is raw RPC output.

## License

MIT. Contracts referenced belong to Ascend/Kinetiq; this repo is an unaffiliated
integrator toolkit.
