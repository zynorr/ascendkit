// Fetch the launchpad + pool-manager state around each real `Filled` event and
// write fixtures/raw/fill-standing.json — the fill simulator's replay input.
//
//   node tools/fixtures/fetch-fill-standing.mjs
//
// For every fill it reads, one block BEFORE the fill (so the values are the
// pre-swap state the hook saw): the nine launchpad getters, the CL slot0 spot
// price, and the vault's token balance (gate 10 of _fill). One block AFTER it
// reads the post-fill EMA and bid inventory (the stored values the hook used /
// produced), which is what makes the wei-exact replay possible.
import { readFileSync, writeFileSync } from 'node:fs'
import { createPublicClient, http } from 'viem'

const ROOT = new URL('../../', import.meta.url)
const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`fixtures/raw/${name}`, ROOT), 'utf8'))
const poolsFile = JSON.parse(readFileSync(new URL('fixtures/pools.json', ROOT), 'utf8'))

const meta = poolsFile.meta
const launchpad = meta.launchpad
const poolManager = meta.poolManager

const launchpadReads = [
  ['poolLaunchedAt', 'uint40'],
  ['poolCreator', 'address'],
  ['poolTokenIs0', 'bool'],
  ['poolStartTick', 'int24'],
  ['currentFee', 'uint24'],
  ['poolMaxClip', 'uint128'],
  ['bidInventory', 'uint256'],
  ['emaSqrtPrice', 'uint160'],
  ['emaUpdatedAt', 'uint40']
].map(([name, type]) => ({
  type: 'function',
  name,
  stateMutability: 'view',
  inputs: [{ name: 'poolId', type: 'bytes32' }],
  outputs: [{ name: '', type }]
}))

const vaultAbi = [
  {
    type: 'function',
    name: 'vault',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }]
  }
]

const slot0Abi = [
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
  }
]

const erc20Abi = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }]
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }]
  }
]

const words = (data) => {
  const hex = data.slice(2)
  return Array.from({ length: hex.length / 64 }, (_, i) =>
    BigInt(`0x${hex.slice(i * 64, (i + 1) * 64)}`)
  )
}

const multicallAddress = '0xcA11bde05977b3631167028862bE2a173976CA11'
const client = createPublicClient({ transport: http(meta.rpc) })
const latest = await client.getBlockNumber()
const vault = await client.readContract({
  address: launchpad,
  abi: vaultAbi,
  functionName: 'vault'
})

const tokenByPoolId = new Map(
  poolsFile.pools.map((p) => [p.poolId.toLowerCase(), p.token])
)
const quoteByPoolId = new Map(
  poolsFile.pools.map((p) => [p.poolId.toLowerCase(), p.quote])
)
const quoteDecimals = new Map()

const fills = []
for (const log of fixture('filled.json')) {
  const poolId = log.topics[1]
  const token = tokenByPoolId.get(poolId.toLowerCase())
  const quote = quoteByPoolId.get(poolId.toLowerCase())
  if (!token || !quote) throw new Error(`no pool for ${poolId} in pools.json`)
  if (!quoteDecimals.has(quote)) {
    quoteDecimals.set(
      quote,
      Number(
        await client.readContract({
          address: quote,
          abi: erc20Abi,
          functionName: 'decimals'
        })
      )
    )
  }

  const block = BigInt(log.blockNumber)
  const prior = block - 1n
  const [tokensIn, feeTokens, tokensBurned, quotePaid] = words(log.data)

  const priorReads = await client.multicall({
    allowFailure: false,
    blockNumber: prior,
    multicallAddress,
    contracts: launchpadReads.map((abi) => ({
      address: launchpad,
      abi: launchpadReads,
      functionName: abi.name,
      args: [poolId]
    }))
  })
  const [
    launchedAt,
    creator,
    tokenIs0,
    startTick,
    currentFee,
    maxClip,
    bidInventory,
    emaSqrtPrice,
    emaUpdatedAt
  ] = priorReads

  const [spotSqrtPriceX96, spotTick] = await client.readContract({
    address: poolManager,
    abi: slot0Abi,
    functionName: 'getSlot0',
    args: [poolId],
    blockNumber: prior
  })
  const vaultTokenBalance = await client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [vault],
    blockNumber: prior
  })

  const [emaAtFill, inventoryAtFill, emaUpdatedAtFill] = await client.multicall({
    allowFailure: false,
    blockNumber: block,
    multicallAddress,
    contracts: [
      { address: launchpad, abi: launchpadReads, functionName: 'emaSqrtPrice', args: [poolId] },
      { address: launchpad, abi: launchpadReads, functionName: 'bidInventory', args: [poolId] },
      { address: launchpad, abi: launchpadReads, functionName: 'emaUpdatedAt', args: [poolId] }
    ]
  })

  fills.push({
    poolId,
    token,
    quote,
    quoteDecimals: quoteDecimals.get(quote),
    txHash: log.transactionHash,
    logIndex: Number(log.logIndex),
    blockNumber: Number(block),
    blockTimestamp: Number(log.blockTimestamp),
    filled: {
      tokensIn: tokensIn.toString(),
      feeTokens: feeTokens.toString(),
      tokensBurned: tokensBurned.toString(),
      quotePaid: quotePaid.toString()
    },
    atPriorBlock: {
      blockNumber: Number(prior),
      launchedAt: Number(launchedAt),
      creator,
      tokenIs0,
      startTick: Number(startTick),
      currentFee: Number(currentFee),
      maxClip: maxClip.toString(),
      bidInventory: bidInventory.toString(),
      emaSqrtPrice: emaSqrtPrice.toString(),
      emaUpdatedAt: Number(emaUpdatedAt),
      spotSqrtPriceX96: spotSqrtPriceX96.toString(),
      spotTick: Number(spotTick),
      vaultTokenBalance: vaultTokenBalance.toString()
    },
    atFillBlock: {
      emaSqrtPrice: emaAtFill.toString(),
      bidInventory: inventoryAtFill.toString(),
      emaUpdatedAt: Number(emaUpdatedAtFill)
    }
  })
}

const out = {
  meta: {
    chainId: meta.chainId,
    rpc: meta.rpc,
    launchpad,
    poolManager,
    vault,
    fetchedAtBlock: Number(latest)
  },
  fills
}

writeFileSync(
  new URL('fixtures/raw/fill-standing.json', ROOT),
  `${JSON.stringify(out, null, 2)}\n`
)
console.log(`wrote fixtures/raw/fill-standing.json (${fills.length} fills, at block ${latest})`)
