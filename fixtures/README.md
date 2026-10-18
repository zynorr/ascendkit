# fixtures

Real launchpad data, frozen. Every file was fetched from
`https://testnet-rpc.elysium.kinetiq.xyz` at the block in
`pools.json` → `meta.fetchedAtBlock`.

| File | Contents |
|---|---|
| `raw/launched.json` | 8 `Launched` logs (poolId/token/creator indexed; quote, supplySeeded, devBuyTokens in data) |
| `raw/collected.json` | 13 `Collected` logs |
| `raw/filled.json` | 2 `Filled` logs — the flywheel fill simulator's ground truth |
| `raw/bidfunded.json` | 2 `BidFunded` logs |
| `raw/protocolfees.json` | 19 `ProtocolFeesAllocated` logs (the verified fee-split vectors) |
| `raw/tokensaccumulated.json` | 10 `TokensAccumulated` logs |
| `raw/creatorclaimed.json` | 6 `CreatorClaimed` logs |
| `raw/creatortransferstarted.json` / `raw/creatortransferred.json` | 4 + 4 creator-transfer logs |
| `raw/quoteconfigset.json` / `raw/pausedset.json` | 2 + 1 admin-configuration logs |
| `raw/launchtx.json` | one raw `launch()` transaction (input + sender) for CREATE2 prediction tests |
| `pools.json` | decoded pools + meta (launchpad, poolManager, chainId, fetchedAtBlock) |

## Verified

- `poolId = keccak256(abi.encode(currency0, currency1, hooks, poolManager, fee, parameters))` with `hooks = 0xc05193…01D9`, `poolManager = 0x12e842…e1aa`, `fee = 0x800000`, `parameters = 0xC80445` reproduces **8/8** fixture poolIds (`packages/core/src/poolkey.test.ts`).
- Two quote assets appear in the fixtures (`0xa0d2293c…` and `0xbb98f64d…`), covering both currency sort orders.
- `Launched` topic0 = `0xa75ce47c3ff6fc75b5270d713acafcfb8149c5f91a73679d659fa90798ecfab4`; `Filled` topic0 = `0x25efae546c5990ebbaf93c759da1d06969fd980edbc411da1bb1d1786f29e328`.
- Fee split model matches **all 19** `ProtocolFeesAllocated` logs to the wei (`packages/sim/src/fee.test.ts`, `packages/indexer/src/decode.test.ts`).
- CREATE2 prediction from `raw/launchtx.json` reproduces the launched token exactly (`packages/core/src/create2.test.ts`).
