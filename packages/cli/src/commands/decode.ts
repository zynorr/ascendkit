import { Command } from 'commander'
import {
  createPublicClient,
  decodeFunctionData,
  http,
  type Address,
  type Hex
} from 'viem'
import {
  ADDRESSES,
  elysiumTestnet,
  launchpadAbi,
  poolIdOf,
  poolKeyOf,
  predictTokenAddress,
  RPC_URL,
  tokenIsCurrency0
} from '@ascendkit/core'
import { decodeLaunchpadLog } from '@ascendkit/indexer'

interface LaunchParams {
  name: string
  symbol: string
  quote: Address
  devBuyQuote: bigint
  minDevOut: bigint
  salt: Hex
  creator: Address
}

function stringify(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, v) => (typeof v === 'bigint' ? v.toString() : v),
    2
  )
}

export function registerDecode(program: Command): void {
  program
    .command('decode')
    .description('Decode a transaction hash (or raw calldata) against the launchpad')
    .argument('<input>', 'transaction hash or 0x-prefixed calldata')
    .option('--rpc <url>', 'RPC URL', RPC_URL)
    .option('--json', 'print the full JSON')
    .action(async (input: string, opts: { rpc: string; json?: boolean }) => {
      const client = createPublicClient({
        chain: elysiumTestnet,
        transport: http(opts.rpc)
      })

      const isCalldata = input.startsWith('0x') && input.length > 66
      let data: Hex
      let sender: Address | null = null
      if (isCalldata) {
        data = input as Hex
      } else {
        const tx = await client.getTransaction({ hash: input as Hex })
        data = tx.input
        sender = tx.from
      }

      let decoded: ReturnType<typeof decodeFunctionData>
      try {
        decoded = decodeFunctionData({ abi: launchpadAbi, data })
      } catch {
        console.error('not a launchpad call (ABI mismatch or unknown selector)')
        process.exitCode = 1
        return
      }

      const out: Record<string, unknown> = { function: decoded.functionName }

      if (decoded.functionName === 'launch') {
        const params = decoded.args[0] as unknown as LaunchParams
        out.params = params
        if (sender !== null) {
          const token = predictTokenAddress({
            launchpad: ADDRESSES.ascendLaunchpad,
            sender,
            salt: params.salt,
            name: params.name,
            symbol: params.symbol
          })
          const key = poolKeyOf(token, params.quote, {
            hook: ADDRESSES.ascendLaunchpad,
            poolManager: ADDRESSES.infinityPoolManager
          })
          out.predicted = {
            token,
            poolId: poolIdOf(key),
            tokenIsCurrency0: tokenIsCurrency0(token, params.quote)
          }
        }
      } else {
        out.args = decoded.args
      }

      if (!isCalldata) {
        const receipt = await client.getTransactionReceipt({ hash: input as Hex })
        const events = receipt.logs
          .filter((log) => log.address.toLowerCase() === ADDRESSES.ascendLaunchpad.toLowerCase())
          .map((log) =>
            decodeLaunchpadLog({
              topics: log.topics,
              data: log.data,
              blockNumber: log.blockNumber,
              transactionHash: log.transactionHash,
              logIndex: log.logIndex
            })
          )
          .filter((event) => event !== null)
        out.events = events
      }

      if (opts.json) {
        console.log(stringify(out))
      } else {
        console.log(`function  ${out.function}`)
        if (out.params) {
          console.log(stringify(out.params))
        }
        if (out.predicted) {
          const predicted = out.predicted as { token: Address; poolId: Hex; tokenIsCurrency0: boolean }
          console.log(`predicted token   ${predicted.token}`)
          console.log(`predicted poolId  ${predicted.poolId}`)
          console.log(`tokenIsCurrency0  ${predicted.tokenIsCurrency0}`)
        }
        if (out.events) {
          const events = out.events as { type: string }[]
          console.log(`events  ${events.length === 0 ? '(none)' : ''}`)
          for (const event of events) {
            console.log(stringify(event))
          }
        }
      }
    })
}
