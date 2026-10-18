import { Command } from 'commander'
import { createPublicClient, http, isAddress, type Address } from 'viem'
import {
  ADDRESSES,
  elysiumTestnet,
  launchpadAbi,
  poolIdOf,
  poolKeyOf,
  RPC_URL
} from '@ascendkit/core'
import { snapshotPool } from '@ascendkit/indexer'
import { feePipsNow } from '@ascendkit/sim'

export function registerPool(program: Command): void {
  program
    .command('pool')
    .description('Inspect a launchpad pool by token address')
    .argument('<token>', 'launched token address')
    .option('--quote <address>', 'quote token (default: the launchpad base quote)')
    .option('--rpc <url>', 'RPC URL', RPC_URL)
    .action(async (token: string, opts: { quote?: string; rpc: string }) => {
      if (!isAddress(token)) throw new Error(`not an address: ${token}`)
      if (opts.quote !== undefined && !isAddress(opts.quote)) {
        throw new Error(`not an address: ${opts.quote}`)
      }

      const client = createPublicClient({
        chain: elysiumTestnet,
        transport: http(opts.rpc)
      })
      const launchpad = ADDRESSES.ascendLaunchpad

      const quote =
        opts.quote ??
        ((await client.readContract({
          address: launchpad,
          abi: launchpadAbi,
          functionName: 'baseQuote'
        })) as Address)

      const key = poolKeyOf(token as Address, quote, {
        hook: launchpad,
        poolManager: ADDRESSES.infinityPoolManager
      })
      const poolId = poolIdOf(key)

      console.log(`token        ${token}`)
      console.log(`quote        ${quote}`)
      console.log(
        `currency0    ${key.currency0} (${key.currency0.toLowerCase() === token.toLowerCase() ? 'token' : 'quote'})`
      )
      console.log(`poolId       ${poolId}`)

      const snapshot = await snapshotPool(client, poolId)
      if (!snapshot.exists) {
        console.log('')
        console.log('unknown pool: this launchpad never launched that pair (UnknownPool sentinel)')
        return
      }

      const now = Math.floor(Date.now() / 1000)
      const scheduled = feePipsNow(snapshot.launchedAt, now)
      console.log(
        `launchedAt   ${snapshot.launchedAt} (${new Date(snapshot.launchedAt * 1000).toISOString()})`
      )
      console.log(`creator      ${snapshot.creator}`)
      console.log(`tokenIs0     ${snapshot.tokenIs0}`)
      console.log(`startTick    ${snapshot.startTick}`)
      console.log(
        `fee now      ${snapshot.currentFee} pips (${snapshot.currentFee / 10_000}%) [scheduled: ${scheduled}]`
      )
      console.log(`maxClip      ${snapshot.maxClip} quote wei / window`)
      console.log(`bidInventory ${snapshot.bidInventory} quote wei`)
      console.log(`emaSqrtPrice ${snapshot.emaSqrtPrice}`)
      console.log(
        `emaUpdatedAt ${snapshot.emaUpdatedAt}${snapshot.emaUpdatedAt === 0 ? '' : ` (${new Date(snapshot.emaUpdatedAt * 1000).toISOString()})`}`
      )
    })
}
