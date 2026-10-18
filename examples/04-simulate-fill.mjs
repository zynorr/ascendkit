// Offline: replay both real `Filled` events through the SDK's fill simulator —
// the exact-integer port of AscendLaunchpad._fill (band, EMA, fee, window
// clip, protocol split). No RPC calls: the pre-state, the EMA the hook
// observed, the events it emitted and the inventory it debited are all
// committed fixtures, fetched by tools/fixtures/fetch-fill-standing.mjs.
//
//   node examples/04-simulate-fill.mjs
import { readFileSync } from 'node:fs'
import { formatUnits } from 'viem'
import { simulateFill, windowStateBefore } from '@ascendkit/sim'

const root = new URL('../', import.meta.url)
const read = (name) =>
  JSON.parse(readFileSync(new URL(`fixtures/raw/${name}`, root), 'utf8'))

const standing = read('fill-standing.json')
const protocolFees = read('protocolfees.json')
const tokensAccumulated = read('tokensaccumulated.json')

const words = (data) => {
  const hex = data.slice(2)
  return Array.from({ length: hex.length / 64 }, (_, i) =>
    BigInt(`0x${hex.slice(i * 64, (i + 1) * 64)}`)
  )
}
const pad = (address) => `0x${address.slice(2).toLowerCase().padStart(64, '0')}`

const fills = standing.fills.map((f) => ({
  blockTimestamp: f.blockTimestamp,
  quotePaid: BigInt(f.filled.quotePaid)
}))

let allExact = true
for (const [i, fill] of standing.fills.entries()) {
  const prior = fill.atPriorBlock
  const expected = {
    tokensIn: BigInt(fill.filled.tokensIn),
    feeTokens: BigInt(fill.filled.feeTokens),
    quotePaid: BigInt(fill.filled.quotePaid)
  }

  // The window pair has no getters — it reconstructs from Filled logs alone.
  const window = windowStateBefore(fills.slice(0, i), fill.blockTimestamp)
  const spot = BigInt(prior.spotSqrtPriceX96)

  const result = simulateFill(
    {
      tokenIs0: prior.tokenIs0,
      feePips: prior.currentFee,
      spotSqrtPriceX96: spot,
      emaSqrtPriceX96: BigInt(fill.atFillBlock.emaSqrtPrice),
      bidInventory: BigInt(prior.bidInventory),
      maxClip: BigInt(prior.maxClip),
      windowSpent: window.filledInWindow,
      windowExpired: window.expired,
      vaultTokenBalance: BigInt(prior.vaultTokenBalance)
    },
    {
      amountSpecified: -expected.tokensIn,
      zeroForOne: prior.tokenIs0,
      sqrtPriceLimitX96: prior.tokenIs0 ? spot - 1n : spot + 1n
    }
  )
  if (!result.filled) throw new Error(`fill ${i + 1} declined: ${result.reason}`)

  const pf = protocolFees.find(
    (log) => log.transactionHash === fill.txHash && log.topics[2]?.toLowerCase() === pad(fill.token)
  )
  const legs = words(pf.data)
  const accumulated = tokensAccumulated.find(
    (log) =>
      log.transactionHash === fill.txHash &&
      log.topics[2]?.toLowerCase() === pad(fill.token) &&
      Number(log.topics[3]) === 1
  )
  const accumulatedEvent = words(accumulated.data)[0]

  const exact =
    result.tokensIn === expected.tokensIn &&
    result.feeTokens === expected.feeTokens &&
    result.quotePaid === expected.quotePaid &&
    result.protocolFees.stakerYield === legs[0] &&
    result.protocolFees.treasury === legs[1] &&
    result.protocolFees.ecosystem === legs[2] &&
    result.protocolFees.opex === legs[3] &&
    result.protocolFees.kntq === legs[4] &&
    result.accumulatedTokens === accumulatedEvent &&
    BigInt(fill.atFillBlock.bidInventory) ===
      BigInt(prior.bidInventory) - result.quotePaid
  allExact &&= exact

  console.log(
    `fill ${i + 1}  ${fill.txHash.slice(0, 12)}…  block ${fill.blockNumber}`
  )
  console.log(
    `  sold ${formatUnits(expected.tokensIn, 18)} tokens → bid pays ${formatUnits(
      result.quotePaid,
      fill.quoteDecimals
    )} quote (${result.quotePaid} wei) at spot (fully absorbed, capped: ${result.capped})`
  )
  console.log(
    `  event: tokensIn ${result.tokensIn}  feeTokens ${result.feeTokens}  quotePaid ${result.quotePaid}`
  )
  console.log(
    `  split: creator ${formatUnits(result.creatorFeeTokens, 18)}  protocol ${legs
      .map((l) => l.toString())
      .join('/')} (stakerYield/treasury/ecosystem/opex/kntq, matched to the event)`
  )
  console.log(
    `  principal: reserve ${formatUnits(result.reservedTokens, 18)}  accumulated ${formatUnits(
      result.accumulatedTokens,
      18
    )} (matched to TokensAccumulated)`
  )
  console.log(`  inventory ${prior.bidInventory} → ${fill.atFillBlock.bidInventory} (delta = quotePaid)`)
  console.log(exact ? '  reproduced to the wei' : '  MISMATCH — see fixtures')
  console.log('')
}

if (!allExact) process.exit(1)
console.log(
  `${standing.fills.length}/${standing.fills.length} live fills reproduced to the wei from the SDK's simulator`
)
