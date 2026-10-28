// DSH 朗读桥 · 本机小门（只给浏览器扩展走的那条通道）
//
// 为什么要有这道门：
//   DSH NEXT（2.0.19-next 起）的桌面宿主给**每一个**插件注册的 HTTP 路由都套了一层
//   「浏览器访问」闸（`dsh-desktop-next/src/webserver.ts`）：请求里没有 Electron 渲染进程
//   那个 `x-dsh-desktop-renderer` 令牌、设置里又没开「允许浏览器访问」时，
//   一律 `403 Browser access is disabled`。
//   浏览器扩展是普通浏览器客户端，永远拿不到那个令牌 → `/state`、`/next` 全被拦。
//   可插件自己 listen 的端口不归那道闸管（`/where` 一直是通的）。
//   → 就在这个端口上再开一份只给扩展用的小门：
//     · 只 listen 127.0.0.1（由调用方保证）；
//     · 只认 `chrome-extension://` 来源，网页（http/https/null）连读都读不到；
//     · 除了 `/where`，都要带每次启动新发的令牌（令牌只在内存里，不写日志、不落盘）；
//     · 只放行扩展真正会用的那几条接口。
import { timingSafeEqual } from 'node:crypto'

export const TOKEN_HEADER = 'x-dsh-tts-token'

const 网页来源 = /^https?:\/\//i
const 扩展来源 = /^chrome-extension:\/\//i

/**
 * 这个请求的来源能不能上小门。
 * @returns {string} 可以，值是回给它的 `access-control-allow-origin`（'' = 不是浏览器跨域请求）
 * @returns {null} 不许（网页、`null` 来源、其它协议）
 */
export function 允许来源(origin) {
  const o = String(origin == null ? '' : origin).trim()
  if (!o) return ''
  if (扩展来源.test(o)) return o
  // 网页能拿到这个口的话，本地会话内容就谁都能读了 —— 一律不认。
  if (网页来源.test(o) || o === 'null') return null
  return null
}

/** 定长比较，别让令牌能被逐位试出来。 */
export function 同令牌(收到, 应有) {
  if (typeof 收到 !== 'string' || typeof 应有 !== 'string') return false
  if (!收到 || !应有 || 收到.length !== 应有.length) return false
  try {
    return timingSafeEqual(Buffer.from(收到), Buffer.from(应有))
  } catch (error) {
    return false
  }
}

/**
 * 造一个处理函数：`(req, res, 端口) => Promise<void>`。
 *
 * @param {object} options
 * @param {string} options.prefix 路径前缀（`/dsh-tts-bridge`）
 * @param {string} options.token 本次启动的令牌
 * @param {Map<string, Function>} options.routes 已经注册好的路由表
 * @param {Iterable<string>} options.allow 能从这里走的路径（其余一律 404）
 * @param {() => string} [options.dshBase] DSH 自己那个地址（给老扩展留的 `base`）
 */
export function createLocalGate(options) {
  const opts = options || {}
  const prefix = String(opts.prefix || '/dsh-tts-bridge')
  const token = String(opts.token || '')
  const routes = opts.routes
  const 放行 = opts.allow instanceof Set ? opts.allow : new Set(opts.allow || [])
  const dshBase = typeof opts.dshBase === 'function' ? opts.dshBase : () => String(opts.dshBase || '')

  const 写 = (res, code, obj, extra) => {
    res.writeHead(
      code,
      Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, extra || null),
    )
    res.end(JSON.stringify(obj))
  }

  async function handle(req, res, 端口) {
    const 路 = String((req.url || '').split('?')[0])
    const 来源 = 允许来源(req.headers && req.headers.origin)
    if (来源 === null) {
      // 这里故意不给 access-control-allow-origin：网页连这个 403 都读不到。
      写(res, 403, { ok: false, error: '这个口只给浏览器扩展用' })
      return
    }
    const 跨 = {
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type, ' + TOKEN_HEADER,
      'cache-control': 'no-store',
    }
    if (来源) {
      跨['access-control-allow-origin'] = 来源
      跨['vary'] = 'origin'
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, 跨)
      res.end()
      return
    }

    // 问路：这条是引导，不能要令牌（扩展还没令牌）。但它只回给本机 + 扩展来源。
    if (路 === prefix + '/where') {
      let base = ''
      try {
        base = String(dshBase() || '')
      } catch (error) {
        base = ''
      }
      写(
        res,
        200,
        {
          ok: true,
          // base 保持原样：老扩展（1.3.0 及以前）只认这个字段，老宿主上它仍然跑得通。
          base: base,
          // bridge = 只给扩展的本机通道；token = 每次启动新发的令牌。
          bridge: 'http://127.0.0.1:' + Number(端口 || 0) + prefix,
          token: token,
          pid: process.pid,
        },
        跨,
      )
      return
    }

    if (!同令牌(req.headers && req.headers[TOKEN_HEADER], token)) {
      写(res, 403, { ok: false, error: '令牌不对' }, 跨)
      return
    }
    if (!放行.has(路)) {
      写(res, 404, { ok: false, error: '没有这条' }, 跨)
      return
    }
    const 处理 = routes && typeof routes.get === 'function' ? routes.get(路) : null
    if (typeof 处理 !== 'function') {
      写(res, 404, { ok: false, error: '没有这条' }, 跨)
      return
    }
    // 处理器只管写自己的内容（它不知道这次是从哪来的），跨域头在这儿补上
    const 原写头 = typeof res.writeHead === 'function' ? res.writeHead.bind(res) : null
    if (原写头) {
      res.writeHead = (code, headers) => 原写头(code, Object.assign({}, headers || null, 跨))
    }
    await 处理(req, res)
  }

  return { handle }
}
