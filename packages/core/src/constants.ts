import type { Hex } from 'viem'

/** Swap fee schedule of every launchpad pool, in pips (1/100 of a bip). */
export const FEE = {
  /** Fee after the decay window: 1%. */
  BASE_PIPS: 10_000,
  /** Fee at launch: 90% sniper tax. */
  START_PIPS: 900_000,
  /** Seconds over which START decays linearly to BASE. */
  DECAY_SECONDS: 5n
} as const

/** Pool-key constants shared by every launchpad pool. */
export const POOL = {
  TICK_SPACING: 200,
  HOOK_BITMAP: 0x0445,
  DYNAMIC_FEE_FLAG: 0x800000,
  OVERRIDE_FEE_FLAG: 0x400000,
  MAX_LP_FEE: 1_000_000,
  /** bytes32(uint256(HOOK_BITMAP) | (uint256(uint24(TICK_SPACING)) << 16)). */
  POOL_PARAMETERS:
    '0x0000000000000000000000000000000000000000000000000000000000c80445' as Hex
} as const

/** Split of the launchpad's protocol fee half, in bps. */
export const PROTOCOL_BPS = {
  TREASURY: 2_000,
  ECOSYSTEM: 1_500,
  STAKER_YIELD: 500,
  KNTQ: 5_000,
  OPEX: 1_000
} as const

/** Creator's share of every collected fee, in bps (flat in code). */
export const CREATOR_BPS = 5_000

/** Flywheel (standing-bid) constants. */
export const FLYWHEEL = {
  /** EMA half-... time constant of the stored sqrt price, seconds. */
  EMA_TAU_SECONDS: 600,
  /** Fill band around the EMA, in bps of price (5%). */
  FILL_BAND_BPS: 500,
  /** Per-pool quote spending window, seconds. */
  FILL_WINDOW_SECONDS: 600,
  /** Share of net purchased tokens reserved for the staker cohort, bps. */
  STAKERS_BPS: 2_000
} as const

/** HyperCore listing desk constants. */
export const LISTING = {
  /** Share of the creator's quote fees set aside while enrolled, bps. */
  SET_ASIDE_BPS: 2_000,
  /** Creator may only commit the listing during this window after enrolling, seconds. */
  COMMIT_WINDOW_SECONDS: 604_800,
  /** Share of the desk's Core fee paid by the creator, bps. */
  CORE_FEE_CREATOR_BPS: 5_000
} as const

/** Total supply of every launched token, in wei. */
export const TOTAL_SUPPLY = 1_000_000_000n * 10n ** 18n
