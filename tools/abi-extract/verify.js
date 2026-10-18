import fs from 'node:fs'
import path from 'node:path'
import {
  decodeFunctionData,
  encodeAbiParameters,
  getCreate2Address,
  keccak256,
  toHex
} from 'viem'

const here = import.meta.dirname
const repoRoot = path.join(here, '..', '..')
const outRoot = path.join(here, 'out')

const verification = JSON.parse(fs.readFileSync(path.join(here, 'verification.json'), 'utf8'))
const load = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))
const launchpad = load(path.join(outRoot, 'artifacts', 'AscendLaunchpad.json'))
const token = load(path.join(outRoot, 'artifacts', 'AscendToken.json'))
const poolsFixture = load(path.join(repoRoot, 'fixtures', 'pools.json'))

const RPC = 'https://testnet-rpc.elysium.kinetiq.xyz'
async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  })
  const body = await res.json()
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`)
  return body.result
}

const results = []
function check(name, ok, detail = '') {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

function maskImmutables(hex, refs) {
  const chars = hex.replace(/^0x/, '').toLowerCase().split('')
  for (const positions of Object.values(refs)) {
    for (const { start, length } of positions) {
      for (let i = start * 2; i < (start + length) * 2 && i < chars.length; i++) {
        chars[i] = '_'
      }
    }
  }
  return chars.join('')
}

// 1. deployed bytecode parity (immutable slots masked)
const onchainCode = (await rpc('eth_getCode', [verification.address, 'latest'])).toLowerCase()
const compiledCode = launchpad.deployedBytecode.toLowerCase()
check(
  'bytecode: AscendLaunchpad deployed code matches (immutables masked)',
  maskImmutables(onchainCode, launchpad.immutableReferences) ===
    maskImmutables(compiledCode, launchpad.immutableReferences),
  `${onchainCode.length / 2 - 1} bytes on-chain vs ${compiledCode.length / 2 - 1} compiled`
)

// 2. token deployed bytecode parity for two distinct live tokens
const tokens = [...new Set(poolsFixture.pools.map((p) => p.token))].slice(0, 2)
for (const t of tokens) {
  const code = (await rpc('eth_getCode', [t, 'latest'])).toLowerCase()
  const expected = token.deployedBytecode.toLowerCase()
  check(
    `bytecode: token ${t.slice(0, 10)}… matches (immutables masked)`,
    maskImmutables(code, token.immutableReferences) ===
      maskImmutables(expected, token.immutableReferences),
    `${code.length / 2 - 1} bytes`
  )
}

// 3. event topics: compiled signatures vs every fixture log
const topics = {}
for (const item of launchpad.abi) {
  if (item.type !== 'event') continue
  topics[item.name] = keccak256(
    toHex(`${item.name}(${item.inputs.map((i) => i.type).join(',')})`)
  )
}
const rawDir = path.join(repoRoot, 'fixtures', 'raw')
const eventByFile = {
  launched: 'Launched',
  collected: 'Collected',
  filled: 'Filled',
  bidfunded: 'BidFunded'
}
for (const [file, eventName] of Object.entries(eventByFile)) {
  const logs = load(path.join(rawDir, `${file}.json`))
  const ok = logs.length > 0 && logs.every((l) => l.topics[0] === topics[eventName])
  check(`topics: ${eventName} matches all ${logs.length} fixture logs`, ok, topics[eventName])
}

// 4. CREATE2 token prediction from a real launch transaction
let tx = null
let pool = null
for (const candidate of poolsFixture.pools) {
  const t = await rpc('eth_getTransactionByHash', [candidate.txHash])
  if (t?.to?.toLowerCase() === verification.address.toLowerCase()) {
    tx = t
    pool = candidate
    break
  }
}
if (!tx || !pool) {
  check('CREATE2: found a direct launch transaction', false)
} else {
  const decoded = decodeFunctionData({ abi: launchpad.abi, data: tx.input })
  check(
    `CREATE2: tx ${tx.hash.slice(0, 12)}… decodes as launch() from ${tx.from.slice(0, 10)}…`,
    decoded.functionName === 'launch'
  )
  const params = decoded.args[0]
  check(
    'CREATE2: decoded creator equals the Launched event creator',
    params.creator.toLowerCase() === pool.creator.toLowerCase()
  )
  const totalSupply = 10n ** 27n
  const initCode =
    token.bytecode +
    encodeAbiParameters(
      [{ type: 'string' }, { type: 'string' }, { type: 'uint256' }],
      [params.name, params.symbol, totalSupply]
    ).slice(2)
  const salt = keccak256(
    encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [tx.from, params.salt])
  )
  const predicted = getCreate2Address({
    from: verification.address,
    salt,
    bytecode: initCode
  })
  check(
    `CREATE2: predicted ${predicted} equals fixture token`,
    predicted.toLowerCase() === pool.token.toLowerCase()
  )
}

const failed = results.filter((r) => !r).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
if (failed > 0) process.exitCode = 1
