import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { FLYWHEEL } from '@ascendkit/core'
import {
  observeEma,
  simulateFill,
  windowStateBefore,
  withinBand,
  type FillLog,
  type FillStandingState,
  type FillSwap
} from './fill.js'
import { splitProtocolFee } from './fee.js'

interface StandingFixture {
  meta: { launchpad: string; poolManager: string; vault: string }
  fills: Array<{
    poolId: string
    token: string
    txHash: string
    blockNumber: number
    blockTimestamp: number
    filled: { tokensIn: string; feeTokens: string; tokensBurned: string; quotePaid: string }
    atPriorBlock: {
      blockNumber: number
      launchedAt: number
      tokenIs0: boolean
      startTick: number
      currentFee: number
      maxClip: string
      bidInventory: string
      emaSqrtPrice: string
      emaUpdatedAt: number
      spotSqrtPriceX96: string
      spotTick: number
      vaultTokenBalance: string
    }
    atFillBlock: { emaSqrtPrice: string; bidInventory: string; emaUpdatedAt: number }
  }>
}

interface RawLog {
  topics: string[]
  data: string
  transactionHash: string
  blockTimestamp: string
}

const standing = JSON.parse(
  readFileSync(new URL('../../../fixtures/raw/fill-standing.json', import.meta.url), 'utf8')
) as StandingFixture
const protocolFees = JSON.parse(
  readFileSync(new URL('../../../fixtures/raw/protocolfees.json', import.meta.url), 'utf8')
) as RawLog[]
const tokensAccumulated = JSON.parse(
  readFileSync(new URL('../../../fixtures/raw/tokensaccumulated.json', import.meta.url), 'utf8')
) as RawLog[]

const words = (data: string): bigint[] => {
  const hex = data.slice(2)
  return Array.from({ length: hex.length / 64 }, (_, i) =>
    BigInt(`0x${hex.slice(i * 64, (i + 1) * 64)}`)
  )
}

const pad = (address: string) => `0x${address.slice(2).toLowerCase().padStart(64, '0')}`

const fillLogs: FillLog[] = standing.fills.map((f) => ({
  blockTimestamp: f.blockTimestamp,
  quotePaid: BigInt(f.filled.quotePaid)
}))

const stateAt = (fill: StandingFixture['fills'][number], order: number): FillStandingState => {
  const prior = fill.atPriorBlock
  const window = windowStateBefore(
    fillLogs.slice(0, order),
    fill.blockTimestamp
  )
  return {
    tokenIs0: prior.tokenIs0,
    feePips: prior.currentFee,
    spotSqrtPriceX96: BigInt(prior.spotSqrtPriceX96),
    emaSqrtPriceX96: BigInt(fill.atFillBlock.emaSqrtPrice),
    bidInventory: BigInt(prior.bidInventory),
    maxClip: BigInt(prior.maxClip),
    windowSpent: window.filledInWindow,
    windowExpired: window.expired,
    vaultTokenBalance: BigInt(prior.vaultTokenBalance)
  }
}

const sellOf = (fill: StandingFixture['fills'][number], tokensIn: bigint): FillSwap => {
  const spot = BigInt(fill.atPriorBlock.spotSqrtPriceX96)
  return {
    amountSpecified: -tokensIn,
    zeroForOne: fill.atPriorBlock.tokenIs0,
    sqrtPriceLimitX96: fill.atPriorBlock.tokenIs0 ? spot - 1n : spot + 1n
  }
}

describe('fill replay (both real Filled events, wei-exact)', () => {
  standing.fills.forEach((fill, order) => {
    const label = `fill ${order + 1} (block ${fill.blockNumber})`

    it(`${label}: window state reconstructs from Filled logs alone`, () => {
      const window = windowStateBefore(fillLogs.slice(0, order), fill.blockTimestamp)
      if (order === 0) {
        expect(window.windowStart).toBe(0)
        expect(window.filledInWindow).toBe(0n)
        expect(window.expired).toBe(true)
      } else {
        const first = standing.fills[0]!
        expect(window.windowStart).toBe(first.blockTimestamp)
        expect(window.filledInWindow).toBe(BigInt(first.filled.quotePaid))
        expect(window.expired).toBe(false)
        expect(fill.blockTimestamp - window.windowStart).toBeLessThan(
          FLYWHEEL.FILL_WINDOW_SECONDS
        )
      }
    })

    it(`${label}: _observe reproduces the stored EMA to the wei`, () => {
      const prior = fill.atPriorBlock
      const dt = fill.blockTimestamp - prior.emaUpdatedAt
      const observed = observeEma(BigInt(prior.emaSqrtPrice), BigInt(prior.spotSqrtPriceX96), dt)
      expect(observed).toBe(BigInt(fill.atFillBlock.emaSqrtPrice))
    })

    it(`${label}: spot sits inside the post-observe EMA band`, () => {
      const prior = fill.atPriorBlock
      expect(withinBand(BigInt(prior.spotSqrtPriceX96), BigInt(fill.atFillBlock.emaSqrtPrice))).toBe(
        true
      )
    })

    it(`${label}: simulateFill reproduces tokensIn / feeTokens / quotePaid`, () => {
      const state = stateAt(fill, order)
      const swap = sellOf(fill, BigInt(fill.filled.tokensIn))
      const result = simulateFill(state, swap)
      expect(result.filled).toBe(true)
      if (!result.filled) return

      expect(result.tokensIn).toBe(BigInt(fill.filled.tokensIn))
      expect(result.feeTokens).toBe(BigInt(fill.filled.feeTokens))
      expect(result.quotePaid).toBe(BigInt(fill.filled.quotePaid))
      expect(result.netTokens).toBe(
        BigInt(fill.filled.tokensIn) - BigInt(fill.filled.feeTokens)
      )
      expect(result.ammTokens).toBe(0n)
      expect(result.capped).toBe(false)
    })

    it(`${label}: side effects match the same-transaction events to the wei`, () => {
      const state = stateAt(fill, order)
      const result = simulateFill(state, sellOf(fill, BigInt(fill.filled.tokensIn)))
      expect(result.filled).toBe(true)
      if (!result.filled) return

      const pf = protocolFees.find(
        (log) =>
          log.transactionHash === fill.txHash &&
          log.topics[2]?.toLowerCase() === pad(fill.token)
      )
      expect(pf).toBeDefined()
      const [sy, tr, ec, op, kq] = words(pf!.data)
      expect(result.protocolFees).toEqual({
        stakerYield: sy,
        treasury: tr,
        ecosystem: ec,
        opex: op,
        kntq: kq
      })
      expect(result.protocolFeeTokens).toBe(sy! + tr! + ec! + op! + kq!)
      expect(result.creatorFeeTokens).toBe(result.feeTokens - result.protocolFeeTokens)
      expect(splitProtocolFee(result.protocolFeeTokens)).toEqual(result.protocolFees)

      const accumulated = tokensAccumulated.find(
        (log) =>
          log.transactionHash === fill.txHash &&
          log.topics[2]?.toLowerCase() === pad(fill.token) &&
          Number(log.topics[3]) === 1
      )
      expect(accumulated).toBeDefined()
      expect(result.accumulatedTokens).toBe(words(accumulated!.data)[0])
      expect(result.reservedTokens).toBe(result.netTokens - result.accumulatedTokens)
    })

    it(`${label}: the bid's inventory drops by exactly quotePaid`, () => {
      const result = simulateFill(
        stateAt(fill, order),
        sellOf(fill, BigInt(fill.filled.tokensIn))
      )
      expect(result.filled).toBe(true)
      if (!result.filled) return
      expect(BigInt(fill.atFillBlock.bidInventory)).toBe(
        BigInt(fill.atPriorBlock.bidInventory) - result.quotePaid
      )
    })
  })
})

describe('fill declines mirror the source gates', () => {
  const base = stateAt(standing.fills[0]!, 0)
  const sell = sellOf(standing.fills[0]!, BigInt(standing.fills[0]!.filled.tokensIn))

  it('exact-output swaps decline', () => {
    const r = simulateFill(base, { ...sell, amountSpecified: 1n })
    expect(r).toEqual({ filled: false, reason: 'not-exact-input' })
  })

  it('buys (and direction mismatches) decline', () => {
    const r = simulateFill(base, { ...sell, zeroForOne: !base.tokenIs0 })
    expect(r).toEqual({ filled: false, reason: 'not-a-token-sell' })
  })

  it('inputs over the int128 wire bound decline without panicking', () => {
    const r = simulateFill(base, { ...sell, amountSpecified: -(1n << 127n) })
    expect(r).toEqual({ filled: false, reason: 'oversized-input' })
  })

  it('an unfunded bid declines', () => {
    const r = simulateFill({ ...base, bidInventory: 0n }, sell)
    expect(r).toEqual({ filled: false, reason: 'no-inventory' })
  })

  it('an exhausted window declines', () => {
    const r = simulateFill(
      { ...base, windowSpent: base.maxClip, windowExpired: false },
      sell
    )
    expect(r).toEqual({ filled: false, reason: 'window-exhausted' })
  })

  it('a price outside the EMA band declines (fail open, never revert)', () => {
    const r = simulateFill({ ...base, emaSqrtPriceX96: base.spotSqrtPriceX96 * 2n }, sell)
    expect(r).toEqual({ filled: false, reason: 'outside-ema-band' })
  })

  it('an invalid price limit declines', () => {
    const r = simulateFill(base, {
      ...sell,
      sqrtPriceLimitX96: base.tokenIs0
        ? base.spotSqrtPriceX96 + 1n
        : base.spotSqrtPriceX96 - 1n
    })
    expect(r).toEqual({ filled: false, reason: 'bad-price-limit' })
  })

  it('a vault that cannot front the tokens declines', () => {
    const r = simulateFill(
      { ...base, vaultTokenBalance: BigInt(standing.fills[0]!.filled.tokensIn) - 1n },
      sell
    )
    expect(r).toEqual({ filled: false, reason: 'vault-cannot-front' })
  })

  it('an aged-out window resets the allowance to the full clip', () => {
    const r = simulateFill(
      { ...base, windowSpent: base.maxClip, windowExpired: true },
      sell
    )
    expect(r.filled).toBe(true)
  })
})

describe('the window clamp', () => {
  const fill = standing.fills[0]!
  const state = stateAt(fill, 0)
  const sell = sellOf(fill, BigInt(fill.filled.tokensIn))

  it('caps by maxClip, converts back, and leaves the remainder to the AMM', () => {
    const r = simulateFill({ ...state, maxClip: 1000n }, sell)
    expect(r.filled).toBe(true)
    if (!r.filled) return
    expect(r.capped).toBe(true)
    expect(r.quotePaid).toBeLessThanOrEqual(1000n)
    expect(r.tokensIn).toBeLessThan(BigInt(fill.filled.tokensIn))
    expect(r.ammTokens).toBe(BigInt(fill.filled.tokensIn) - r.tokensIn)
  })

  it('caps by inventory when it is the smaller bound', () => {
    const r = simulateFill({ ...state, bidInventory: 500n }, sell)
    expect(r.filled).toBe(true)
    if (!r.filled) return
    expect(r.capped).toBe(true)
    expect(r.quotePaid).toBeLessThanOrEqual(500n)
  })

  it('is idempotent: re-pricing the capped input reproduces it exactly', () => {
    const capped = simulateFill({ ...state, maxClip: 1000n }, sell)
    expect(capped.filled).toBe(true)
    if (!capped.filled) return
    const again = simulateFill({ ...state, maxClip: 1000n }, {
      ...sell,
      amountSpecified: -capped.tokensIn
    })
    expect(again.filled).toBe(true)
    if (!again.filled) return
    expect(again.tokensIn).toBe(capped.tokensIn)
    expect(again.quotePaid).toBe(capped.quotePaid)
    expect(again.feeTokens).toBe(capped.feeTokens)
  })
})

describe('observeEma', () => {
  it('adds nothing in the same second', () => {
    expect(observeEma(100n, 200n, 0)).toBe(100n)
  })

  it('clamps dt at EMA_MAX_DT (at most 50% per quiet update)', () => {
    expect(observeEma(100n, 200n, 600)).toBe(150n)
    expect(observeEma(100n, 200n, 100_000)).toBe(150n)
  })

  it('walks toward the spot from both sides', () => {
    expect(observeEma(100n, 300n, 200)).toBe(150n)
    expect(observeEma(300n, 100n, 200)).toBe(250n)
  })
})
