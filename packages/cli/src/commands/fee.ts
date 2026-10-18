import { Command } from 'commander'
import { FEE } from '@ascendkit/core'
import { feePipsNow, feeSchedule } from '@ascendkit/sim'

export function registerFee(program: Command): void {
  program
    .command('fee')
    .description('Show the sniper-tax decay schedule, or the fee at a launch time')
    .option('--launched-at <unixSeconds>', 'pool launch time; prints the fee now')
    .option('--horizon <seconds>', 'schedule horizon', '12')
    .action((opts: { launchedAt?: string; horizon: string }) => {
      if (opts.launchedAt !== undefined) {
        const launchedAt = BigInt(opts.launchedAt)
        const now = BigInt(Math.floor(Date.now() / 1000))
        const elapsed = now - launchedAt
        const pips = feePipsNow(launchedAt, now)
        console.log(`launched at  ${new Date(Number(launchedAt) * 1000).toISOString()}`)
        console.log(`now          ${new Date(Number(now) * 1000).toISOString()}`)
        console.log(`elapsed      ${elapsed}s`)
        console.log(`fee now      ${pips} pips (${pips / 10_000}%)`)
        if (elapsed < FEE.DECAY_SECONDS) {
          console.log(
            `decays to    ${FEE.BASE_PIPS} pips in ${FEE.DECAY_SECONDS - elapsed}s`
          )
        }
        return
      }

      const horizon = Number(opts.horizon)
      console.log('elapsed   fee pips   %')
      for (const step of feeSchedule(horizon)) {
        console.log(
          `t+${String(step.elapsedSeconds).padEnd(7)} ${String(step.pips).padEnd(10)} ${step.percent}`
        )
      }
      console.log('')
      console.log('Per pool, currentFee(poolId) on-chain is the live authority: ak pool <token>')
    })
}
