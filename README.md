# flapjax-mcp

Read-only FLAPJAX on-chain state for agents — a zero-dependency [Model Context Protocol](https://modelcontextprotocol.io) server (stdio).

Six tools over the FLAPJAX/WBNB 1% PancakeSwap V3 pool on BSC, the FlapJax treasury, and any BSC address. No API keys, no transactions, no writes — only `eth_call` / `eth_getBalance` / `eth_blockNumber` against public BSC RPCs (with fallback across four endpoints).

## Install

```bash
git clone https://github.com/kaminariouji/flapjax-mcp
# no dependencies; Node.js >= 18
```

MCP client config (Claude Desktop, Cursor, or any MCP client):

```json
{
  "mcpServers": {
    "flapjax": {
      "command": "node",
      "args": ["/absolute/path/to/flapjax-mcp/index.mjs"]
    }
  }
}
```

## Tools

| Tool | What it returns |
|---|---|
| `pool_state` | sqrtPriceX96, tick, liquidity, mid price both directions — pinned to a block number |
| `depth` | WBNB absorbed for a +N% move / FJ absorbed for a -N% move, in **both fee conventions** (net = curve, gross = trader pays net/0.99) |
| `quote` | Live QuoterV2 quote: `buy` = WBNB→FLAPJAX, `sell` = FLAPJAX→WBNB, human units |
| `treasury` | Treasury + pool balances (BNB, FLAPJAX, WBNB) and the daily buyback context with the skip-rule projection |
| `check_address` | BNB / FLAPJAX / WBNB balances for any address — verify an agent actually got paid |
| `info` | Static reference: addresses, buyback program, known quirks, links |

## Verified sample (block 127,053,470 — 2026-10-11)

`depth` with `percent: 2`:

```json
{
  "up":   { "netWbnbIn": 0.06488399, "grossWbnbIn": 0.06553938, "fjOut": 155378465.32 },
  "down": { "netFjIn": 160111004.59, "wbnbOut": 0.06553614 }
}
```

These reproduce — to the digit — the numbers independently reconciled in the public Q18 review: the +2% gross depth of `0.065539` WBNB, and the two fee conventions (gross = net/0.99).

`quote` with `side: "buy"`, `amount: 0.01`:

```json
{ "amountOut": 23907253.97, "amountOutSide": "FJ", "route": "WBNB -> FLAPJAX (1% pool)" }
```

Matches the clean-table convention quote at the same pinned block (23,907,253.97).

`treasury`:

```json
{
  "balances": { "bnb": 0.15464914, "flapjax": 213830043.84, "wbnb": 0 },
  "buybackContext": { "derivedAvailableBnb": 0.04464914, "wouldBuyNow": true }
}
```

`check_address` on `0x8c062dc5d775b7d5efc168f75a875f392f53dcdf`:

```json
{ "bnb": 5.25e-7, "flapjax": 1750000, "wbnb": 0 }
```

## Notes & caveats

- **Read-only.** Public data, not financial advice. Public RPC endpoints may rate-limit.
- Historical `eth_getLogs` is blocked on most public BSC RPCs; this server deliberately uses only calls that work without an archive key.
- Known quirk (also returned by `info`): Pancake V3 `tickBitmap` is indexed by **compressed tick** (`tick / tickSpacing` = 200 for this pool), not the raw tick.
- Related: the browser probe at <https://kaminariouji.github.io/flapjax-probe/>.

MIT license.
