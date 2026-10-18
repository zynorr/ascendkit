import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  getSqrtPriceAtTick,
  MAX_SQRT_RATIO,
  MAX_TICK,
  MIN_SQRT_RATIO,
  MIN_TICK
} from './tick.js'
import { curveBoundsOf, curveTopOf } from './curve.js'
import { POOL } from './constants.js'

interface StandingFixture {
  fills: Array<{
    atPriorBlock: {
      tokenIs0: boolean
      startTick: number
      spotSqrtPriceX96: string
      spotTick: number
    }
  }>
}

const standing = JSON.parse(
  readFileSync(new URL('../../../fixtures/raw/fill-standing.json', import.meta.url), 'utf8')
) as StandingFixture

describe('getSqrtPriceAtTick', () => {
  it('tick 0 is exactly 2^96', () => {
    expect(getSqrtPriceAtTick(0)).toBe(1n << 96n)
  })

  it('brackets the live slot0 spot price with its reported tick', () => {
    const prior = standing.fills[0]!.atPriorBlock
    const spot = BigInt(prior.spotSqrtPriceX96)
    expect(getSqrtPriceAtTick(prior.spotTick)).toBeLessThanOrEqual(spot)
    expect(getSqrtPriceAtTick(prior.spotTick + 1)).toBeGreaterThan(spot)
  })

  it('hits the canonical bounds at the edge ticks', () => {
    expect(getSqrtPriceAtTick(MIN_TICK)).toBe(MIN_SQRT_RATIO)
    expect(getSqrtPriceAtTick(MAX_TICK)).toBe(MAX_SQRT_RATIO)
  })

  it('is monotonic and mirror-reciprocal', () => {
    for (const tick of [-100_000, -1, 0, 1, 12_345, 393_799]) {
      expect(getSqrtPriceAtTick(tick + 1)).toBeGreaterThan(getSqrtPriceAtTick(tick))
    }
    const up = getSqrtPriceAtTick(50_000)
    const down = getSqrtPriceAtTick(-50_000)
    const q96 = 1n << 96n
    // Each conversion rounds up by at most a wei, so the pair multiplies back
    // to q96 within a few wei of drift over the whole ±50k range.
    const reciprocal = (up * down) / q96
    expect(reciprocal).toBeGreaterThanOrEqual(q96 - 4n)
    expect(reciprocal).toBeLessThanOrEqual(q96 + 4n)
  })

  it('refuses ticks outside the usable range', () => {
    expect(() => getSqrtPriceAtTick(MIN_TICK - 1)).toThrow()
    expect(() => getSqrtPriceAtTick(MAX_TICK + 1)).toThrow()
    expect(() => getSqrtPriceAtTick(1.5)).toThrow()
  })
})

/** The launchpad's immutable curve, read live via `curve()` (top = 200,000). */
const LIVE_CURVE = [
  { offsetLower: 0, offsetUpper: 19_400, bps: 3_519 },
  { offsetLower: 19_400, offsetUpper: 20_600, bps: 146 },
  { offsetLower: 20_600, offsetUpper: 21_800, bps: 160 },
  { offsetLower: 21_800, offsetUpper: 23_000, bps: 175 },
  { offsetLower: 23_000, offsetUpper: 40_000, bps: 1_888 },
  { offsetLower: 40_000, offsetUpper: 41_200, bps: 97 },
  { offsetLower: 41_200, offsetUpper: 42_400, bps: 108 },
  { offsetLower: 42_400, offsetUpper: 43_600, bps: 121 },
  { offsetLower: 43_600, offsetUpper: 44_800, bps: 135 },
  { offsetLower: 44_800, offsetUpper: 46_000, bps: 151 },
  { offsetLower: 46_000, offsetUpper: 66_600, bps: 1_853 },
  { offsetLower: 66_600, offsetUpper: 67_800, bps: 70 },
  { offsetLower: 67_800, offsetUpper: 69_000, bps: 77 },
  { offsetLower: 69_000, offsetUpper: 92_000, bps: 1_000 },
  { offsetLower: 92_000, offsetUpper: 200_000, bps: 500 }
] as const

describe('curve bounds', () => {
  it('curveTop is the last band edge and validateShape ordering makes it the top', () => {
    expect(
      curveTopOf([
        { offsetLower: 0, offsetUpper: 200, bps: 5_000 },
        { offsetLower: 200, offsetUpper: 600, bps: 5_000 }
      ])
    ).toBe(600)
    expect(curveTopOf(LIVE_CURVE)).toBe(200_000)
    expect(LIVE_CURVE.reduce((sum, s) => sum + s.bps, 0)).toBe(10_000)
  })

  it('mirrors the token-is-currency1 orientation, as _curveBounds does', () => {
    const startTick = -393_800
    const curveTop = curveTopOf(LIVE_CURVE)
    const spacing = POOL.TICK_SPACING
    const t1 = curveBoundsOf(true, startTick, curveTop, spacing)
    const t0 = curveBoundsOf(false, startTick, curveTop, spacing)
    expect(t1.lo).toBe(getSqrtPriceAtTick(startTick - spacing))
    expect(t1.hi).toBe(getSqrtPriceAtTick(startTick + curveTop))
    expect(t0.lo).toBe(getSqrtPriceAtTick(-(startTick + curveTop)))
    expect(t0.hi).toBe(getSqrtPriceAtTick(-startTick + spacing))
  })

  it('the live pool spot sits inside its own curve bounds', () => {
    const prior = standing.fills[0]!.atPriorBlock
    const spot = BigInt(prior.spotSqrtPriceX96)
    const { lo, hi } = curveBoundsOf(
      prior.tokenIs0,
      prior.startTick,
      curveTopOf(LIVE_CURVE),
      POOL.TICK_SPACING
    )
    expect(spot).toBeGreaterThanOrEqual(lo)
    expect(spot).toBeLessThanOrEqual(hi)
  })
})
