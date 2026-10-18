import { decodeEventLog, toHex, type Address, type Hex, type PublicClient } from 'viem'
import { ADDRESSES, launchpadAbi, launchpadEventTopics } from '@ascendkit/core'

export interface EventMeta {
  blockNumber: bigint
  txHash: Hex
  logIndex: number
}

export interface LaunchedEvent extends EventMeta {
  type: 'Launched'
  poolId: Hex
  token: Address
  creator: Address
  quote: Address
  supplySeeded: bigint
  devBuyTokens: bigint
}

export interface CollectedEvent extends EventMeta {
  type: 'Collected'
  poolId: Hex
  tokenFees: bigint
  quoteFees: bigint
  tokensBurned: bigint
  flywheelQuote: bigint
}

export interface FilledEvent extends EventMeta {
  type: 'Filled'
  poolId: Hex
  tokensIn: bigint
  feeTokens: bigint
  tokensBurned: bigint
  quotePaid: bigint
}

export interface BidFundedEvent extends EventMeta {
  type: 'BidFunded'
  poolId: Hex
  funder: Address
  amount: bigint
}

export interface ProtocolFeesAllocatedEvent extends EventMeta {
  type: 'ProtocolFeesAllocated'
  poolId: Hex
  asset: Address
  stakerYield: bigint
  treasury: bigint
  ecosystem: bigint
  opex: bigint
  kntq: bigint
}

export interface TokensAccumulatedEvent extends EventMeta {
  type: 'TokensAccumulated'
  poolId: Hex
  token: Address
  source: number
  amount: bigint
}

export interface CreatorClaimedEvent extends EventMeta {
  type: 'CreatorClaimed'
  poolId: Hex
  creator: Address
  tokenAmount: bigint
  quoteAmount: bigint
}

export type LaunchpadEvent =
  | LaunchedEvent
  | CollectedEvent
  | FilledEvent
  | BidFundedEvent
  | ProtocolFeesAllocatedEvent
  | TokensAccumulatedEvent
  | CreatorClaimedEvent

/** Events whose first indexed argument is the poolId. */
export const POOL_EVENT_NAMES = [
  'BidFunded',
  'Collected',
  'CreatorClaimed',
  'CreatorTransferStarted',
  'CreatorTransferred',
  'Filled',
  'ListingSetAside',
  'ProtocolFeesAllocated',
  'TokensAccumulated'
] as const

export const poolEventTopics: Hex[] = POOL_EVENT_NAMES.map(
  (name) => launchpadEventTopics[name]
)

const ZERO_HASH = `0x${'00'.repeat(32)}` as Hex

/** Raw RPC log (hex-string fields) or viem log (bigint fields) — both accepted. */
export interface RawLogLike {
  topics: readonly Hex[]
  data: Hex
  blockNumber?: bigint | number | string
  transactionHash?: Hex
  logIndex?: number | string
}

function toMeta(raw: RawLogLike): EventMeta {
  return {
    blockNumber: raw.blockNumber === undefined ? 0n : BigInt(raw.blockNumber as bigint),
    txHash: raw.transactionHash ?? ZERO_HASH,
    logIndex: raw.logIndex === undefined ? 0 : Number(raw.logIndex)
  }
}

const DECODED_TYPES = new Set([
  'Launched',
  'Collected',
  'Filled',
  'BidFunded',
  'ProtocolFeesAllocated',
  'TokensAccumulated',
  'CreatorClaimed'
])

/** Decode a raw launchpad log into a typed event; null for unrelated events. */
export function decodeLaunchpadLog(raw: RawLogLike): LaunchpadEvent | null {
  let decoded: { eventName: string; args: unknown }
  try {
    decoded = decodeEventLog({
      abi: launchpadAbi,
      topics: raw.topics as [Hex, ...Hex[]],
      data: raw.data
    }) as unknown as { eventName: string; args: unknown }
  } catch {
    return null
  }
  if (!DECODED_TYPES.has(decoded.eventName)) return null
  const args = decoded.args as Record<string, unknown>
  const meta = toMeta(raw)
  switch (decoded.eventName) {
    case 'Launched':
      return {
        type: 'Launched',
        ...meta,
        poolId: args.poolId as Hex,
        token: args.token as Address,
        creator: args.creator as Address,
        quote: args.quote as Address,
        supplySeeded: args.supplySeeded as bigint,
        devBuyTokens: args.devBuyTokens as bigint
      }
    case 'Collected':
      return {
        type: 'Collected',
        ...meta,
        poolId: args.poolId as Hex,
        tokenFees: args.tokenFees as bigint,
        quoteFees: args.quoteFees as bigint,
        tokensBurned: args.tokensBurned as bigint,
        flywheelQuote: args.flywheelQuote as bigint
      }
    case 'Filled':
      return {
        type: 'Filled',
        ...meta,
        poolId: args.poolId as Hex,
        tokensIn: args.tokensIn as bigint,
        feeTokens: args.feeTokens as bigint,
        tokensBurned: args.tokensBurned as bigint,
        quotePaid: args.quotePaid as bigint
      }
    case 'BidFunded':
      return {
        type: 'BidFunded',
        ...meta,
        poolId: args.poolId as Hex,
        funder: args.funder as Address,
        amount: args.amount as bigint
      }
    case 'ProtocolFeesAllocated':
      return {
        type: 'ProtocolFeesAllocated',
        ...meta,
        poolId: args.poolId as Hex,
        asset: args.asset as Address,
        stakerYield: args.stakerYield as bigint,
        treasury: args.treasury as bigint,
        ecosystem: args.ecosystem as bigint,
        opex: args.opex as bigint,
        kntq: args.kntq as bigint
      }
    case 'TokensAccumulated':
      return {
        type: 'TokensAccumulated',
        ...meta,
        poolId: args.poolId as Hex,
        token: args.token as Address,
        source: Number(args.source as bigint),
        amount: args.amount as bigint
      }
    case 'CreatorClaimed':
      return {
        type: 'CreatorClaimed',
        ...meta,
        poolId: args.poolId as Hex,
        creator: args.creator as Address,
        tokenAmount: args.tokenAmount as bigint,
        quoteAmount: args.quoteAmount as bigint
      }
    default:
      return null
  }
}

export interface PoolSummary {
  poolId: Hex
  token: Address
  creator: Address
  quote: Address
  supplySeeded: bigint
  devBuyTokens: bigint
  /** Block timestamp (unix seconds) of the launch. */
  launchedAt: number
  blockNumber: number
  txHash: Hex
}

export interface FetchLogsOptions {
  fromBlock?: bigint
  toBlock?: bigint
  chunkSize?: bigint
}

async function getLogsChunked(
  client: PublicClient,
  topics: (Hex | Hex[])[],
  opts: FetchLogsOptions
): Promise<RawLogLike[]> {
  const address = ADDRESSES.ascendLaunchpad
  const latest = await client.getBlockNumber()
  const to = opts.toBlock ?? latest
  const from = opts.fromBlock ?? 0n
  const chunk = opts.chunkSize ?? 200_000n
  const logs: RawLogLike[] = []
  for (let start = from; start <= to; start += chunk) {
    const candidate = start + chunk - 1n
    const end = candidate > to ? to : candidate
    const batch = await client.request({
      method: 'eth_getLogs',
      params: [{ address, topics, fromBlock: toHex(start), toBlock: toHex(end) }]
    })
    logs.push(...(batch as unknown as RawLogLike[]))
  }
  return logs
}

function byPosition(a: EventMeta, b: EventMeta): number {
  if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1
  return a.logIndex - b.logIndex
}

/**
 * Enumerate launchpad pools from `Launched` logs, oldest first. Timestamps come
 * from the launch blocks (one extra getBlock per distinct block, cached).
 */
export async function listPools(
  client: PublicClient,
  opts: FetchLogsOptions = {}
): Promise<PoolSummary[]> {
  const logs = await getLogsChunked(client, [launchpadEventTopics.Launched], opts)
  const events = logs
    .map((log) => decodeLaunchpadLog(log))
    .filter((e): e is LaunchedEvent => e?.type === 'Launched')
    .sort(byPosition)

  const timestamps = new Map<bigint, number>()
  for (const event of events) {
    if (!timestamps.has(event.blockNumber)) {
      const block = await client.getBlock({ blockNumber: event.blockNumber })
      timestamps.set(event.blockNumber, Number(block.timestamp))
    }
  }

  return events.map((e) => ({
    poolId: e.poolId,
    token: e.token,
    creator: e.creator,
    quote: e.quote,
    supplySeeded: e.supplySeeded,
    devBuyTokens: e.devBuyTokens,
    launchedAt: timestamps.get(e.blockNumber) ?? 0,
    blockNumber: Number(e.blockNumber),
    txHash: e.txHash
  }))
}

/** Every pool-scoped event of one pool, oldest first. */
export async function poolHistory(
  client: PublicClient,
  poolId: Hex,
  opts: FetchLogsOptions = {}
): Promise<LaunchpadEvent[]> {
  const logs = await getLogsChunked(client, [poolEventTopics, poolId], opts)
  return logs
    .map((log) => decodeLaunchpadLog(log))
    .filter((e): e is LaunchpadEvent => e !== null)
    .sort(byPosition)
}

export interface PoolSnapshot {
  poolId: Hex
  /** False when the launchpad never launched that pair (poolLaunchedAt sentinel is 0). */
  exists: boolean
  launchedAt: number
  creator: Address
  tokenIs0: boolean
  startTick: number
  currentFee: number
  maxClip: bigint
  bidInventory: bigint
  emaSqrtPrice: bigint
  emaUpdatedAt: number
}

/** One multicall snapshot of a pool's launchpad-side state. */
export async function snapshotPool(
  client: PublicClient,
  poolId: Hex,
  launchpad: Address = ADDRESSES.ascendLaunchpad
): Promise<PoolSnapshot> {
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
  ] = await client.multicall({
    allowFailure: false,
    contracts: [
      { address: launchpad, abi: launchpadAbi, functionName: 'poolLaunchedAt', args: [poolId] },
      { address: launchpad, abi: launchpadAbi, functionName: 'poolCreator', args: [poolId] },
      { address: launchpad, abi: launchpadAbi, functionName: 'poolTokenIs0', args: [poolId] },
      { address: launchpad, abi: launchpadAbi, functionName: 'poolStartTick', args: [poolId] },
      { address: launchpad, abi: launchpadAbi, functionName: 'currentFee', args: [poolId] },
      { address: launchpad, abi: launchpadAbi, functionName: 'poolMaxClip', args: [poolId] },
      { address: launchpad, abi: launchpadAbi, functionName: 'bidInventory', args: [poolId] },
      { address: launchpad, abi: launchpadAbi, functionName: 'emaSqrtPrice', args: [poolId] },
      { address: launchpad, abi: launchpadAbi, functionName: 'emaUpdatedAt', args: [poolId] }
    ]
  })
  const launchedAtNum = Number(launchedAt)
  return {
    poolId,
    exists: launchedAtNum !== 0,
    launchedAt: launchedAtNum,
    creator: creator as Address,
    tokenIs0: tokenIs0 as boolean,
    startTick: Number(startTick),
    currentFee: Number(currentFee),
    maxClip: maxClip as bigint,
    bidInventory: bidInventory as bigint,
    emaSqrtPrice: emaSqrtPrice as bigint,
    emaUpdatedAt: Number(emaUpdatedAt)
  }
}
