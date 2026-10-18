import { FEE, PROTOCOL_BPS } from '@ascendkit/core'

/**
 * Swap fee for a pool, in pips, given seconds elapsed since launch:
 * START_FEE while `FEE.DECAY_SECONDS` haven't passed, then BASE_FEE forever.
 * Integer math mirrors the Solidity exactly: base + (start - base) * (decay - t) / decay.
 */
export function feePipsForElapsed(elapsedSeconds: number | bigint): number {
  const elapsed = BigInt(elapsedSeconds)
  if (elapsed >= FEE.DECAY_SECONDS) return FEE.BASE_PIPS
  const clamped = elapsed < 0n ? 0n : elapsed
  const decayLeft = FEE.DECAY_SECONDS - clamped
  const span = BigInt(FEE.START_PIPS - FEE.BASE_PIPS)
  return FEE.BASE_PIPS + Number((span * decayLeft) / FEE.DECAY_SECONDS)
}

/** Current fee of a pool, in pips, as of `nowUnix`, launched at `launchedAt`. */
export function feePipsNow(
  launchedAt: number | bigint,
  nowUnix: number | bigint
): number {
  return feePipsForElapsed(BigInt(nowUnix) - BigInt(launchedAt))
}

export interface FeeStep {
  elapsedSeconds: number
  pips: number
  percent: number
}

/** Schedule rows for the first `horizonSeconds` of a pool's life. */
export function feeSchedule(horizonSeconds = 12): FeeStep[] {
  const rows: FeeStep[] = []
  for (let t = 0; t <= horizonSeconds; t++) {
    const pips = feePipsForElapsed(t)
    rows.push({ elapsedSeconds: t, pips, percent: pips / 10_000 })
  }
  return rows
}

export interface CreatorFeeSplit {
  /** 50% of collected fees, floor — paid to the pool creator as claimable balance. */
  creator: bigint
  /** The protocol half, ceil (creator floor takes the remainder). */
  protocol: bigint
}

/** Split collected fees between creator and protocol. Verified against live ProtocolFeesAllocated events. */
export function splitCreatorFee(amount: bigint): CreatorFeeSplit {
  const creator = amount / 2n
  return { creator, protocol: amount - creator }
}

export interface ProtocolFeeSplit {
  stakerYield: bigint
  treasury: bigint
  ecosystem: bigint
  /** Remainder holder: opex absorbs the rounding dust so the split is exact. */
  opex: bigint
  kntq: bigint
}

/**
 * Split the protocol half by the on-chain bps schedule (stakerYield 5%, treasury 20%,
 * ecosystem 15%, kntq 50% — all floor), with opex taking the remainder. Verified
 * against all 19 live ProtocolFeesAllocated events.
 */
export function splitProtocolFee(amount: bigint): ProtocolFeeSplit {
  const b = (bps: number) => (amount * BigInt(bps)) / 10_000n
  const stakerYield = b(PROTOCOL_BPS.STAKER_YIELD)
  const treasury = b(PROTOCOL_BPS.TREASURY)
  const ecosystem = b(PROTOCOL_BPS.ECOSYSTEM)
  const kntq = b(PROTOCOL_BPS.KNTQ)
  const opex = amount - (stakerYield + treasury + ecosystem + kntq)
  return { stakerYield, treasury, ecosystem, opex, kntq }
}
