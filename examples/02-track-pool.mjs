// Live: list every launchpad pool and show its current fee state.
//
//   node examples/02-track-pool.mjs
import { createPublicClient, formatEther, http } from 'viem'
import { elysiumTestnet, RPC_URL } from '@ascendkit/core'
import { listPools, snapshotPool } from '@ascendkit/indexer'
import { feePipsNow } from '@ascendkit/sim'

const client = createPublicClient({ chain: elysiumTestnet, transport: http(RPC_URL) })

const pools = await listPools(client)
console.log(`${pools.length} pools on Elysium testnet\n`)

const now = Math.floor(Date.now() / 1000)
for (const pool of pools) {
  const snapshot = await snapshotPool(client, pool.poolId)
  console.log(`${pool.token}  quote ${pool.quote}`)
  console.log(
    `  launched ${new Date(snapshot.launchedAt * 1000).toISOString()}  fee ${
      snapshot.currentFee
    } pips (scheduled ${feePipsNow(snapshot.launchedAt, now)})`
  )
  console.log(
    `  bid inventory ${formatEther(snapshot.bidInventory)}  burned-ish devBuy ${formatEther(
      pool.devBuyTokens
    )}`
  )
}
