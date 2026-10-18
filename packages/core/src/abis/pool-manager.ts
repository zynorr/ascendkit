// Hand-maintained slice of the deployed PancakeSwap Infinity CLPoolManager
// interface (vendor/lib/infinity-core/src/pool-cl/interfaces/ICLPoolManager.sol).
// Only the reads this SDK needs, typed as const so viem infers exact returns.

export const poolManagerAbi = [
  {
    type: 'function',
    name: 'getSlot0',
    stateMutability: 'view',
    inputs: [{ name: 'id', type: 'bytes32' }],
    outputs: [
      { name: 'sqrtPriceX96', type: 'uint160' },
      { name: 'tick', type: 'int24' },
      { name: 'protocolFee', type: 'uint24' },
      { name: 'lpFee', type: 'uint24' }
    ]
  },
  {
    type: 'function',
    name: 'getLiquidity',
    stateMutability: 'view',
    inputs: [{ name: 'id', type: 'bytes32' }],
    outputs: [{ name: 'liquidity', type: 'uint128' }]
  }
] as const
