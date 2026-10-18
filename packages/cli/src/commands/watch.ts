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
import { poolHistory } from '@ascendkit/indexer'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function format(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? v.toString() : v))
}

export function registerWatch(program: Command): void {
  program
    .command('watch')
    .description('Stream a pool\'s activity (collects, fills, bids, allocations) as it lands')
    .argument('<token>', 'launched token address')
    .option('--quote <address>', 'quote token (default: the launchpad base quote)')
    .option('--interval <seconds>', 'poll interval in seconds', '10')
    .option('--rpc <url>', 'RPC URL', RPC_URL)
    .action(async (token: string, opts: { quote?: string; interval: string; rpc: string }) => {
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

      const key = poolKeyOf(token as Address, quote as Address, {
        hook: launchpad,
        poolManager: ADDRESSES.infinityPoolManager
      })
      const poolId = poolIdOf(key)

      console.log(`watching ${token}`)
      console.log(`poolId   ${poolId}`)
      let lastBlock = await client.getBlockNumber()
      console.log(`from block ${lastBlock}; polling every ${opts.interval}s (Ctrl+C to stop)`)

      const intervalMs = Math.max(1, Number(opts.interval)) * 1_000
      for (;;) {
        await sleep(intervalMs)
        try {
          const events = await poolHistory(client, poolId, { fromBlock: lastBlock + 1n })
          const head = await client.getBlockNumber()
          for (const event of events) {
            const moment = new Date().toISOString()
            console.log(`${moment}  ${format(event)}`)
          }
          lastBlock = head
        } catch (err) {
          console.error(`poll failed: ${err instanceof Error ? err.message : err}`)
        }
      }
    })
}
