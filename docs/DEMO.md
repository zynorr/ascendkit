# Demo runbook

Shot list for the 3–4 minute submission video. Every command is copy-pasteable.
Record from the repo root after `npm install && npm run build`.

## Prep (before recording)

- `npm test` — leave the terminal scrolled to the 24/24 result (0:00 proof).
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
   - `npm test` → 24/24, including the fee-split model that matches all 19 live
     `ProtocolFeesAllocated` events to the wei.

3. **SDK + simulator in one breath (40s)**
   - `node examples/01-predict-pool.mjs` → prints predicted token + poolId, asserts match.
   - Show `packages/sim/src/fee.ts` — `feePipsForElapsed` (90%→1% over 5s) and
     `splitCreatorFee` / `splitProtocolFee` (the exact on-chain split).

4. **CLI live on testnet (60s)**
   - `npm run cli -- config` → chain, addresses, quote — all read from chain.
   - `npm run cli -- pools` → 8 real pools, creators, seed, ages.
   - `npm run cli -- decode 0x91f35a45ae05d1a2e10e3202845275375bd93790d4d3d39def792a46eb1c8164`
     → launch params + predicted token/poolId matching the live token + decoded events.
   - `npm run cli -- pool 0x20c97309F0e1849d2403F97d56D619845C7b2253` → fee now vs scheduled.

5. **Telegram bot (30s, if wallet funded)**
   - `/start` → menu; `/pools` → recent pools; `/pool <token>` → fee state; `/watch <token>` → live events.

6. **Roadmap + close (20s)**
   - `README.md` roadmap tab: M1/M2 shipped, M3 fill simulator replaying real `Filled`
     events, M4 bot wizard, M5 publish. Post-launch: hosted read API, multi-launchpad.

## Notes

- Keep raw JSON output in frame — it doubles as proof against the explorer.
- If the bot segment is skipped, say why in one line ("bot demo needs a funded testnet
  wallet; the code is in `apps/bot` and builds in CI"). Honesty reads better than cuts.
