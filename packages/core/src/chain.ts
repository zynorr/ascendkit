import { defineChain, type Address } from 'viem'

export const elysiumTestnet = defineChain({
  id: 99801,
  name: 'Elysium Testnet',
  nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://testnet-rpc.elysium.kinetiq.xyz'] }
  },
  blockExplorers: {
    default: {
      name: 'Elysium Testnet Explorer',
      url: 'https://elysium.kinetiq.xyz/testnet-explorer'
    }
  },
  contracts: {
    multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' }
  },
  testnet: true
})

export const RPC_URL = elysiumTestnet.rpcUrls.default.http[0]

export const ADDRESSES = {
  ascendLaunchpad: '0xc05193a68ED25df678bB7d6644D081BffDAA01D9',
  infinityPoolManager: '0x12e84206cb53ae0df055482ebc4658635096e1aa',
  multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11'
} as const satisfies Record<string, Address>

export const KNOWN_TOKENS = {
  whype: '0xCD57F65c2B0e5881CFC2E609F7CD53b746E1F234',
  usdcDocs: '0x7D29d8047B905000459c0E80c34a26CeedcB47b2'
} as const satisfies Record<string, Address>
