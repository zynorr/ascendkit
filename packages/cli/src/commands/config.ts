import { Command } from 'commander'
import {
  ADDRESSES,
  CREATOR_BPS,
  elysiumTestnet,
  FEE,
  FLYWHEEL,
  LISTING,
  POOL,
  PROTOCOL_BPS,
  RPC_URL
} from '@ascendkit/core'
import { VERSION } from '../version.js'

export function registerConfig(program: Command): void {
  program
    .command('config')
    .description('Show chain, addresses and protocol constants')
    .action(() => {
      const row = (label: string, value: string | number) =>
        console.log(`${label.padEnd(12)}${value}`)

      console.log(`AscendKit v${VERSION} — unofficial toolkit for the Ascend launchpad`)
      row('chain', `${elysiumTestnet.id} ${elysiumTestnet.name} (HYPE gas)`)
      row('rpc', RPC_URL)
      row('explorer', elysiumTestnet.blockExplorers.default.url)
      row('launchpad', ADDRESSES.ascendLaunchpad)
      row('poolManager', ADDRESSES.infinityPoolManager)
      row('multicall3', ADDRESSES.multicall3)
      row(
        'fee',
        `${FEE.START_PIPS} -> ${FEE.BASE_PIPS} pips over ${FEE.DECAY_SECONDS}s; creator ${CREATOR_BPS / 100}% flat`
      )
      row(
        'protocol',
        `treasury ${PROTOCOL_BPS.TREASURY} / eco ${PROTOCOL_BPS.ECOSYSTEM} / stakerYield ${PROTOCOL_BPS.STAKER_YIELD} / kntq ${PROTOCOL_BPS.KNTQ} / opex ${PROTOCOL_BPS.OPEX} bps`
      )
      row(
        'pool',
        `tickSpacing ${POOL.TICK_SPACING}, hookBitmap 0x0445, parameters 0xC80445, dynamicFee 0x800000`
      )
      row(
        'flywheel',
        `emaTau ${FLYWHEEL.EMA_TAU_SECONDS}s, band ${FLYWHEEL.FILL_BAND_BPS} bps, window ${FLYWHEEL.FILL_WINDOW_SECONDS}s`
      )
      row(
        'listing',
        `setAside ${LISTING.SET_ASIDE_BPS} bps, commitWindow ${LISTING.COMMIT_WINDOW_SECONDS}s, coreFeeCreator ${LISTING.CORE_FEE_CREATOR_BPS} bps`
      )
    })
}
