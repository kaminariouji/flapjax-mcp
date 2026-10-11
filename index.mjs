#!/usr/bin/env node
// flapjax-mcp — zero-dependency MCP server (stdio) exposing read-only FLAPJAX on-chain state on BSC.
// Reads only: eth_call / eth_getBalance / eth_blockNumber against public BSC RPCs. No keys, no writes.
//
// Tools: pool_state, depth, quote, treasury, check_address, info
//
// Protocol: JSON-RPC 2.0 over stdio, newline-delimited. Logs go to stderr only.

const VERSION = '1.0.0'

// ---- constants (BSC mainnet) ----
const FLAPJAX = '0x90c8889f428F9Ebb77BB8f15CAD3a50a9aC680df'
const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'
const POOL = '0xcA93EC685b8623688E6B236f9068034B298c2150' // FLAPJAX/WBNB 1% PancakeSwap V3
const TREASURY = '0x7C34E9e21eE28A49Ff0b84B61774119E6633359f'
const QUOTER = '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997' // PancakeSwap V3 QuoterV2
const FEE = 10000n

const RPCS = [
  'https://bsc-dataseed.binance.org',
  'https://bsc-dataseed1.defibit.io',
  'https://bsc-dataseed1.ninicoin.io',
  'https://bsc-rpc.publicnode.com',
]

const Q96 = 2n ** 96n
const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n

const SEL = {
  slot0: '0x3850c7bd',
  liquidity: '0x1a686502',
  balanceOf: '0x70a08231',
  quoteExactInputSingle: '0xc6a5026a',
}

// ---- rpc ----
async function rpc(url, method, params) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const j = await r.json()
  if (j.error) throw new Error(`${url}: ${String(j.error.message).slice(0, 120)}`)
  return j.result
}

async function rpcAny(method, params, label) {
  let lastErr
  for (const u of RPCS) {
    try { return await rpc(u, method, params) } catch (e) { lastErr = e }
  }
  throw new Error(`${label}: all public RPCs failed (${lastErr?.message || 'unknown'})`)
}

const pad = (v) => BigInt(v).toString(16).padStart(64, '0')
const encAddr = (a) => a.toLowerCase().replace('0x', '').padStart(64, '0')
const hexBlock = (n) => '0x' + n.toString(16)

function words(hex) {
  const h = hex.replace(/^0x/, '')
  const out = []
  for (let i = 0; i < h.length; i += 64) out.push(BigInt('0x' + h.slice(i, i + 64)))
  return out
}

async function ethCall(to, data, label) {
  return rpcAny('eth_call', [{ to, data }, 'latest'], label)
}

async function readPoolState() {
  const [blockHex, slotRaw, liqRaw] = await Promise.all([
    rpcAny('eth_blockNumber', [], 'blockNumber'),
    ethCall(POOL, SEL.slot0, 'slot0'),
    ethCall(POOL, SEL.liquidity, 'liquidity'),
  ])
  const s = words(slotRaw)
  const sqrtPriceX96 = s[0]
  const tick = BigInt.asIntN(24, s[1])
  const L = words(liqRaw)[0]
  return { block: Number(BigInt(blockHex)), sqrtPriceX96, tick, L }
}

function midPrice(sqrtPriceX96) {
  // token0 = FLAPJAX, token1 = WBNB (sorted by address)
  const p = (Number(sqrtPriceX96) / Number(Q96)) ** 2 // WBNB per FJ
  return { wbnbPerFj: p, fjPerWbnb: 1 / p }
}

function analytic(Lraw, sqrtRaw) {
  const L = Number(Lraw)
  const s = Number(sqrtRaw)
  const depth = (ratio) => {
    const st = s * Math.sqrt(ratio)
    if (ratio >= 1) {
      return { netInRaw: L * (st - s) / Number(Q96), outRaw: L * Number(Q96) * (st - s) / (s * st), inSide: 'WBNB', outSide: 'FJ' }
    }
    return { netInRaw: L * Number(Q96) * (s - st) / (s * st), outRaw: L * (s - st) / Number(Q96), inSide: 'FJ', outSide: 'WBNB' }
  }
  return { depth }
}

async function quote(side, amountWei) {
  const tokenIn = side === 'buy' ? WBNB : FLAPJAX
  const tokenOut = side === 'buy' ? FLAPJAX : WBNB
  const data = SEL.quoteExactInputSingle + encAddr(tokenIn) + encAddr(tokenOut) + pad(amountWei) + pad(FEE) + pad(MAX_SQRT_RATIO - 1n)
  const ret = await ethCall(QUOTER, data, `quote ${side}`)
  return words(ret)[0]
}

const fmt = (raw, dec = 18) => Number(raw) / 10 ** dec

// ---- tool implementations ----
async function tPoolState() {
  const st = await readPoolState()
  const mp = midPrice(st.sqrtPriceX96)
  return {
    block: st.block,
    sqrtPriceX96: st.sqrtPriceX96.toString(),
    tick: Number(st.tick),
    liquidity: st.L.toString(),
    midPrice: {
      wbnbPerFj: mp.wbnbPerFj,
      fjPerWbnb: mp.fjPerWbnb,
      note: 'from slot0 sqrtPriceX96; token0=FLAPJAX, token1=WBNB',
    },
    pool: POOL,
    fee: 10000,
  }
}

async function tDepth({ percent }) {
  const pct = Number(percent ?? 2)
  if (!(pct > 0 && pct < 50)) throw new Error('percent must be between 0 and 50')
  const st = await readPoolState()
  const { depth } = analytic(st.L, st.sqrtPriceX96)
  const up = depth(1 + pct / 100)
  const down = depth(1 - pct / 100)
  return {
    block: st.block,
    movePercent: pct,
    up: {
      interpretation: 'price rises — buying FJ with WBNB',
      netWbnbIn: fmt(BigInt(Math.round(up.netInRaw))),
      grossWbnbIn: fmt(BigInt(Math.round(up.netInRaw))) / 0.99,
      fjOut: fmt(BigInt(Math.round(up.outRaw))),
      note: 'net = absorbed by the curve; gross = what a trader pays (net/0.99, 1% pool fee)',
    },
    down: {
      interpretation: 'price falls — selling FJ for WBNB',
      netFjIn: fmt(BigInt(Math.round(down.netInRaw))),
      grossFjIn: fmt(BigInt(Math.round(down.netInRaw))) / 0.99,
      wbnbOut: fmt(BigInt(Math.round(down.outRaw))),
    },
  }
}

async function tQuote({ side, amount }) {
  if (side !== 'buy' && side !== 'sell') throw new Error('side must be "buy" (WBNB -> FJ) or "sell" (FJ -> WBNB)')
  const amt = Number(amount)
  if (!(amt > 0)) throw new Error('amount must be a positive number (human units: BNB for buy, FJ for sell)')
  const amountWei = BigInt(Math.round(amt * 1e6)) * 10n ** 12n
  const out = await quote(side, amountWei)
  const outSide = side === 'buy' ? 'FJ' : 'WBNB'
  return {
    side,
    amountIn: amt,
    amountInWei: amountWei.toString(),
    amountOut: fmt(out),
    amountOutRaw: out.toString(),
    amountOutSide: outSide,
    route: side === 'buy' ? 'WBNB -> FLAPJAX (1% pool)' : 'FLAPJAX -> WBNB (1% pool)',
    note: 'PancakeSwap V3 QuoterV2, quoteExactInputSingle, fee 10000',
  }
}

async function tTreasury() {
  const [bnbRaw, fjRaw, wbnbRaw, poolFjRaw] = await Promise.all([
    rpcAny('eth_getBalance', [TREASURY, 'latest'], 'treasury BNB'),
    ethCall(FLAPJAX, SEL.balanceOf + encAddr(TREASURY), 'treasury FJ'),
    ethCall(WBNB, SEL.balanceOf + encAddr(TREASURY), 'treasury WBNB'),
    ethCall(FLAPJAX, SEL.balanceOf + encAddr(POOL), 'pool FJ'),
  ])
  const bnb = fmt(BigInt(bnbRaw))
  return {
    treasury: TREASURY,
    balances: {
      bnb,
      flapjax: fmt(words(fjRaw)[0]),
      wbnb: fmt(words(wbnbRaw)[0]),
    },
    poolFlapjax: fmt(words(poolFjRaw)[0]),
    buybackContext: {
      program: 'FLAPJAX/WBNB buyback: 0.01 BNB/day, 2026-10-09 .. 2026-10-22, buy-only',
      skipRule: 'skips a day if treasury BNB minus the ~0.11 BNB baseline is below 0.025 (derived in the public buyback review)',
      derivedAvailableBnb: bnb - 0.11,
      wouldBuyNow: bnb - 0.11 >= 0.025,
    },
  }
}

async function tCheckAddress({ address }) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(address || ''))) throw new Error('address must be 0x + 40 hex chars')
  const [bnbRaw, fjRaw, wbnbRaw] = await Promise.all([
    rpcAny('eth_getBalance', [address, 'latest'], 'addr BNB'),
    ethCall(FLAPJAX, SEL.balanceOf + encAddr(address), 'addr FJ'),
    ethCall(WBNB, SEL.balanceOf + encAddr(address), 'addr WBNB'),
  ])
  return {
    address,
    bnb: fmt(BigInt(bnbRaw)),
    flapjax: fmt(words(fjRaw)[0]),
    wbnb: fmt(words(wbnbRaw)[0]),
    note: 'read-only balanceOf checks — the same reads the FlapJax wallet checker exposes over x402',
  }
}

function tInfo() {
  return {
    token: { symbol: 'FLAPJAX', contract: FLAPJAX, chain: 'BSC (56)', decimals: 18 },
    pool: { address: POOL, pair: 'FLAPJAX/WBNB', fee: '1%', dex: 'PancakeSwap V3' },
    treasury: TREASURY,
    buyback: '0.01 BNB/day, 2026-10-09 .. 2026-10-22, receipts posted publicly',
    quirk: 'Pancake V3 tickBitmap is indexed by compressed tick (tick / tickSpacing = 200 here), not the raw tick',
    links: {
      probe: 'https://kaminariouji.github.io/flapjax-probe/',
      lander: 'https://flapjax.surge.sh',
    },
    disclaimer: 'read-only public data; not financial advice; public RPC endpoints may rate-limit',
  }
}

// ---- MCP plumbing ----
const TOOLS = [
  {
    name: 'pool_state',
    description: 'Current FLAPJAX/WBNB 1% PancakeSwap V3 pool state on BSC: sqrtPriceX96, tick, liquidity, and mid price in both directions, pinned to a block number.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'depth',
    description: 'Pool depth around the current price: how much WBNB (up) or FLAPJAX (down) the curve absorbs for a +/- percent move, in both fee conventions (net = curve, gross = trader pays net/0.99).',
    inputSchema: {
      type: 'object',
      properties: { percent: { type: 'number', description: 'price move percent, default 2 (e.g. 2 or 5)' } },
      additionalProperties: false,
    },
  },
  {
    name: 'quote',
    description: 'Live PancakeSwap V3 QuoterV2 quote on the FLAPJAX/WBNB 1% pool. side="buy" quotes WBNB -> FLAPJAX, side="sell" quotes FLAPJAX -> WBNB. Amounts in human units.',
    inputSchema: {
      type: 'object',
      properties: {
        side: { type: 'string', enum: ['buy', 'sell'] },
        amount: { type: 'number', description: 'amount in human units: BNB for buy, FLAPJAX for sell' },
      },
      required: ['side', 'amount'],
      additionalProperties: false,
    },
  },
  {
    name: 'treasury',
    description: 'FlapJax treasury and pool balances (BNB, FLAPJAX, WBNB, pool FLAPJAX) plus the daily buyback context (0.01 BNB/day, skip rule projection).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'check_address',
    description: 'Read-only balance check for any BSC address: BNB, FLAPJAX, WBNB. Useful to verify an agent or wallet actually got paid.',
    inputSchema: {
      type: 'object',
      properties: { address: { type: 'string', description: '0x-prefixed BSC address' } },
      required: ['address'],
      additionalProperties: false,
    },
  },
  {
    name: 'info',
    description: 'Static reference: token/pool/treasury addresses, buyback program, known quirks, links.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
]

const HANDLERS = {
  pool_state: tPoolState,
  depth: tDepth,
  quote: tQuote,
  treasury: tTreasury,
  check_address: tCheckAddress,
  info: tInfo,
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

async function handle(msg) {
  const { id, method, params } = msg
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'flapjax-mcp', version: VERSION },
        instructions: 'Read-only FLAPJAX on-chain reads on BSC (pool, depth, quotes, treasury, address checks). No keys, no writes.',
      },
    })
    return
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return
  if (method === 'ping') { send({ jsonrpc: '2.0', id, result: {} }); return }
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
    return
  }
  if (method === 'tools/call') {
    const name = params?.name
    const args = params?.arguments || {}
    const fn = HANDLERS[name]
    if (!fn) {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true } })
      return
    }
    try {
      const out = await fn(args)
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] } })
    } catch (e) {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `error: ${e.message}` }], isError: true } })
    }
    return
  }
  if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } })
  }
}

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let nl
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    let msg
    try { msg = JSON.parse(line) } catch { console.error('flapjax-mcp: bad json line'); continue }
    handle(msg).catch((e) => {
      if (msg && msg.id !== undefined) {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: e.message } })
      }
      console.error('flapjax-mcp:', e.message)
    })
  }
})
process.stdin.on('end', () => process.exit(0))
console.error(`flapjax-mcp v${VERSION} ready (stdio)`)
