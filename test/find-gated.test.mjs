// 找窝的接线：真的起两个 HTTP 服务（一个演「DSH NEXT 的闸」，一个演「本机小门」），
// 在 vm 里加载真正的 extension/find.js，只把写死的问路端口映射到临时端口。
// 跑法：node test/find-gated.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { createServer } from 'node:http'
import { createLocalGate, TOKEN_HEADER } from '../lib/local-gate.js'

const P = '/dsh-tts-bridge'
const TOKEN = 'T'.repeat(43)
const SRC = readFileSync(new URL('../extension/find.js', import.meta.url), 'utf8')

// 写死的问路端口：测试里映射到临时端口（这台机器上 19387 可能真被占着）
const 假问路 = 19387
const ports = new Map()
const 取址 = (url, opt) => {
  let u = String(url)
  for (const [假, 真] of ports) u = u.replace('127.0.0.1:' + 假 + '/', '127.0.0.1:' + 真 + '/')
  return fetch(u, opt)
}

function 加载() {
  const ctx = vm.createContext({ self: {}, fetch: 取址, AbortSignal, URL, console })
  vm.runInContext(SRC, ctx, { filename: 'find.js' })
  return ctx.self.__ttsFind
}

function 监听(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler)
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}
const 端口 = (server) => server.address().port

// 演 DSH NEXT：插件路由全被「浏览器访问」闸挡住
function 闸门服务() {
  return 监听((req, res) => {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('Browser access is disabled')
  })
}

// 演插件自己的本机小门
async function 小门服务(token) {
  const gate = createLocalGate({
    prefix: P,
    token,
    allow: [P + '/state', P + '/next'],
    routes: new Map([
      [
        P + '/state',
        (req, res) => {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: true, watching: ['session-1'], waiting: 0 }))
        },
      ],
    ]),
    dshBase: () => 'http://127.0.0.1:1' + P,
  })
  let 自身 = null
  const server = createServer((req, res) => {
    gate.handle(req, res, 端口(自身)).catch(() => {
      res.writeHead(500)
      res.end()
    })
  })
  自身 = server
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return server
}

test('DSH NEXT 的闸把 /state 挡成 403 时：问路拿到本机通道 + 令牌，重试能进', async (t) => {
  const 闸 = await 闸门服务()
  const 小门 = await 小门服务(TOKEN)
  t.after(() => {
    闸.close()
    小门.close()
  })
  ports.set(假问路, 端口(小门))
  const find = 加载()

  // 单点：探一个被闸挡住的端口 —— 403 不该被当成「不是它」
  const 直 = await find.探址('http://127.0.0.1:' + 端口(闸) + P, '')
  assert.equal(直.被拦, true, '403 要先记成「被拦」，不能直接丢掉')

  const w = await find.探(端口(闸))
  assert.ok(w, '被闸挡住的端口，问路之后应该能连上')
  assert.equal(w.base, 'http://127.0.0.1:' + 端口(小门) + P)
  assert.equal(w.token, TOKEN, '重试必须带上问路发的那把令牌')
})

test('找窝：被拦的端口不会让整轮落空，最后收下本机通道', async (t) => {
  const 闸 = await 闸门服务()
  const 小门 = await 小门服务(TOKEN)
  t.after(() => {
    闸.close()
    小门.close()
  })
  ports.set(假问路, 端口(小门))
  const find = 加载()

  // 记着的端口正是那个被拦的（老版本存下来的 DSH 端口）
  const 果 = await find.找窝([], [端口(闸)])
  const 桥 = 果.filter((w) => w.base === 'http://127.0.0.1:' + 端口(小门) + P)
  assert.equal(桥.length, 1, '本机通道要被收下（而且只收一次）')
  assert.equal(桥[0].token, TOKEN)
  assert.equal(桥[0].端口, 端口(小门), '端口要按 base 算，不是按刚才探的那个')
  // 被拦的那个地址不能当成窝交出去（它进不去）
  assert.ok(!果.some((w) => w.base === 'http://127.0.0.1:' + 端口(闸) + P))
})

test('老宿主（问路不给通道和令牌）：照旧用 base，并且不带令牌也能探到', async (t) => {
  const 老 = await 监听((req, res) => {
    if (req.url === P + '/where') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, base: 'http://127.0.0.1:' + 端口(老) + P, pid: 1 }))
      return
    }
    if (req.url === P + '/state') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  t.after(() => 老.close())
  ports.set(假问路, 端口(老))
  const find = 加载()

  const w = await find.问路(假问路)
  assert.equal(w.base, 'http://127.0.0.1:' + 端口(老) + P)
  assert.equal(w.token, '', '老宿主没有令牌，不能凭空造一个')
  assert.equal(w.本机, false)

  const 果 = await find.找窝([], [])
  assert.ok(果.some((x) => x.base === 'http://127.0.0.1:' + 端口(老) + P))
})

test('带令牌的请求确实带上了令牌头（否则小门会 403）', async (t) => {
  let 见到的 = null
  const 小门 = await 监听((req, res) => {
    if (req.url === P + '/state') {
      见到的 = req.headers[TOKEN_HEADER] || ''
      const 对 = 见到的 === TOKEN
      res.writeHead(对 ? 200 : 403, { 'content-type': 'application/json' })
      res.end(JSON.stringify(对 ? { ok: true } : { ok: false }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  t.after(() => 小门.close())
  const find = 加载()
  const w = await find.探址('http://127.0.0.1:' + 端口(小门) + P, TOKEN)
  assert.equal(见到的, TOKEN)
  assert.equal(w.base, 'http://127.0.0.1:' + 端口(小门) + P)
  assert.equal(w.token, TOKEN)
})
