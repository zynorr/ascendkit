import { Bot } from 'grammy'
import { ADDRESSES, elysiumTestnet } from '@ascendkit/core'
import { feeSchedule } from '@ascendkit/sim'

const token = process.env.TELEGRAM_BOT_TOKEN
if (token === undefined || token === '') {
  console.error('TELEGRAM_BOT_TOKEN is not set — copy .env.example to .env (see apps/bot/README.md)')
  process.exit(1)
}

const bot = new Bot(token)

bot.command('start', async (ctx) => {
  await ctx.reply(
    [
      'AscendKit bot (scaffold, unofficial)',
      `chain: ${elysiumTestnet.id} (${elysiumTestnet.name})`,
      `launchpad: ${ADDRESSES.ascendLaunchpad}`,
      '',
      'Coming in M4: /launch wizard (creator role, CREATE2 salt, dev-buy), /watch, /pool.'
    ].join('\n')
  )
})

bot.command('fee', async (ctx) => {
  const rows = feeSchedule(5)
    .map((s) => `t+${s.elapsedSeconds}s: ${s.pips} pips (${s.percent}%)`)
    .join('\n')
  await ctx.reply(`Sniper-tax decay (BASE then stays at 1%):\n${rows}`)
})

bot.start().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
