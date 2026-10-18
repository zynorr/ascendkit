# Demo runbook

Shot list for the 3–4 minute submission video. Every command is copy-pasteable.
Record from the repo root after `npm install && npm run build`.

## Prep (before recording)

- `npm test` — leave the terminal scrolled to the 59/59 result (0:00 proof).
- Have `fixtures/raw/launchtx.json` open in an editor tab (provenance).
- Optional: a funded throwaway wallet in MetaMask on Elysium testnet for the bot segment.

## Beats

1. **The problem (20s, talking head or title card)**
   Ascend's launchpad is a verified v4 hook, but there is no typed surface for it:
   no ABI package, no decoders, no fee math, no way to predict what a launch will create.
   AscendKit is that layer.

2. **Proof, not promises (60s)**
   - `node tools/abi-extract/verify.js` → 10/10 checks: our solc 0.8.30 rebuild of the 62
     verified sources is byte-identical to the deployed contracts; every topic matches
     every committed log; CREATE2 reproduces a real launch.
   - `npm test` → 59/59, including the fee-split model that matches all 19 live
     `ProtocolFeesAllocated` events to the wei and the fill replay below.

3. **SDK + simulator in one breath (40s)**
   - `node examples/01-predict-pool.mjs` → prints predicted token + poolId, asserts match.
   - `node examples/04-simulate-fill.mjs` → both real `Filled` events replay through
     `simulateFill` **to the wei**: absorbed amount, quote paid, fee split, reserve vs
     accumulated, and the bid's inventory debit. This is the moat — the exact port of
     `_fill`'s band + EMA + clip rules (`docs/flywheel.md`), verified against chain state.

4. **CLI live on testnet (60s)**
   - `npm run cli -- config` → chain, addresses, quote — all read from chain.
   - `npm run cli -- pools` → 8 real pools, creators, seed, ages.
   - `npm run cli -- decode 0x91f35a45ae05d1a2e10e3202845275375bd93790d4d3d39def792a46eb1c8164`
     → launch params + predicted token/poolId matching the live token + decoded events.
   - `npm run cli -- pool 0x20c97309F0e1849d2403F97d56D619845C7b2253` → fee now vs scheduled.
   - `npm run cli -- quote 0xb1527cca2bb132fea7bcff6fee49c2752ca0ebe8 100` → live fill-aware
     quote for a 100-token sell: window state reconstructed from logs, absorbed amount,
     quote paid at spot, split, AMM remainder.

5. **Telegram bot (30s, if wallet funded)**
   - `/start` → menu; `/pools` → recent pools; `/pool <token>` → fee state; `/watch <token>` → live events.

6. **Roadmap + close (20s)**
   - `README.md` roadmap tab: M1–M3 shipped (ABI parity, SDK/indexer, wei-exact fill
     simulator), M4 bot wizard, M5 publish. Post-launch: hosted read API, multi-launchpad.

## Notes

- Keep raw JSON output in frame — it doubles as proof against the explorer.
- If the bot segment is skipped, say why in one line ("bot demo needs a funded testnet
  wallet; the code is in `apps/bot` and builds in CI"). Honesty reads better than cuts.
