// test-client.mjs — mini MCP stdio client untuk menguji flapjax-mcp (local only, tidak ikut di-push)
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const server = spawn(process.execPath, [fileURLToPath(new URL('./index.mjs', import.meta.url))], { stdio: ['pipe', 'pipe', 'inherit'] })

let id = 0
const pending = new Map()
let buf = ''
server.stdout.on('data', (c) => {
  buf += c
  let nl
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    const msg = JSON.parse(line)
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  }
})

function call(method, params) {
  return new Promise((resolve) => {
    const mid = ++id
    pending.set(mid, resolve)
    server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params }) + '\n')
  })
}

const init = await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } })
console.log('initialize:', JSON.stringify(init.result.serverInfo), init.result.protocolVersion)
server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')

const list = await call('tools/list', {})
console.log('tools:', list.result.tools.map((t) => t.name).join(', '))

for (const [name, args] of [
  ['info', {}],
  ['pool_state', {}],
  ['depth', { percent: 2 }],
  ['quote', { side: 'buy', amount: 0.01 }],
  ['treasury', {}],
  ['check_address', { address: '0x8c062dc5d775b7d5efc168f75a875f392f53dcdf' }],
]) {
  const res = await call('tools/call', { name, arguments: args })
  const text = res.result.content[0].text
  console.log(`\n=== ${name} ${JSON.stringify(args)} ===`)
  console.log(text.slice(0, 900))
  if (res.result.isError) console.log('!! ISERROR')
}

server.kill()
process.exit(0)
