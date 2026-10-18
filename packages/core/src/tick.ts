// Exact port of the launchpad's tick math (`TickMath.getSqrtRatioAtTick`,
// vendored from v4 math in tools/abi-extract/vendor). Same rounding, same
// bounds; verified against a live slot0 tick in tick.test.ts.

export const MIN_TICK = -887272
export const MAX_TICK = 887272
export const MIN_SQRT_RATIO = 4295128739n
export const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n

const RATIO_AT_ABS_0 = 0xfffcb933bd6fad37aa2d162d1a594001n

/** Copyright (C) 2024 PancakeSwap — bit table of sqrt(1.0001^(2^i)) in Q128. */
const RATIO_AT_BIT: readonly [number, bigint][] = [
  [0x2, 0xfff97272373d413259a46990580e213an],
  [0x4, 0xfff2e50f5f656932ef12357cf3c7fdccn],
  [0x8, 0xffe5caca7e10e4e61c3624eaa0941cd0n],
  [0x10, 0xffcb9843d60f6159c9db58835c926644n],
  [0x20, 0xff973b41fa98c081472e6896dfb254c0n],
  [0x40, 0xff2ea16466c96a3843ec78b326b52861n],
  [0x80, 0xfe5dee046a99a2a811c461f1969c3053n],
  [0x100, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
  [0x200, 0xf987a7253ac413176f2b074cf7815e54n],
  [0x400, 0xf3392b0822b70005940c7a398e4b70f3n],
  [0x800, 0xe7159475a2c29b7443b29c7fa6e889d9n],
  [0x1000, 0xd097f3bdfd2022b8845ad8f792aa5825n],
  [0x2000, 0xa9f746462d870fdf8a65dc1f90e061e5n],
  [0x4000, 0x70d869a156d2a1b890bb3df62baf32f7n],
  [0x8000, 0x31be135f97d08fd981231505542fcfa6n],
  [0x10000, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
  [0x20000, 0x5d6af8dedb81196699c329225ee604n],
  [0x40000, 0x2216e584f5fa1ea926041bedfe98n],
  [0x80000, 0x48a170391f7dc42444e8fa2n]
]

/** sqrt(1.0001^tick) * 2^96, Q64.96 — floors in the same places the chain does. */
export function getSqrtPriceAtTick(tick: number): bigint {
  if (!Number.isInteger(tick)) throw new RangeError(`tick not an integer: ${tick}`)
  if (tick < MIN_TICK || tick > MAX_TICK) throw new RangeError(`tick out of bounds: ${tick}`)
  const absTick = BigInt(Math.abs(tick))

  let ratio = (absTick & 1n) !== 0n ? RATIO_AT_ABS_0 : 1n << 128n
  for (const [bit, factor] of RATIO_AT_BIT) {
    if ((absTick & BigInt(bit)) !== 0n) ratio = (ratio * factor) >> 128n
  }
  if (tick > 0) ratio = ((1n << 256n) - 1n) / ratio
  return (ratio + 0xffffffffn) >> 32n
}
