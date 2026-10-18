import { getSqrtPriceAtTick } from './tick.js'

export interface CurveStep {
  offsetLower: number
  offsetUpper: number
  bps: number
}

/**
 * `_curveTop`: the top band's far edge in canonical ticks above `startTick`.
 * The contract takes it from `LaunchCurve.validateShape`, which requires the
 * bands sorted ascending — so it is the last step's `offsetUpper`.
 */
export function curveTopOf(curve: readonly CurveStep[]): number {
  const last = curve[curve.length - 1]
  if (last === undefined) throw new RangeError('empty curve')
  return last.offsetUpper
}

/**
 * `_curveBounds`: the pool-space bounds the EMA observes are clamped to —
 * from the initial price to the last band's far edge (SC-16), mirrored when
 * the token is currency1.
 */
export function curveBoundsOf(
  tokenIs0: boolean,
  startTick: number,
  curveTop: number,
  tickSpacing: number
): { lo: bigint; hi: bigint } {
  if (tokenIs0) {
    return {
      lo: getSqrtPriceAtTick(startTick - tickSpacing),
      hi: getSqrtPriceAtTick(startTick + curveTop)
    }
  }
  return {
    lo: getSqrtPriceAtTick(-(startTick + curveTop)),
    hi: getSqrtPriceAtTick(-startTick + tickSpacing)
  }
}
