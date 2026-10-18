#!/usr/bin/env node
import { Command } from 'commander'
import { VERSION } from './version.js'
import { registerConfig } from './commands/config.js'
import { registerDecode } from './commands/decode.js'
import { registerFee } from './commands/fee.js'
import { registerPool } from './commands/pool.js'
import { registerPools } from './commands/pools.js'
import { registerQuote } from './commands/quote.js'
import { registerStubs } from './commands/stubs.js'
import { registerWatch } from './commands/watch.js'

const program = new Command()
program
  .name('ak')
  .description('AscendKit CLI — Ascend launchpad on Elysium testnet (unofficial)')
  .version(VERSION)

registerConfig(program)
registerDecode(program)
registerFee(program)
registerPool(program)
registerPools(program)
registerQuote(program)
registerStubs(program)
registerWatch(program)

try {
  await program.parseAsync(process.argv)
} catch (err) {
  console.error(err instanceof Error ? err.message : err)
  process.exitCode = 1
}
