import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { Address, Hex } from 'viem'
import { PROTOCOL_BPS } from '@ascendkit/core'
import { splitCreatorFee, splitProtocolFee } from '@ascendkit/sim'
import {
  decodeLaunchpadLog,
  type CollectedEvent,
  type LaunchpadEvent,
  type RawLogLike
} from './index.js'

const load = (name: string): RawLogLike[] =>
  JSON.parse(readFileSync(new URL(`../../../fixtures/raw/${name}.json`, import.meta.url), 'utf8'))

const pools = JSON.parse(
  readFileSync(new URL('../../../fixtures/pools.json', import.meta.url), 'utf8')
) as {
  meta: { launchpad: Address }
  pools: { token: Address; creator: Address; quote: Address; poolId: Hex }[]
}

type EventOf<T extends LaunchpadEvent['type']> = Extract<LaunchpadEvent, { type: T }>

function decodeAll<T extends LaunchpadEvent['type']>(name: string, type: T): EventOf<T>[] {
  return load(name)
    .map((log) => decodeLaunchpadLog(log))
    .filter((e): e is EventOf<T> => e?.type === type)
}

// poolId derivation cross-check lives in @ascendkit/core tests; here we only assert
// the decoded values against the recorded fixtures.

describe('launchpad log decoding', () => {
  it('decodes every fixture log with the expected event type', () => {
    const cases: [string, number, string][] = [
      ['launched', 8, 'Launched'],
      ['collected', 13, 'Collected'],
      ['filled', 2, 'Filled'],
      ['bidfunded', 2, 'BidFunded'],
      ['protocolfees', 19, 'ProtocolFeesAllocated'],
      ['tokensaccumulated', 10, 'TokensAccumulated'],
      ['creatorclaimed', 6, 'CreatorClaimed'],
      ['creatortransferstarted', 4, 'CreatorTransferStarted'],
      ['creatortransferred', 4, 'CreatorTransferred'],
      ['quoteconfigset', 2, 'QuoteConfigSet'],
      ['pausedset', 1, 'PausedSet']
    ]
    for (const [file, count, event] of cases) {
      const logs = load(file)
      expect(logs.length, file).toBe(count)
      for (const log of logs) {
        const decoded = decodeLaunchpadLog(log)
        // events outside the typed union decode to null
        if (decoded === null) {
          expect([
            'CreatorTransferStarted',
            'CreatorTransferred',
            'QuoteConfigSet',
            'PausedSet'
          ]).toContain(event)
          continue
        }
        expect(decoded.type, file).toBe(event)
        expect(decoded.txHash, file).toBe(log.transactionHash)
      }
    }
  })

  it('launched events carry the launch metadata seen on chain', () => {
    const launched = decodeAll('launched', 'Launched')
    const byToken = new Map(pools.pools.map((p) => [p.token.toLowerCase(), p]))
    for (const event of launched) {
      const fixture = byToken.get(event.token.toLowerCase())
      expect(fixture, event.token).toBeDefined()
      expect(event.creator.toLowerCase()).toBe(fixture!.creator.toLowerCase())
      expect(event.quote.toLowerCase()).toBe(fixture!.quote.toLowerCase())
      expect(event.poolId).toBe(fixture!.poolId)
      expect(event.supplySeeded).toBeGreaterThan(0n)
    }
  })

  it('collected events decode fee amounts and burns', () => {
    const collected = decodeAll('collected', 'Collected')
    for (const event of collected) {
      expect(event.tokenFees).toBeGreaterThanOrEqual(0n)
      expect(event.quoteFees).toBeGreaterThanOrEqual(0n)
      expect(event.tokensBurned <= event.tokenFees).toBe(true)
      expect(event.flywheelQuote).toBeGreaterThanOrEqual(0n)
    }
  })

  it('filled events decode flywheel fills', () => {
    const filled = decodeAll('filled', 'Filled')
    expect(filled.length).toBe(2)
    for (const event of filled) {
      expect(event.tokensIn).toBeGreaterThan(0n)
      expect(event.quotePaid).toBeGreaterThan(0n)
      expect(event.feeTokens <= event.tokensIn).toBe(true)
      expect(event.tokensBurned <= event.tokensIn).toBe(true)
    }
  })

  it('bid funded events decode funder and amount', () => {
    const bids = decodeAll('bidfunded', 'BidFunded')
    expect(bids.length).toBe(2)
    for (const event of bids) {
      expect(event.amount).toBeGreaterThan(0n)
      expect(event.funder).toMatch(/^0x[0-9a-fA-F]{40}$/)
    }
  })

  it('creator claims decode both asset legs', () => {
    const claims = decodeAll('creatorclaimed', 'CreatorClaimed')
    expect(claims.length).toBe(6)
    for (const event of claims) {
      expect(event.tokenAmount + event.quoteAmount > 0n).toBe(true)
    }
  })

  it('tokens accumulated decode the source enum', () => {
    const accumulated = decodeAll('tokensaccumulated', 'TokensAccumulated')
    expect(accumulated.length).toBe(10)
    for (const event of accumulated) {
      expect(event.source).toBeGreaterThanOrEqual(0)
      expect(event.amount).toBeGreaterThan(0n)
    }
  })
})

describe('fee split math matches live allocation events', () => {
  it('every ProtocolFeesAllocated is a bps floor split with opex dust', () => {
    const allocations = decodeAll('protocolfees', 'ProtocolFeesAllocated')
    expect(allocations.length).toBe(19)
    for (const event of allocations) {
      const total = event.stakerYield + event.treasury + event.ecosystem + event.opex + event.kntq
      const bps = (n: number) => (total * BigInt(n)) / 10_000n
      expect(event.stakerYield, 'stakerYield').toBe(bps(PROTOCOL_BPS.STAKER_YIELD))
      expect(event.treasury, 'treasury').toBe(bps(PROTOCOL_BPS.TREASURY))
      expect(event.ecosystem, 'ecosystem').toBe(bps(PROTOCOL_BPS.ECOSYSTEM))
      expect(event.kntq, 'kntq').toBe(bps(PROTOCOL_BPS.KNTQ))
      expect(event.opex, 'opex').toBe(
        total - (event.stakerYield + event.treasury + event.ecosystem + event.kntq)
      )
      expect(splitProtocolFee(total)).toEqual({
        stakerYield: event.stakerYield,
        treasury: event.treasury,
        ecosystem: event.ecosystem,
        opex: event.opex,
        kntq: event.kntq
      })
    }
  })

  it('allocations emitted by collect() split the collected fee ceil-half', () => {
    const allocations = decodeAll('protocolfees', 'ProtocolFeesAllocated')
    const collected = decodeAll('collected', 'Collected')
    const byTx = new Map<string, CollectedEvent[]>()
    for (const event of collected) {
      const list = byTx.get(event.txHash) ?? []
      list.push(event)
      byTx.set(event.txHash, list)
    }
    let checked = 0
    for (const event of allocations) {
      const candidates = byTx.get(event.txHash)
      if (!candidates) continue
      const total = event.stakerYield + event.treasury + event.ecosystem + event.opex + event.kntq
      const matched = candidates.some(
        (c) =>
          splitCreatorFee(c.tokenFees).protocol === total ||
          splitCreatorFee(c.quoteFees).protocol === total
      )
      expect(matched, `no collected fee for allocation in ${event.txHash}`).toBe(true)
      checked++
    }
    expect(checked).toBe(17)
  })
})
