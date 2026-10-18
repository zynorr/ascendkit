export interface FillSimInput {
  sellTokens: bigint
  spotSqrtPriceX96: bigint
  emaSqrtPriceX96: bigint
  bidInventory: bigint
  maxClip: bigint
  windowSpent: bigint
}

export interface FillSimResult {
  fillQuote: bigint
  fillTokens: bigint
  feeTokens: bigint
  ammTokensOut: bigint
}

/**
 * Simulate a sell against a launchpad pool with the flywheel fill included.
 *
 * Lands in M3. The algorithm is in the verified source, `AscendLaunchpad._fill`:
 * the bid is the counterparty to part of the sell at the EMA spot (compared in
 * sqrt space with the half-bps approximation), capped by
 * min(bidInventory, maxClip - windowSpent), fee-neutral to the seller, and the
 * remainder routes through the CL AMM. M3 replays every real `Filled` event in
 * fixtures/raw/filled.json and must reproduce tokensIn/feeTokens/quotePaid to
 * the wei.
 */
export function simulateFill(_input: FillSimInput): FillSimResult {
  throw new Error('simulateFill lands in M3 (replays fixtures/raw/filled.json)')
}
