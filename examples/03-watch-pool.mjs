// Live stream: poll a pool's events (collects, flywheel fills, bids,
// protocol fee allocations) as they land. Ctrl+C to stop.
//
//   node examples/03-watch-pool.mjs 0x20c97309F0e1849d2403F97d56D619845C7b2253 [--quote 0x…]
import { createPublicClient, http, isAddress } from 'viem'
import {
  ADDRESSES,
  elysiumTestnet,
  launchpadAbi,
  poolIdOf,
  poolKeyOf,
  RPC_URL
} from '@ascendkit/core'
import { poolHistory } from '@ascendkit/indexer'

const [token, ...rest] = process.argv.slice(2)
if (!token || !isAddress(token)) throw new Error('usage: node examples/03-watch-pool.mjs <token> [--quote <address>]')
const quoteFlag = rest.indexOf('--quote')
const quote = quoteFlag >= 0 ? rest[quoteFlag + 1] : null
if (quote !== null && !isAddress(quote)) throw new Error(`not an address: ${quote}`)

const client = createPublicClient({ chain: elysiumTestnet, transport: http(RPC_URL) })

// derive the poolId the same way the launchpad does
const quoteAddress =
  quote ??
  (await client.readContract({
    address: ADDRESSES.ascendLaunchpad,
    abi: launchpadAbi,
    functionName: 'baseQuote'
  }))
const poolId = poolIdOf(
  poolKeyOf(token, quoteAddress, {
    hook: ADDRESSES.ascendLaunchpad,
    poolManager: ADDRESSES.infinityPoolManager
  })
)

console.log(`watching pool ${poolId} (${token})`)
let lastBlock = await client.getBlockNumber()
for (;;) {
  await new Promise((r) => setTimeout(r, 10_000))
  try {
    const events = await poolHistory(client, poolId, { fromBlock: lastBlock + 1n })
    for (const event of events) {
      console.log(new Date().toISOString(), JSON.stringify(event, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)))
    }
    lastBlock = await client.getBlockNumber()
  } catch (err) {
    console.error('poll failed:', err.message)
  }
}
