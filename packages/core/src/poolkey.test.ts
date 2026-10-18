import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { Address, Hex } from 'viem'
import { ADDRESSES } from './chain.js'
import { POOL } from './constants.js'
import { poolIdOf, poolKeyOf, tokenIsCurrency0 } from './poolkey.js'

interface FixturePool {
  poolId: Hex
  token: Address
  creator: Address
  quote: Address
  supplySeeded: string
  devBuyTokens: string
  blockNumber: number
  txHash: Hex
}

const fixture = JSON.parse(
  readFileSync(new URL('../../../fixtures/pools.json', import.meta.url), 'utf8')
) as { meta: { launchpad: Address; poolManager: Address }; pools: FixturePool[] }

const ctx = {
  hook: fixture.meta.launchpad as Address,
  poolManager: fixture.meta.poolManager as Address
}

describe('pool key derivation', () => {
  it('fixtures use the documented launchpad and pool manager', () => {
    expect(fixture.meta.launchpad.toLowerCase()).toBe(
      ADDRESSES.ascendLaunchpad.toLowerCase()
    )
    expect(ctx.poolManager.toLowerCase()).toBe(
      ADDRESSES.infinityPoolManager.toLowerCase()
    )
  })

  it('reproduces every live poolId from its (token, quote) pair', () => {
    expect(fixture.pools.length).toBeGreaterThanOrEqual(8)
    for (const pool of fixture.pools) {
      const key = poolKeyOf(pool.token, pool.quote, ctx)
      expect(poolIdOf(key)).toBe(pool.poolId)
    }
  })

  it('sorts currencies by address and covers both orientations', () => {
    let tokenIs0 = 0
    let tokenIs1 = 0
    for (const pool of fixture.pools) {
      const key = poolKeyOf(pool.token, pool.quote, ctx)
      const expectToken0 = tokenIsCurrency0(pool.token, pool.quote)
      expect(key.currency0).toBe(expectToken0 ? pool.token : pool.quote)
      expect(key.currency1).toBe(expectToken0 ? pool.quote : pool.token)
      expect(key.fee).toBe(POOL.DYNAMIC_FEE_FLAG)
      expect(key.parameters).toBe(POOL.POOL_PARAMETERS)
      if (expectToken0) tokenIs0++
      else tokenIs1++
    }
    expect(tokenIs0).toBeGreaterThan(0)
    expect(tokenIs1).toBeGreaterThan(0)
  })

  it('uses both quote assets seen live', () => {
    const quotes = new Set(fixture.pools.map((p) => p.quote))
    expect(quotes.size).toBeGreaterThanOrEqual(2)
  })
})
