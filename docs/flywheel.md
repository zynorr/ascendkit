# The flywheel fill, pinned

`AscendLaunchpad.beforeSwap` runs `_observe` then `_fill` on every swap. `_fill`
turns the pool's standing bid into the counterparty for part of a sell: the
swap's token currently only trades against the CL curve, so the launchpad
extends it with quote set aside in `fundBid`. This document pins the exact
rules, line by line against the verified source
(`tools/abi-extract/vendor/src/AscendLaunchpad.sol`), and states what the
simulator replays.

## Eligibility gates (any failure → `ZERO_DELTA`, the AMM takes the whole swap)

| # | Gate | Source |
|---|---|---|
| 1 | `amountSpecified < 0` — exact-input only | line 689 |
| 2 | `zeroForOne == p.tokenIs0` — only sells where the token is paid in | line 692 |
| 3 | `amountSpecified >= -MAX_DELTA`, `MAX_DELTA = uint128(int128.max) = 2^127 − 1` | lines 97, 702 |
| 4 | `bid.inventory != 0` | line 707 |
| 5 | window allowance: `maxClip − filledInWindow` (0 if the window has aged out → full `maxClip`) | lines 712-717 |
| 6 | `spot != 0` and `spot` within the stored EMA's band | line 729 |
| 7 | price limit valid for the direction (`sqrtPriceLimitX96` on the correct side of spot and inside tick bounds) | lines 734-738 |
| 8 | on a capped fill, re-derived `tokensIn <= sellSize` and `quoteOut <= cap` | lines 762, 765 |
| 9 | `net != 0 && quoteOut != 0` | line 767 |
| 10 | vault already holds `tokensIn` (`token.balanceOf(vault) >= tokensIn`) | line 782 |

The band is compared in sqrt space with the half-bps approximation the
recycler used: `half = ema * 500 / 20000` (i.e. `sqrt(1 ± 5%) ≈ 1 ± 2.5%`),
so a fill only happens at a price the EMA has actually observed (line 819-823).

## Amount math (all `FullMath.mulDiv`, all floors)

```
priceX96 = mulDiv(spot, spot, 2^96)                     # pool price, currency1 per currency0
tokensIn = sellSize
net      = mulDiv(tokensIn, 1e6 − fee, 1e6)            # the AMM's own amountRemainingLessFee
quoteOut = tokenIs0 ? mulDiv(net, priceX96, 2^96)
                    : mulDiv(net, 2^96, priceX96)
```

`fee` is the lifecycle fee from `_poolFee`: `BASE + (START − BASE) × remaining / 5`
for the first 5 seconds, then `BASE = 10_000 pips` forever (line 897).

## The window cap

The bid spends at most `maxClip` quote per `FILL_WINDOW = 10 minutes`:

```
allowance = windowExpired ? maxClip : maxClip − filledInWindow   # 0 if exhausted
cap       = min(inventory, allowance, MAX_DELTA)
if quoteOut > cap:                                     # clamped fill
    net      = mulDiv(cap, 2^96, priceX96)   (tokenIs0; inverse otherwise)
    tokensIn = mulDiv(net, 1e6, 1e6 − fee)             # grossed back up, floors down
    net      = mulDiv(tokensIn, 1e6 − fee, 1e6)        # recomputed from the actual input
    quoteOut = _quoteFor(net, priceX96, tokenIs0)      # lands at or just under cap
```

The lower `tokensIn` claims less of the swap than the quote pays for; the wei
or two under the cap stays in inventory for a later fill (lines 752-766).

## Booking (before any external transfer)

```
feeTokens   = tokensIn − net
creatorT    = feeTokens × 5000 / 10000                 # to creatorOwedToken
protocolFee = feeTokens − creatorT                     # _routeProtocolFees(token)
reserved    = net × 2000 / 10000                       # STAKERS_BPS → cohort treasury
accumulated = net − reserved                           # → inventory treasury
```

`_routeProtocolFees` allocates floors to staker yield (500 bps), treasury
(2000), ecosystem (1500) and KNTQ (5000) with **opex taking the remainder**
(1000 bps nominal) — the same allocation that `collect()` uses, so fee
accounting has exactly one shape (lines 440-452).

Then: `inventory -= quoteOut`, the window pair is rolled forward lazily
(`windowStart = now; filledInWindow = quoteOut` if expired, else `+= quoteOut`),
the vault fronts `tokensIn` to the contract, protocol fees and the two token
legs move, `vault.pay(quote, quoteOut)` settles the seller, and
`Filled(poolId, tokensIn, feeTokens, 0, quotePaid=quoteOut)` is emitted
(lines 788-812). The `TokensAccumulated` event in the same transaction carries
`accumulated` with `source = Purchase`.

## The EMA

`_observe` runs before `_fill` on every swap (line 658). It weights the
pre-swap spot (clamped to the curve bounds so an empty-liquidity traversal
cannot drag it) into the stored sqrt price with `dt` capped at `EMA_MAX_DT =
600` seconds: `ema += (spot − ema) × dt / (dt + 600)`; same-second swaps add
nothing (lines 864-880). A fill is therefore evaluated against the EMA
*including* the pre-swap observation of the very block it runs in.

Because `_observe` stores its result, `emaSqrtPrice(poolId)` read at the fill's
own block **is** the value the band check used — which is what makes the
replay below exact.

## What the SDK replays, and to what precision

`packages/sim/src/fill.ts` implements every gate and conversion above in
BigInt. The test suite replays both real `Filled` events in
`fixtures/raw/filled.json` against the launchpad's state at the fill block
(`fixtures/raw/fill-standing.json`, fetched by
`tools/fixtures/fetch-fill-standing.mjs`):

- `tokensIn`, `feeTokens`, `quotePaid` — reproduced **to the wei**;
- `creatorT` and the five protocol legs — matched against the
  `ProtocolFeesAllocated` event emitted in the same transaction;
- `reserved` / `accumulated` — matched against the same transaction's
  `TokensAccumulated` (source `Purchase`);
- the window pair — reconstructed from the `Filled` log history alone, exactly
  as the source intends (the struct has no getters, by design, line 149-151):
  `filledInWindow = Σ quotePaid` over logs inside the trailing `FILL_WINDOW`.

One gate cannot be replayed from chain state a block earlier: the vault
balance check (gate 10). The fixture pins `token.balanceOf(vault)` at the
prior block anyway, so the test distinguishes "the fill passed the gate it
would have" from "we assumed it did".

## What the SDK does not simulate

The AMM half of a swap. A fill absorbs at most `cap` quote of a sell; the
remainder walks the CL curve, whose output depends on live liquidity and tick
state. `simulateFill` reports the fill side exactly and the **token amount left
for the AMM** (`ammTokens`), not its output.
