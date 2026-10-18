import { Command } from 'commander'

const STUBS = [
  { signature: 'launch', desc: 'guided launch (creator role, salt, dev-buy)', milestone: 'M4' },
  { signature: 'crank <token>', desc: 'collect idle pool fees', milestone: 'M4' },
  { signature: 'bid <token> <amount>', desc: 'fund a pool bid (flywheel inventory)', milestone: 'M4' }
] as const

export function registerStubs(program: Command): void {
  for (const stub of STUBS) {
    const name = stub.signature.split(' ')[0]!
    program
      .command(stub.signature)
      .description(`${stub.desc} — lands in ${stub.milestone}`)
      .action(() => {
        console.log(`${name} lands in ${stub.milestone} — see README roadmap`)
      })
  }
}
