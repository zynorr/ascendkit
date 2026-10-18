import { Command } from 'commander'
import {
  createPublicClient,
  formatUnits,
  http,
  isAddress,
  parseUnits,
  type Address
} from 'viem'
import {
  ADDRESSES,
  curveBoundsOf,
  curveTopOf,
  elysiumTestnet,
  launchpadAbi,
  MAX_SQRT_RATIO,
  MIN_SQRT_RATIO,
  POOL,
  poolIdOf,
  poolKeyOf,
  RPC_URL,
  type CurveStep
} from '@ascendkit/core'
import { poolHistory, poolSpot, snapshotPool } from '@ascendkit/indexer'
import { observeEma, simulateFill, windowStateBefore, type FillLog } from '@ascendkit/sim'

const erc20DecimalsAbi = [
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }]
  }
] as const

export function registerQuote(program: Command): void {
  program
    .command('quote')
    .description('Simulate a sell against a pool, flywheel fill included, to the wei')
    .argument('<token>', 'launched token address')
    .argument('<amount>', 'tokens to sell (decimal, e.g. 1000.5)')
    .option('--quote <address>', 'quote token (default: the launchpad base quote)')
    .option('--rpc <url>', 'RPC URL', RPC_URL)
    .option('--json', 'print the full JSON instead of a report')
    .action(async (token: string, amount: string, opts: { quote?: string; rpc: string; json?: boolean }) => {
      if (!isAddress(token)) throw new Error(`not an address: ${token}`)
      if (opts.quote !== undefined && !isAddress(opts.quote)) {
        throw new Error(`not an address: ${opts.quote}`)
      }

      const client = createPublicClient({ chain: elysiumTestnet, transport: http(opts.rpc) })
      const launchpad = ADDRESSES.ascendLaunchpad

      const quote =
        opts.quote ??
        ((await client.readContract({
          address: launchpad,
          abi: launchpadAbi,
          functionName: 'baseQuote'
        })) as Address)

      const key = poolKeyOf(token as Address, quote, {
        hook: launchpad,
        poolManager: ADDRESSES.infinityPoolManager
      })
      const poolId = poolIdOf(key)

      const [snapshot, spot, curve, history, quoteDecimals] = await Promise.all([
        snapshotPool(client, poolId),
        poolSpot(client, poolId),
        client.readContract({ address: launchpad, abi: launchpadAbi, functionName: 'curve' }),
        poolHistory(client, poolId),
        client.readContract({
          address: quote,
          abi: erc20DecimalsAbi,
          functionName: 'decimals'
        })
      ])

      if (!snapshot.exists) {
        throw new Error('unknown pool: this launchpad never launched that pair')
      }

      const sellWei = parseUnits(amount, 18)
      const now = Math.floor(Date.now() / 1000)

      // The EMA a swap in the next block would hit: one _observe step from the
      // stored value with the spot clamped to the curve bounds (SC-16).
      const bounds = curveBoundsOf(
        snapshot.tokenIs0,
        snapshot.startTick,
        curveTopOf(curve as CurveStep[]),
        POOL.TICK_SPACING
      )
      const clampedSpot =
        spot.sqrtPriceX96 < bounds.lo
          ? bounds.lo
          : spot.sqrtPriceX96 > bounds.hi
            ? bounds.hi
            : spot.sqrtPriceX96
      const emaObserved = observeEma(
        snapshot.emaSqrtPrice,
        clampedSpot,
        Math.max(0, now - snapshot.emaUpdatedAt)
      )

      // Window pair reconstructed from Filled logs alone (no getters, by design).
      const timestamps = new Map<bigint, number>()
      for (const event of history) {
        if (event.type === 'Filled' && !timestamps.has(event.blockNumber)) {
          const block = await client.getBlock({ blockNumber: event.blockNumber })
          timestamps.set(event.blockNumber, Number(block.timestamp))
        }
      }
      const fills: FillLog[] = history
        .filter((e) => e.type === 'Filled')
        .map((e) => ({
          blockTimestamp: timestamps.get(e.blockNumber) ?? 0,
          quotePaid: (e as Extract<typeof e, { type: 'Filled' }>).quotePaid
        }))
      const window = windowStateBefore(fills, now)

      const result = simulateFill(
        {
          tokenIs0: snapshot.tokenIs0,
          feePips: snapshot.currentFee,
          spotSqrtPriceX96: spot.sqrtPriceX96,
          emaSqrtPriceX96: emaObserved,
          bidInventory: snapshot.bidInventory,
          maxClip: snapshot.maxClip,
          windowSpent: window.filledInWindow,
          windowExpired: window.expired
        },
        {
          amountSpecified: -sellWei,
          zeroForOne: snapshot.tokenIs0,
          sqrtPriceLimitX96: snapshot.tokenIs0
            ? MIN_SQRT_RATIO + 1n
            : MAX_SQRT_RATIO - 1n
        }
      )

      const quoteAmount = (value: bigint) => `${formatUnits(value, quoteDecimals)} quote`
      const tokenAmount = (value: bigint) => `${formatUnits(value, 18)} tokens`
      const windowLeft = window.expired
        ? 'expired — resets on the next fill'
        : `resets in ${Math.max(0, window.windowStart + 600 - now)}s`

      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              poolId,
              token,
              quote,
              spot: { sqrtPriceX96: spot.sqrtPriceX96.toString(), tick: spot.tick },
              ema: {
                stored: snapshot.emaSqrtPrice.toString(),
                observedNow: emaObserved.toString(),
                emaUpdatedAt: snapshot.emaUpdatedAt
              },
              window: {
                windowStart: window.windowStart,
                filledInWindow: window.filledInWindow.toString(),
                expired: window.expired,
                maxClip: snapshot.maxClip.toString()
              },
              bidInventory: snapshot.bidInventory.toString(),
              feePips: snapshot.currentFee,
              sell: {
                tokens: sellWei.toString(),
                result:
                  result.filled
                    ? {
                        filled: true,
                        tokensIn: result.tokensIn.toString(),
                        feeTokens: result.feeTokens.toString(),
                        quotePaid: result.quotePaid.toString(),
                        netTokens: result.netTokens.toString(),
                        creatorFeeTokens: result.creatorFeeTokens.toString(),
                        protocolFees: {
                          stakerYield: result.protocolFees.stakerYield.toString(),
                          treasury: result.protocolFees.treasury.toString(),
                          ecosystem: result.protocolFees.ecosystem.toString(),
                          opex: result.protocolFees.opex.toString(),
                          kntq: result.protocolFees.kntq.toString()
                        },
                        reservedTokens: result.reservedTokens.toString(),
                        accumulatedTokens: result.accumulatedTokens.toString(),
                        capped: result.capped,
                        ammTokens: result.ammTokens.toString()
                      }
                    : result
              }
            },
            null,
            2
          )
        )
        return
      }

      console.log(`token        ${token}`)
      console.log(`quote        ${quote} (${quoteDecimals} decimals)`)
      console.log(`poolId       ${poolId}`)
      console.log(`spot         tick ${spot.tick} @ ${spot.sqrtPriceX96}`)
      console.log(`ema stored   ${snapshot.emaSqrtPrice}`)
      console.log(`ema observed ${emaObserved} (clamped spot, dt=${Math.max(0, now - snapshot.emaUpdatedAt)}s)`)
      console.log(`window       ${quoteAmount(window.filledInWindow)} of ${quoteAmount(snapshot.maxClip)} — ${windowLeft}`)
      console.log(`bid          ${quoteAmount(snapshot.bidInventory)}`)
      console.log(`fee          ${snapshot.currentFee} pips`)
      console.log('')
      console.log(`sell ${amount} tokens →`)
      if (!result.filled) {
        console.log(`  no fill: ${result.reason} — the whole sell routes through the AMM`)
        return
      }
      console.log(`  absorbed      ${tokenAmount(result.tokensIn)}${result.capped ? ` (capped)` : ''}`)
      console.log(`  seller gets   ${quoteAmount(result.quotePaid)} at spot`)
      console.log(`  fee           ${tokenAmount(result.feeTokens)} (creator ${formatUnits(result.creatorFeeTokens, 18)}, protocol ${formatUnits(result.protocolFeeTokens, 18)})`)
      console.log(`  principal     net ${formatUnits(result.netTokens, 18)} → reserve ${formatUnits(result.reservedTokens, 18)} + accumulated ${formatUnits(result.accumulatedTokens, 18)}`)
      console.log(`  amm remainder ${tokenAmount(result.ammTokens)} (output not modeled)`)
    })
}
