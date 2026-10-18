import { Command } from 'commander'
import { createPublicClient, http, formatEther } from 'viem'
import { elysiumTestnet, RPC_URL } from '@ascendkit/core'
import { listPools } from '@ascendkit/indexer'

function short(addr: string): string {
  return `${addr.slice(0, 10)}…${addr.slice(-6)}`
}

function age(seconds: number): string {
  if (seconds <= 0) return '—'
  const days = Math.floor(seconds / 86_400)
  const hours = Math.floor((seconds % 86_400) / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

export function registerPools(program: Command): void {
  program
    .command('pools')
    .description('List every launchpad pool, oldest first')
    .option('--rpc <url>', 'RPC URL', RPC_URL)
    .option('--json', 'print the full JSON instead of a table')
    .action(async (opts: { rpc: string; json?: boolean }) => {
      const client = createPublicClient({
        chain: elysiumTestnet,
        transport: http(opts.rpc)
      })
      const pools = await listPools(client)
      if (opts.json) {
        console.log(
          JSON.stringify(
            pools.map((p) => ({
              ...p,
              supplySeeded: p.supplySeeded.toString(),
              devBuyTokens: p.devBuyTokens.toString()
            })),
            null,
            2
          )
        )
        return
      }
      const now = Math.floor(Date.now() / 1000)
      console.log(`${pools.length} pools, oldest first`)
      for (const [i, pool] of pools.entries()) {
        console.log(
          `${String(i + 1).padStart(2)}  ${pool.token}  creator ${short(pool.creator)}  quote ${short(
            pool.quote
          )}  ${age(now - pool.launchedAt)} ago  seed ${formatEther(pool.supplySeeded)}  devBuy ${formatEther(
            pool.devBuyTokens
          )}`
        )
        console.log(`    poolId ${pool.poolId}`)
      }
    })
}
