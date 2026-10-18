import {
  encodeAbiParameters,
  getCreate2Address,
  keccak256,
  type Address,
  type Hex
} from 'viem'
import { tokenCreationBytecode } from './abis/ascend-token.js'
import { TOTAL_SUPPLY } from './constants.js'

export interface PredictTokenAddressArgs {
  launchpad: Address
  sender: Address
  salt: Hex
  name: string
  symbol: string
  supply?: bigint
}

/** AscendToken init code: creation bytecode ++ abi.encode(name, symbol, supply). */
export function tokenInitCode(name: string, symbol: string, supply: bigint = TOTAL_SUPPLY): Hex {
  const args = encodeAbiParameters(
    [{ type: 'string' }, { type: 'string' }, { type: 'uint256' }],
    [name, symbol, supply]
  )
  return `${tokenCreationBytecode}${args.slice(2)}` as Hex
}

/** CREATE2 salt used by the launchpad: keccak256(abi.encode(sender, userSalt)). */
export function tokenSalt(sender: Address, salt: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [sender, salt]))
}

/**
 * Token address = CREATE2(launchpad, keccak256(abi.encode(sender, salt)), initcode)
 * where initcode = AscendToken creation code ++ abi.encode(name, symbol, TOTAL_SUPPLY).
 */
export function predictTokenAddress(args: PredictTokenAddressArgs): Address {
  return getCreate2Address({
    from: args.launchpad,
    salt: tokenSalt(args.sender, args.salt),
    bytecode: tokenInitCode(args.name, args.symbol, args.supply)
  })
}
