// 本机小门的单元测试：只拿假的 req/res，不碰网络。
// 跑法：node test/local-gate.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLocalGate, 允许来源, 同令牌, TOKEN_HEADER } from '../lib/local-gate.js'

const P = '/dsh-tts-bridge'
const TOKEN = 'A'.repeat(43)

function 假res() {
  const 出 = { code: 0, headers: {}, body: '' }
  return {
    writeHead(code, headers) {
      出.code = code
      出.headers = headers || {}
    },
    end(chunk) {
      if (chunk !== undefined) 出.body += String(chunk)
    },
    出,
  }
}

function 造门(over) {
  const 叫过 = []
  const routes = new Map([
    [
      P + '/state',
      (req, res) => {
        叫过.push('/state')
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: true, waiting: 0 }))
      },
    ],
    [
      P + '/favorites',
      (req, res) => {
        叫过.push('/favorites')
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: true, favorites: [] }))
      },
    ],
  ])
  const gate = createLocalGate(
    Object.assign(
      {
        prefix: P,
        token: TOKEN,
        routes,
        allow: [P + '/state', P + '/next'],
        dshBase: () => 'http://127.0.0.1:9110' + P,
      },
      over || {},
    ),
  )
  return { gate, 叫过 }
}

const 请求 = (extra) => Object.assign({ method: 'GET', url: P + '/state', headers: {} }, extra || {})

test('允许来源：扩展可以，网页一律不行', () => {
  assert.equal(允许来源('chrome-extension://abcdefghijklmnop'), 'chrome-extension://abcdefghijklmnop')
  assert.equal(允许来源('http://127.0.0.1:9110'), null)
  assert.equal(允许来源('https://evil.example'), null)
  assert.equal(允许来源('null'), null)
  assert.equal(允许来源(''), '')
  assert.equal(允许来源(undefined), '')
})

test('同令牌：一样才过，长度不同/空/非字符串都不过', () => {
  assert.equal(同令牌(TOKEN, TOKEN), true)
  assert.equal(同令牌('A'.repeat(43), TOKEN), true)
  assert.equal(同令牌('A'.repeat(42), TOKEN), false)
  assert.equal(同令牌('B'.repeat(43), TOKEN), false)
  assert.equal(同令牌('', TOKEN), false)
  assert.equal(同令牌(undefined, TOKEN), false)
  assert.equal(同令牌(TOKEN, ''), false)
})

test('问路：给 base（老扩展用）、bridge（本机通道）、token，但不给网页看', async () => {
  const { gate } = 造门()
  const res = 假res()
  await gate.handle({ method: 'GET', url: P + '/where', headers: {} }, res, 19387)
  assert.equal(res.出.code, 200)
  const j = JSON.parse(res.出.body)
  assert.equal(j.ok, true)
  assert.equal(j.base, 'http://127.0.0.1:9110' + P)
  assert.equal(j.bridge, 'http://127.0.0.1:19387' + P)
  assert.equal(j.token, TOKEN)
  // 没 Origin 的请求不回 access-control-allow-origin
  assert.equal(res.出.headers['access-control-allow-origin'], undefined)
})

test('问路：chrome-extension 来源回显，网页来源 403 且不给跨域头', async () => {
  const { gate } = 造门()
  const 好 = 假res()
  await gate.handle({ method: 'GET', url: P + '/where', headers: { origin: 'chrome-extension://abc' } }, 好, 19387)
  assert.equal(好.出.code, 200)
  assert.equal(好.出.headers['access-control-allow-origin'], 'chrome-extension://abc')

  const 坏 = 假res()
  await gate.handle({ method: 'GET', url: P + '/where', headers: { origin: 'https://evil.example' } }, 坏, 19387)
  assert.equal(坏.出.code, 403)
  assert.equal(坏.出.headers['access-control-allow-origin'], undefined)
  assert.ok(!坏.出.body.includes(TOKEN), '网页连令牌的影子都不该看到')
})

test('不带令牌：403，处理器不执行', async () => {
  const { gate, 叫过 } = 造门()
  const res = 假res()
  await gate.handle(请求(), res, 19387)
  assert.equal(res.出.code, 403)
  assert.deepEqual(叫过, [])
  assert.equal(JSON.parse(res.出.body).ok, false)
})

test('令牌对了：放行到处理器', async () => {
  const { gate, 叫过 } = 造门()
  const res = 假res()
  await gate.handle(请求({ headers: { [TOKEN_HEADER]: TOKEN } }), res, 19387)
  assert.equal(res.出.code, 200)
  assert.deepEqual(叫过, ['/state'])
  assert.deepEqual(JSON.parse(res.出.body), { ok: true, waiting: 0 })
})

test('令牌对了、但来源是网页：照样 403，处理器不执行', async () => {
  const { gate, 叫过 } = 造门()
  for (const origin of ['http://127.0.0.1:9110', 'https://evil.example', 'null']) {
    const res = 假res()
    await gate.handle(请求({ headers: { origin, [TOKEN_HEADER]: TOKEN } }), res, 19387)
    assert.equal(res.出.code, 403, origin)
    assert.equal(res.出.headers['access-control-allow-origin'], undefined, origin)
  }
  assert.deepEqual(叫过, [])
})

test('令牌错了：403，处理器不执行', async () => {
  const { gate, 叫过 } = 造门()
  const res = 假res()
  await gate.handle(请求({ headers: { [TOKEN_HEADER]: 'B'.repeat(43) } }), res, 19387)
  assert.equal(res.出.code, 403)
  assert.deepEqual(叫过, [])
})

test('扩展来源 + 令牌：回显来源、放行', async () => {
  const { gate } = 造门()
  const res = 假res()
  await gate.handle(
    请求({ headers: { origin: 'chrome-extension://abcdefghijklmnop', [TOKEN_HEADER]: TOKEN } }),
    res,
    19387,
  )
  assert.equal(res.出.code, 200)
  assert.equal(res.出.headers['access-control-allow-origin'], 'chrome-extension://abcdefghijklmnop')
  assert.equal(res.出.headers.vary, 'origin')
})

test('OPTIONS 预检：204，允许令牌头', async () => {
  const { gate, 叫过 } = 造门()
  const res = 假res()
  await gate.handle(
    { method: 'OPTIONS', url: P + '/state', headers: { origin: 'chrome-extension://abcdefghijklmnop' } },
    res,
    19387,
  )
  assert.equal(res.出.code, 204)
  assert.ok(String(res.出.headers['access-control-allow-headers']).includes(TOKEN_HEADER))
  assert.deepEqual(叫过, [])
})

test('不在名单里的接口：令牌对了也不给走', async () => {
  const { gate, 叫过 } = 造门()
  const res = 假res()
  await gate.handle(请求({ url: P + '/favorites', headers: { [TOKEN_HEADER]: TOKEN } }), res, 19387)
  assert.equal(res.出.code, 404)
  assert.deepEqual(叫过, [])
})

test('没注册过的路径：令牌对了也 404', async () => {
  const { gate } = 造门({ allow: [P + '/nope'] })
  const res = 假res()
  await gate.handle(请求({ url: P + '/nope', headers: { [TOKEN_HEADER]: TOKEN } }), res, 19387)
  assert.equal(res.出.code, 404)
})
