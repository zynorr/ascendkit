# examples

Small, runnable scripts that use the AscendKit packages directly (not the CLI).
Run `npm install && npm run build` at the repo root first, then:

| Script | Needs RPC | What it shows |
|---|---|---|
| `01-predict-pool.mjs` | no | Decode a raw `launch()` tx and predict its token address + poolId offline — asserted against the real launch |
| `02-track-pool.mjs` | yes | List every pool, then snapshot each pool's fee state and bid inventory |
| `03-watch-pool.mjs <token>` | yes | Poll a pool's events (`Collected`, `Filled`, `BidFunded`, `ProtocolFeesAllocated`) as they land |
| `04-simulate-fill.mjs` | no | Replay both real `Filled` events through the fill simulator — reproduced to the wei, including fee split and inventory debit |

```bash
node examples/01-predict-pool.mjs
node examples/02-track-pool.mjs
node examples/03-watch-pool.mjs 0x20c97309F0e1849d2403F97d56D619845C7b2253
node examples/04-simulate-fill.mjs
```
