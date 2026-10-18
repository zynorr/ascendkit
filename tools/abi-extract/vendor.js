import fs from 'node:fs'
import path from 'node:path'

const here = import.meta.dirname
const htmlPath =
  process.argv[2] ?? path.join(process.env.TEMP ?? '/tmp', 'ascend_contract_tab.html')

if (!fs.existsSync(htmlPath)) {
  console.error(`explorer HTML not found: ${htmlPath}`)
  console.error('usage: node vendor.js [path-to-contract-tab.html]')
  process.exit(1)
}

const html = fs.readFileSync(htmlPath, 'utf8')

// The page embeds a Next.js RSC payload inside a JS string, so every quote in the
// flight data is raw-escaped as \". Decode the T-chunks (<key>:T<hexByteLen>,<content>).
const markerRe = /([0-9a-f]{1,6}):T([0-9a-f]{1,6}),/g
const markers = []
let m
while ((m = markerRe.exec(html)) !== null) {
  markers.push({
    key: m[1],
    byteLen: Number.parseInt(m[2], 16),
    start: m.index + m[0].length,
    endBound: html.length
  })
}
for (let i = 0; i < markers.length - 1; i++) markers[i].endBound = markers[i + 1].start - 1

function decodeChunk(marker) {
  let k = marker.start + marker.byteLen
  for (let iter = 0; iter < 200; iter++) {
    if (k > marker.endBound) break
    const candidate = html.slice(marker.start, k)
    let decoded = null
    try {
      decoded = JSON.parse('"' + candidate + '"')
    } catch {
      k += 1
      continue
    }
    const bytes = Buffer.byteLength(decoded, 'utf8')
    if (bytes === marker.byteLen) return decoded
    k += Math.max(1, marker.byteLen - bytes)
  }
  return null
}

const chunks = new Map()
for (const marker of markers) {
  const decoded = decodeChunk(marker)
  if (decoded !== null) chunks.set(marker.key, decoded)
}
console.log(`flight chunks decoded: ${chunks.size}/${markers.length}`)

function stripHtml(s) {
  return s
    .replace(/<[^>]*>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function tryUnwrap(s) {
  try {
    const v = JSON.parse('"' + s + '"')
    return typeof v === 'string' ? v : null
  } catch {
    return null
  }
}

// classify chunks: source texts, highlighted JSON views, bytecode blobs
let settings = null
let explorerAbi = null
const bytecodeBlobs = []
const sourceChunks = new Map()
for (const [key, text] of chunks) {
  if (text.startsWith('<')) {
    try {
      const parsed = JSON.parse(stripHtml(text))
      if (!Array.isArray(parsed) && parsed.evmVersion && parsed.optimizer && parsed.viaIR !== undefined) {
        settings = parsed
      } else if (Array.isArray(parsed) && parsed[0]?.inputs !== undefined) {
        explorerAbi = parsed
      }
    } catch {
      /* not JSON */
    }
    continue
  }
  if (text.startsWith('// SPDX') || text.startsWith('//SPDX')) sourceChunks.set(key, text)
  else if (/^0x[0-9a-fA-F]{1000,}$/.test(text.trim())) bytecodeBlobs.push(text.trim())
}

// ---- sources list: string-escaped region between the last source chunk and f3 ---
const nextAfterSources = markers.find((mk) => mk.key === 'f3')
const anchor = html.indexOf('\\"sources\\":')
if (anchor < 0) {
  console.error('sources anchor not found')
  process.exit(1)
}
const region = html.slice(anchor, nextAfterSources ? nextAfterSources.start : html.length)

const pathRe = /\\"file_path\\":\\"([^\\"]+)\\"/g
const found = []
let pm
while ((pm = pathRe.exec(region)) !== null) {
  found.push({ path: pm[1], after: pm.index + pm[0].length, end: region.length })
}
for (let i = 0; i < found.length - 1; i++) found[i].end = found[i + 1].after
console.log(`sources listed: ${found.length}, source chunks: ${sourceChunks.size}`)

const sources = []
let inlineCount = 0
for (const entry of found) {
  const slice = region.slice(entry.after, entry.end)
  const refMatch = slice.match(/\\"source_code\\":\\"\$([0-9a-f]+)\\"/)
  let content = null
  if (refMatch) {
    content = sourceChunks.get(refMatch[1]) ?? null
  } else {
    const key = '\\"source_code\\":\\"'
    const at = slice.indexOf(key)
    if (at >= 0) {
      const valueStart = entry.after + at + key.length
      let end = -1
      for (let k = valueStart; k < entry.end; k++) {
        if (region[k] !== '"') continue
        let backslashes = 0
        for (let j = k - 1; j >= 0 && region[j] === '\\'; j--) backslashes++
        if (backslashes === 1) {
          end = k
          break
        }
      }
      if (end > valueStart + 1) {
        const rawValue = region.slice(valueStart, end - 1)
        const once = tryUnwrap(rawValue)
        const twice = once === null ? null : tryUnwrap(once)
        content =
          [twice, once, rawValue].find(
            (c) => typeof c === 'string' && c.startsWith('//') && !c.includes('\\n')
          ) ?? null
        inlineCount++
      }
    }
  }
  if (content === null) {
    console.error(`missing content for ${entry.path}`)
    process.exit(1)
  }
  sources.push({ file_path: entry.path, content })
}
console.log(`inline sources resolved: ${inlineCount}, ref sources: ${sources.length - inlineCount}`)

const address = region.match(/\\"address\\":\\"(0x[0-9a-fA-F]{40})\\"/)?.[1] ?? 'unknown'
const contractName = html.match(/\\"name\\":\\"(AscendLaunchpad)\\"/)?.[1] ?? 'AscendLaunchpad'
const versionMatch = html.match(/v0\.8\.\d+\+commit\.[0-9a-f]{8}/)
const compilerVersion = versionMatch ? versionMatch[0] : 'unknown'
if (!settings) settings = null
console.log(`verified contract: ${contractName} at ${address} (${compilerVersion})`)
console.log(`settings: ${JSON.stringify(settings)}`)

// ---- write vendor/ -------------------------------------------------------------
const vendorRoot = path.join(here, 'vendor')
let written = 0
for (const entry of sources) {
  const dest = path.join(vendorRoot, entry.file_path)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, entry.content)
  written++
}

bytecodeBlobs.sort((a, b) => b.length - a.length)
fs.writeFileSync(
  path.join(here, 'explorer-bytecode.json'),
  JSON.stringify(
    {
      note: 'bytecode blobs as displayed by the explorer contract tab (verification artifacts)',
      creation: bytecodeBlobs[0] ?? null,
      deployed: bytecodeBlobs[1] ?? null
    },
    null,
    2
  ) + '\n'
)
if (explorerAbi) {
  fs.writeFileSync(path.join(here, 'explorer-abi.json'), JSON.stringify(explorerAbi, null, 2) + '\n')
}
fs.writeFileSync(
  path.join(here, 'verification.json'),
  JSON.stringify(
    {
      contractName,
      address,
      network: 'testnet',
      compilerVersion,
      compilerSettings: settings,
      sources: sources.map((s) => s.file_path)
    },
    null,
    2
  ) + '\n'
)

const launchpad = sources.find((s) => s.file_path === 'src/AscendLaunchpad.sol')
if (launchpad) {
  console.log(
    `AscendLaunchpad.sol: ${launchpad.content.split('\n').length} lines, ends with ${JSON.stringify(launchpad.content.trimEnd().slice(-40))}`
  )
}
console.log(
  `wrote ${written} sources to vendor/, verification.json, explorer-abi.json (${explorerAbi ? 'yes' : 'no'}), bytecode blobs: ${bytecodeBlobs.length}`
)
