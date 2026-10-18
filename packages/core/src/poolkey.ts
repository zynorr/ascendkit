import { encodeAbiParameters, keccak256, type Address, type Hex } from 'viem'
import { POOL } from './constants.js'

export interface PoolKey {
  currency0: Address
  currency1: Address
  hooks: Address
  poolManager: Address
  fee: number
  parameters: Hex
}

const POOL_KEY_ABI = [
  { type: 'address' },
  { type: 'address' },
  { type: 'address' },
  { type: 'address' },
  { type: 'uint24' },
  { type: 'bytes32' }
] as const

/** True when the launched token sorts as currency0 (token < quote). */
export function tokenIsCurrency0(token: Address, quote: Address): boolean {
  return BigInt(token) < BigInt(quote)
}

export interface PoolKeyContext {
  /** The hook of every launchpad pool: the AscendLaunchpad itself. */
  hook: Address
  /** The PancakeSwap Infinity pool manager. */
  poolManager: Address
}

/** Derive the pool key of a launchpad pair. Pure; never stored on-chain. */
export function poolKeyOf(token: Address, quote: Address, ctx: PoolKeyContext): PoolKey {
  const tokenIs0 = tokenIsCurrency0(token, quote)
  return {
    currency0: tokenIs0 ? token : quote,
    currency1: tokenIs0 ? quote : token,
    hooks: ctx.hook,
    poolManager: ctx.poolManager,
    fee: POOL.DYNAMIC_FEE_FLAG,
    parameters: POOL.POOL_PARAMETERS
  }
}

/** PoolId = keccak256(abi.encode(PoolKey)) — 6 slots, nothing packed. */
export function poolIdOf(key: PoolKey): Hex {
  return keccak256(
    encodeAbiParameters(POOL_KEY_ABI, [
      key.currency0,
      key.currency1,
      key.hooks,
      key.poolManager,
      key.fee,
      key.parameters
    ])
  )
}
