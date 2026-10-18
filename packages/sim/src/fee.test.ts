import { describe, expect, it } from 'vitest'
import {
  feePipsForElapsed,
  feePipsNow,
  feeSchedule,
  splitCreatorFee,
  splitProtocolFee
} from './fee.js'

describe('fee schedule', () => {
  it('decays 90% -> 1% over 5 seconds, then stays at 1%', () => {
    const expected = [900_000, 722_000, 544_000, 366_000, 188_000, 10_000, 10_000, 10_000]
    expected.forEach((pips, elapsed) => {
      expect(feePipsForElapsed(elapsed)).toBe(pips)
    })
  })

  it('clamps negative elapsed to launch (90%)', () => {
    expect(feePipsForElapsed(-3)).toBe(900_000)
  })

  it('accepts bigint input', () => {
    expect(feePipsForElapsed(5n)).toBe(10_000)
    expect(feePipsForElapsed(2n ** 40n)).toBe(10_000)
  })

  it('computes the current fee from launch time', () => {
    expect(feePipsNow(1_000n, 1_000n)).toBe(900_000)
    expect(feePipsNow(1_000n, 1_001n)).toBe(722_000)
    expect(feePipsNow(1_000n, 1_010n)).toBe(10_000)
  })

  it('schedule rows match per-second fees', () => {
    const rows = feeSchedule(6)
    expect(rows).toHaveLength(7)
    expect(rows.map((r) => r.pips)).toEqual([
      900_000, 722_000, 544_000, 366_000, 188_000, 10_000, 10_000
    ])
    expect(rows[0]!.percent).toBe(90)
    expect(rows[5]!.percent).toBe(1)
  })
})

describe('fee splits (verified against live ProtocolFeesAllocated events)', () => {
  it('creator gets the floor half, protocol the rest', () => {
    expect(splitCreatorFee(29_999_999n)).toEqual({ creator: 14_999_999n, protocol: 15_000_000n })
    expect(splitCreatorFee(99n)).toEqual({ creator: 49n, protocol: 50n })
  })

  it('protocol half splits into bps floors with opex taking the dust', () => {
    expect(splitProtocolFee(15_000_000n)).toEqual({
      stakerYield: 750_000n,
      treasury: 3_000_000n,
      ecosystem: 2_250_000n,
      opex: 1_500_000n,
      kntq: 7_500_000n
    })
  })

  it('reproduces three live allocations to the wei', () => {
    const cases = [
      {
        fees: 29_999_999n,
        split: {
          stakerYield: 750_000n,
          treasury: 3_000_000n,
          ecosystem: 2_250_000n,
          opex: 1_500_000n,
          kntq: 7_500_000n
        }
      },
      {
        fees: 1_330_635_218_269_447_051_348_103n,
        split: {
          stakerYield: 33_265_880_456_736_176_283_702n,
          treasury: 133_063_521_826_944_705_134_810n,
          ecosystem: 99_797_641_370_208_528_851_107n,
          opex: 66_531_760_913_472_352_567_407n,
          kntq: 332_658_804_567_361_762_837_026n
        }
      },
      {
        fees: 334_322_098_590_198_571_651_210n,
        split: {
          stakerYield: 8_358_052_464_754_964_291_280n,
          treasury: 33_432_209_859_019_857_165_121n,
          ecosystem: 25_074_157_394_264_892_873_840n,
          opex: 16_716_104_929_509_928_582_562n,
          kntq: 83_580_524_647_549_642_912_802n
        }
      }
    ]
    for (const { fees, split } of cases) {
      const { protocol } = splitCreatorFee(fees)
      expect(splitProtocolFee(protocol)).toEqual(split)
    }
  })
})
