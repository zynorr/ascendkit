import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { decodeFunctionData, encodeAbiParameters, type Address, type Hex } from 'viem'
import { launchpadAbi } from './abis/launchpad.js'
import { tokenCreationBytecode } from './abis/ascend-token.js'
import { predictTokenAddress, tokenInitCode, tokenSalt } from './create2.js'
import { TOTAL_SUPPLY } from './constants.js'

interface LaunchParams {
  creator: Address
  name: string
  symbol: string
  salt: Hex
}

const launchTx = JSON.parse(
  readFileSync(new URL('../../../fixtures/raw/launchtx.json', import.meta.url), 'utf8')
) as {
  hash: Hex
  from: Address
  to: Address
  input: Hex
  expected: { token: Address; poolId: Hex }
}

function decodeLaunch() {
  const decoded = decodeFunctionData({ abi: launchpadAbi, data: launchTx.input })
  if (decoded.functionName !== 'launch') throw new Error('fixture is not a launch()')
  return decoded.args[0] as unknown as LaunchParams
}

describe('create2 token prediction', () => {
  it('predicts the token of a real launch transaction', () => {
    const params = decodeLaunch()
    expect(params.creator.toLowerCase()).toBe(launchTx.from.toLowerCase())
    const predicted = predictTokenAddress({
      launchpad: launchTx.to,
      sender: launchTx.from,
      salt: params.salt,
      name: params.name,
      symbol: params.symbol
    })
    expect(predicted.toLowerCase()).toBe(launchTx.expected.token.toLowerCase())
  })

  it('init code is the creation bytecode plus abi-encoded constructor args', () => {
    const params = decodeLaunch()
    const initCode = tokenInitCode(params.name, params.symbol)
    expect(initCode.startsWith(tokenCreationBytecode)).toBe(true)
    const args = encodeAbiParameters(
      [{ type: 'string' }, { type: 'string' }, { type: 'uint256' }],
      [params.name, params.symbol, TOTAL_SUPPLY]
    )
    expect(initCode).toBe(`${tokenCreationBytecode}${args.slice(2)}`)
  })

  it('salt commits to the sender and the user salt', () => {
    const params = decodeLaunch()
    const salt = tokenSalt(launchTx.from, params.salt)
    expect(salt).toMatch(/^0x[0-9a-f]{64}$/)
    expect(tokenSalt(launchTx.from, params.salt)).toBe(salt)
    const other = tokenSalt('0x0000000000000000000000000000000000000001', params.salt)
    expect(other).not.toBe(salt)
  })
})
