// Offline: predict the token address and poolId of a launch from its raw
// transaction input alone. No RPC calls — pure CREATE2 + pool-key math.
//
//   node examples/01-predict-pool.mjs
import { readFileSync } from 'node:fs'
import { decodeFunctionData } from 'viem'
import {
  ADDRESSES,
  launchpadAbi,
  poolIdOf,
  poolKeyOf,
  predictTokenAddress,
  tokenIsCurrency0
} from '@ascendkit/core'

const launchTx = JSON.parse(
  readFileSync(new URL('../fixtures/raw/launchtx.json', import.meta.url), 'utf8')
)

const decoded = decodeFunctionData({ abi: launchpadAbi, data: launchTx.input })
if (decoded.functionName !== 'launch') throw new Error('fixture is not a launch()')
const params = decoded.args[0]

const token = predictTokenAddress({
  launchpad: launchTx.to,
  sender: launchTx.from,
  salt: params.salt,
  name: params.name,
  symbol: params.symbol
})

const key = poolKeyOf(token, params.quote, {
  hook: ADDRESSES.ascendLaunchpad,
  poolManager: ADDRESSES.infinityPoolManager
})
const poolId = poolIdOf(key)

console.log(`launch tx        ${launchTx.hash}`)
console.log(`predicted token  ${token}`)
console.log(`predicted poolId ${poolId}`)
console.log(`tokenIsCurrency0 ${tokenIsCurrency0(token, params.quote)}`)

const ok =
  token.toLowerCase() === launchTx.expected.token.toLowerCase() &&
  poolId.toLowerCase() === launchTx.expected.poolId.toLowerCase()
console.log(ok ? '\nmatches the live launch exactly' : '\nMISMATCH — fixture or code drifted')
process.exitCode = ok ? 0 : 1
