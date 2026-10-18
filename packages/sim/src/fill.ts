import { FLYWHEEL } from '@ascendkit/core'
import { splitCreatorFee, splitProtocolFee, type ProtocolFeeSplit } from './fee.js'

/** Q96 fixed-point scalar (2^96). */
const Q96 = 1n << 96n

/** The wire bound of a BeforeSwapDelta: uint128(int128.max) = 2^127 - 1. */
const MAX_DELTA = (1n << 127n) - 1n

/** 100% in pips; the lifecycle fee's denominator. */
const MAX_LP_FEE = 1_000_000n

/** floor(a * b / d) via BigInt — the only arithmetic the hooks use. */
function mulDiv(a: bigint, b: bigint, d: bigint): bigint {
  return (a * b) / d
}

/** `_lessFee`: the AMM's own `amountRemainingLessFee`. */
export function lessFee(amount: bigint, feePips: number | bigint): bigint {
  return mulDiv(amount, MAX_LP_FEE - BigInt(feePips), MAX_LP_FEE)
}

/** `_priceX96`: the pool price (currency1 per currency0) at a sqrt price. */
export function priceX96Of(sqrtPriceX96: bigint): bigint {
  return mulDiv(sqrtPriceX96, sqrtPriceX96, Q96)
}

/** `_quoteFor`: quote owed for `tokens` at `priceX96`. */
export function quoteFor(tokens: bigint, priceX96: bigint, tokenIs0: boolean): bigint {
  if (priceX96 === 0n) return 0n
  return tokenIs0 ? mulDiv(tokens, priceX96, Q96) : mulDiv(tokens, Q96, priceX96)
}

/** `_tokensFor`: the inverse of `quoteFor`, rounding down. */
export function tokensFor(quote: bigint, priceX96: bigint, tokenIs0: boolean): bigint {
  if (priceX96 === 0n) return 0n
  return tokenIs0 ? mulDiv(quote, Q96, priceX96) : mulDiv(quote, priceX96, Q96)
}

/**
 * `_withinBand`: is `spot` within FILL_BAND_BPS of the EMA, in price terms?
 * Compared in sqrt space with the half-bps approximation (sqrt(1±d) ≈ 1 ± d/2),
 * so `half = ema * 500 / 20000`.
 */
export function withinBand(spot: bigint, ema: bigint): boolean {
  if (ema === 0n) return false
  const half = (ema * BigInt(FLYWHEEL.FILL_BAND_BPS)) / 20_000n
  return spot >= ema - half && spot <= ema + half
}

/**
 * One EMA step of `_observe`: `ema += (spot - ema) * dt / (dt + EMA_TAU)`, with
 * dt capped at EMA_MAX_DT (600 s) and a no-op when dt is zero. The contract
 * clamps `spot` to the curve bounds before this; pass the clamped spot.
 */
export function observeEma(prevEma: bigint, spot: bigint, dtSeconds: number | bigint): bigint {
  let dt = BigInt(dtSeconds)
  if (dt === 0n) return prevEma
  if (dt > BigInt(FLYWHEEL.EMA_TAU_SECONDS)) dt = BigInt(FLYWHEEL.EMA_TAU_SECONDS)
  const tau = BigInt(FLYWHEEL.EMA_TAU_SECONDS)
  if (spot >= prevEma) return prevEma + ((spot - prevEma) * dt) / (dt + tau)
  return prevEma - ((prevEma - spot) * dt) / (dt + tau)
}

/**
 * The standing state `_fill` reads, one block before the swap it judges.
 * `windowSpent` is the quote already filled in the trailing `FILL_WINDOW`
 * (reconstruct it from `Filled` logs with `windowStateBefore`; the contract's
 * window pair has no getters, by design).
 */
export interface FillStandingState {
  tokenIs0: boolean
  /** Lifecycle fee at the fill block, in pips (`currentFee`). */
  feePips: number
  spotSqrtPriceX96: bigint
  /** The EMA the band check compares against (post-`_observe` for a replay). */
  emaSqrtPriceX96: bigint
  bidInventory: bigint
  maxClip: bigint
  windowSpent: bigint
  /** True when the trailing window has aged out (allowance resets to maxClip). */
  windowExpired?: boolean
  /** Gate 10; omit to assume the vault can front the tokens. */
  vaultTokenBalance?: bigint
}

export interface FillSwap {
  /** Negative for exact-input sells (`amountSpecified`). */
  amountSpecified: bigint
  zeroForOne: boolean
  /** Omit to skip the price-limit gate (the caller guarantees a valid limit). */
  sqrtPriceLimitX96?: bigint
}

export type FillDeclineReason =
  | 'not-exact-input'
  | 'not-a-token-sell'
  | 'oversized-input'
  | 'no-inventory'
  | 'window-exhausted'
  | 'spot-zero'
  | 'outside-ema-band'
  | 'bad-price-limit'
  | 'capped-rederivation'
  | 'zero-amounts'
  | 'vault-cannot-front'

export interface FillFilled {
  filled: true
  /** Token amount the bid absorbs (<= the swap's input). */
  tokensIn: bigint
  /** Lifecycle fee on the absorbed tokens. */
  feeTokens: bigint
  /** Tokens net of the fee: the purchased principal. */
  netTokens: bigint
  /** Quote paid to the seller at spot. */
  quotePaid: bigint
  /** Fee share booked to the creator. */
  creatorFeeTokens: bigint
  /** Fee share booked to the protocol (token side). */
  protocolFeeTokens: bigint
  protocolFees: ProtocolFeeSplit
  /** Net principal reserved for the staker cohort. */
  reservedTokens: bigint
  /** Net principal accumulated to the inventory treasury. */
  accumulatedTokens: bigint
  /** True when min(inventory, allowance) clamped the fill. */
  capped: boolean
  /** Token amount left for the AMM to fill (output not modeled). */
  ammTokens: bigint
}

export interface FillDeclined {
  filled: false
  reason: FillDeclineReason
}

export type FillResult = FillFilled | FillDeclined

/**
 * Simulate the flywheel's exact-input sell fill, mirroring
 * `AscendLaunchpad._fill` gate by gate and wei by wei (constants in
 * `FLYWHEEL`; allocation shared with `collect()`). Every conversion floors;
 * `tokensIn`/`feeTokens`/`quotePaid` reproduce the on-chain `Filled` event for
 * the fixture swaps in `fixtures/raw/filled.json` to the wei.
 */
export function simulateFill(state: FillStandingState, swap: FillSwap): FillResult {
  // Gate 1: exact-input only.
  if (swap.amountSpecified >= 0n) return { filled: false, reason: 'not-exact-input' }
  // Gate 2: only a sell where the token is paid in.
  if (swap.zeroForOne !== state.tokenIs0) return { filled: false, reason: 'not-a-token-sell' }
  // Gate 3: the delta's wire bound, compared before negating.
  if (swap.amountSpecified < -MAX_DELTA) return { filled: false, reason: 'oversized-input' }
  const sellSize = -swap.amountSpecified

  // Gate 4: an unfunded bid never fills.
  if (state.bidInventory === 0n) return { filled: false, reason: 'no-inventory' }

  // Gate 5: the lazily rolled window rate limit.
  const perWindow = state.maxClip
  const allowance = state.windowExpired
    ? perWindow
    : state.windowSpent >= perWindow
      ? 0n
      : perWindow - state.windowSpent
  if (allowance === 0n) return { filled: false, reason: 'window-exhausted' }

  // Gate 6: spot must sit inside the stored EMA's band.
  const spot = state.spotSqrtPriceX96
  if (spot === 0n) return { filled: false, reason: 'spot-zero' }
  if (!withinBand(spot, state.emaSqrtPriceX96)) {
    return { filled: false, reason: 'outside-ema-band' }
  }

  // Gate 7: the pool never sees a fill with an invalid limit (it stops
  // checking once a hook fill zeroes the swap, so the hook does).
  if (swap.sqrtPriceLimitX96 !== undefined) {
    const limit = swap.sqrtPriceLimitX96
    const MIN_SQRT_PRICE = 4295128739n
    const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n
    const bad = swap.zeroForOne
      ? limit >= spot || limit <= MIN_SQRT_PRICE
      : limit <= spot || limit >= MAX_SQRT_PRICE
    if (bad) return { filled: false, reason: 'bad-price-limit' }
  }

  // Amount math: the fee comes off the top, the seller is paid spot flat.
  const priceX96 = priceX96Of(spot)
  let tokensIn = sellSize
  let net = lessFee(tokensIn, state.feePips)
  let quoteOut = quoteFor(net, priceX96, state.tokenIs0)

  // The clamp: min(inventory, allowance, MAX_DELTA), then convert back so the
  // delta can never claim more of the swap than the quote pays for.
  let cap = state.bidInventory < allowance ? state.bidInventory : allowance
  if (cap > MAX_DELTA) cap = MAX_DELTA
  let capped = false
  if (quoteOut > cap) {
    capped = true
    net = tokensFor(cap, priceX96, state.tokenIs0)
    tokensIn = mulDiv(net, MAX_LP_FEE, MAX_LP_FEE - BigInt(state.feePips))
    if (tokensIn > sellSize) return { filled: false, reason: 'capped-rederivation' }
    net = lessFee(tokensIn, state.feePips)
    quoteOut = quoteFor(net, priceX96, state.tokenIs0)
    if (quoteOut > cap) return { filled: false, reason: 'capped-rederivation' }
  }
  // Gate 9: nothing zero ever books.
  if (net === 0n || quoteOut === 0n) return { filled: false, reason: 'zero-amounts' }

  // Gate 10: the vault must already hold what it fronts.
  if (state.vaultTokenBalance !== undefined && state.vaultTokenBalance < tokensIn) {
    return { filled: false, reason: 'vault-cannot-front' }
  }

  const feeTokens = tokensIn - net
  const { creator: creatorFeeTokens, protocol: protocolFeeTokens } = splitCreatorFee(feeTokens)
  const reservedTokens = (net * BigInt(FLYWHEEL.STAKERS_BPS)) / 10_000n
  const accumulatedTokens = net - reservedTokens

  return {
    filled: true,
    tokensIn,
    feeTokens,
    netTokens: net,
    quotePaid: quoteOut,
    creatorFeeTokens,
    protocolFeeTokens,
    protocolFees: splitProtocolFee(protocolFeeTokens),
    reservedTokens,
    accumulatedTokens,
    capped,
    ammTokens: sellSize - tokensIn
  }
}

export interface FillLog {
  blockTimestamp: number
  quotePaid: bigint
}

export interface WindowState {
  windowStart: number
  filledInWindow: bigint
  /** True when a fill at `atTimestamp` would roll the window forward. */
  expired: boolean
}

/**
 * Reconstruct the bid's window pair before `atTimestamp` from `Filled` logs
 * alone — the contract's struct has no getters, precisely because this is
 * exact (AscendLaunchpad.sol, `Bid` doc comment). Mirrors the lazy roll
 * forward: a fill at or after `windowStart + FILL_WINDOW` resets both fields.
 */
export function windowStateBefore(fills: FillLog[], atTimestamp: number): WindowState {
  const window = BigInt(FLYWHEEL.FILL_WINDOW_SECONDS)
  let windowStart = 0
  let filledInWindow = 0n
  for (const fill of fills) {
    if (fill.blockTimestamp >= atTimestamp) break
    if (BigInt(fill.blockTimestamp) >= BigInt(windowStart) + window) {
      windowStart = fill.blockTimestamp
      filledInWindow = fill.quotePaid
    } else {
      filledInWindow += fill.quotePaid
    }
  }
  return {
    windowStart,
    filledInWindow,
    expired: BigInt(atTimestamp) >= BigInt(windowStart) + window
  }
}
