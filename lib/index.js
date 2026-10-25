// DSH 朗读桥 · 宿主半边
// 盯住你选的会话 → 把「说完一整轮」的话排进队列 → 浏览器扩展取走，交给 DeepSeek 网页端朗读。
// 另外：给 DSH 界面里那两个按钮（▶ 朗读 / ⏸ 停止）提供同源接口。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { createSelfUpdate } from './selfupdate.mjs'

export const name = 'tts-bridge'
export const inject = ['webServer', 'sessions', 'sessionTitle', 'workspaceRegistry', 'timer']

const P = '/dsh-tts-bridge'
// 浏览器扩展那个文件夹在这台电脑上的真实路径（卡片要告诉用户去哪儿找）
let EXT_DIR = ''
try { EXT_DIR = fileURLToPath(new URL('../extension/', import.meta.url)) } catch (error) {}

const HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-private-network': 'true',
  'cache-control': 'no-store',
}

let PANEL_JS = 'console.warn("DSH 朗读桥：读不到 panel.js");'
try {
  PANEL_JS = readFileSync(new URL('./panel.js', import.meta.url), 'utf8')
} catch (error) {
  console.error('[朗读桥] 读 panel.js 失败：' + (error && error.message))
}

// 配置（听哪些会话）和收藏（她标记的「最爱」）都存在一个小 JSON 里，重启也在
const CFG_DIR = process.env.DSH_HOME || join(homedir(), '.dsh')
const CFG_PATH = join(CFG_DIR, 'tts-bridge.json')
// 改名前的旧文件名：新文件读不到就从这儿搬，别丢了她攒的收藏
const CFG_OLD = join(CFG_DIR, 'xiao-beike-tts.json')

const DEFAULT_FOLDER = 'default'
const loadCfg = () => {
  try {
    let raw
    try {
      raw = JSON.parse(readFileSync(CFG_PATH, 'utf8'))
    } catch (e2) {
      raw = JSON.parse(readFileSync(CFG_OLD, 'utf8'))
    }
    const folders = Array.isArray(raw.folders) ? raw.folders.filter((f) => f && f.id) : []
    if (!folders.some((f) => f.id === DEFAULT_FOLDER)) folders.unshift({ id: DEFAULT_FOLDER, name: '收藏' })
    const favorites = (Array.isArray(raw.favorites) ? raw.favorites : []).map((f) =>
      Object.assign({}, f, { folder: f && f.folder ? String(f.folder) : DEFAULT_FOLDER }),
    )
    return {
      watch: Array.isArray(raw.watch) ? raw.watch.map(String) : [],
      folders: folders,
      favorites: favorites,
      everSeen: !!raw.everSeen,
    }
  } catch (error) {
    return { watch: [], folders: [{ id: DEFAULT_FOLDER, name: '收藏' }], favorites: [], everSeen: false }
  }
}
const saveCfg = (cfg) => {
  try {
    mkdirSync(CFG_DIR, { recursive: true })
    writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2), 'utf8')
  } catch (error) {
    console.error('[朗读桥] 存配置失败：' + (error && error.message))
  }
}

export function apply(ctx) {
  try {
    const state = {
      auto: true,
      queue: [],
      nextId: 1,
      recent: [],
      recentId: 1,
      history: [],
      playing: null,
      stopWanted: false, lastNext: 0, lastHello: 0,
    }
    const seen = new Map()
    const cfg = loadCfg()
    const say = (m) => console.log('[朗读桥] ' + m)

    const reply = (res, code, obj) => {
      res.writeHead(code, HEADERS)
      res.end(JSON.stringify(obj))
    }
    const readJson = (req) =>
      new Promise((resolve) => {
        let raw = ''
        req.on('data', (c) => {
          raw += c
          if (raw.length > 100000) req.destroy()
        })
        req.on('end', () => {
          try {
            resolve(JSON.parse(raw || '{}'))
          } catch (error) {
            resolve({})
          }
        })
        req.on('error', () => resolve({}))
      })

    // 三道清理：播放心跳断了、被领走太久没回执、手动复位
    const sweep = () => {
      const now = Date.now()
      if (state.playing && now - state.playing.at > 120000) {
        say('播放心跳断了，当作已停')
        state.playing = null
      }
      const stale = state.queue.filter((i) => i.claimedBy && now - i.claimedAt > 150000)
      if (stale.length) {
        state.queue = state.queue.filter((i) => !(i.claimedBy && now - i.claimedAt > 150000))
        say('领走太久没回执，丢掉 ' + stale.length + ' 条')
      }
    }

    // 被她「归档」的会话：从清单里去掉，也不再听。
    // 归档只是把会话藏起来，并不会把它卸载，所以 list() 里还在 —— 得单独查这个名单。
    const archivedSet = () => {
      try {
        const ids = ctx.workspaceRegistry && ctx.workspaceRegistry.archivedSessionIds
        return new Set((ids || []).map(String))
      } catch (error) {
        return new Set()
      }
    }

    // 盯谁：完全按她勾的那份清单来。一个都没勾就不听任何会话（新用户装完自己选）
    const targets = () => {
      const arch = archivedSet()
      const out = []
      for (const id of cfg.watch) {
        if (arch.has(id)) continue
        const s = ctx.sessions.get(id)
        if (s !== undefined) out.push(s)
      }
      return out
    }

    // 会话自己的标题（DSH 会给每个会话起一个），用来显示「这是谁说的」
    const titleOf = (id) => {
      try {
        const s = ctx.sessions.get(id)
        if (s === undefined) return ''
        const snap = ctx.sessionTitle.get(s)
        return snap && snap.title ? String(snap.title) : ''
      } catch (error) {
        return ''
      }
    }

    // 按消息 id 去会话事件里把那段文字找回来（界面上的按钮用）
    // ⚠⚠⚠ 2026-10-12 修（她报的：重启电脑之后，**哪一条都念不了** ✗）
    //   病根：原来是自己去 snapshotEvents 里扒 `data.message.content` ✗
    //     DSH 一直开着时那份 content 是齐的 ✓ —— 所以哪条都能念 ✓
    //     一重启电脑，会话是从磁盘**恢复**的 →
    //       事件里那条 message 的 content 是空的 ✗（文字其实躺在 data.stream 的 text-chunks 里 ✓）
    //     → 于是"没找到这条回复的文字" ✗ → 点了什么都不做 ✓ 跟她点一万遍没关系 ✓
    //   修法：走 DSH **官方的推导路** `session.deriveMessages()` ✓
    //     （恢复过、fork 过、压缩过的会话，它都能把文字导出来 ✓）
    const 从消息里取字 = (m) => {
      const parts = []
      if (Array.isArray(m && m.content)) {
        for (const b of m.content) {
          if (b && b.type === 'text' && typeof b.text === 'string' && b.text.trim()) parts.push(b.text.trim())
        }
      }
      if (!parts.length && typeof (m && m.text) === 'string' && m.text.trim()) parts.push(m.text.trim())
      return parts.join('\n\n')
    }

    const textOfMessage = (sessionId, messageId) => {
      if (!sessionId || !messageId) return ''
      const s = ctx.sessions.get(sessionId)
      if (s === undefined) return ''
      // ① 官方推导（首选 ✓）
      try {
        if (typeof s.deriveMessages === 'function') {
          const 们 = s.deriveMessages() || []
          for (let i = 们.length - 1; i >= 0; i--) {
            const m = 们[i]
            if (!m || String(m.id) !== String(messageId)) continue
            const 文 = 从消息里取字(m)
            if (文) return 文
          }
        }
      } catch (error) {}
      // ② 退路：老办法（自己扒事件；DSH 没重启过时它是有用的 ✓）
      let events = []
      try {
        events = s.snapshotEvents(0)
      } catch (error) {
        return ''
      }
      for (let i = events.length - 1; i >= 0; i--) {
        const ev = events[i]
        if (ev.type !== 'assistant/message') continue
        const m = ev.data && ev.data.message
        if (!m || String(m.id) !== String(messageId)) continue
        const 文 = 从消息里取字(m)
        if (文) return 文
        // ③ 恢复过的会话：文字在 stream 的 text-chunks 里 ✓
        const 块 = ev.data && ev.data.stream
        if (Array.isArray(块)) {
          const 段 = []
          for (const r of 块) {
            if (r && r.type === 'text-chunks' && Array.isArray(r.texts)) {
              for (const t of r.texts) if (typeof t === 'string' && t.trim()) 段.push(t.trim())
            }
          }
          if (段.length) return 段.join('')
        }
        return ''
      }
      return ''
    }

    // ⚠⚠ 2026-09-29：桌面端那个插槽（conversation.chat.assistant-actions）
    //   **只给 messageId，不给 sessionId** —— 网页端那边两个都给，桌面端只给一个。
    //   → 只拿到 messageId 时，挨个把加载着的会话找一遍，找到哪条就算哪条。
    //     这样老界面、新界面都不用改（多花的只是几次内存里的查找）。
    const locate = (sessionId, messageId) => {
      const 试 = []
      const 加 = (id) => {
        const s = String(id || '')
        if (s && 试.indexOf(s) < 0) 试.push(s)
      }
      加(sessionId)
      try {
        for (const s of ctx.sessions.list()) 加(s.id)
      } catch (error) {}
      for (const id of 试) {
        const text = textOfMessage(id, messageId)
        if (text) return { sessionId: id, text: text }
      }
      return null
    }

    // ⚠⚠⚠ 2026-10-12 她要的：念的时候**跳掉颜文字和怪符号** ✓
    //   她爱让大肥鱼发颜文字，可朗读桥有时不念、有时念出「欧米伽」这种怪音 ✗
    //   （Ω、ω 被当字母念了 ✗；★、(๑•̀ㅂ•́)و✧ 这种也是）
    //   规则：① 括号里没有正常字的（纯颜文字）→ 整块拿掉 ✓
    //        ② emoji、箭头、图形那些 → 去掉 ✓
    //        ③ 连着两个以上「既不是汉字、也不是正常标点」的杂符号 → 去掉 ✓
    //   ⚠ 只在**进朗读队列**的时候切（面板里「最近念过」存的还是原文 ✓ 你还能看见原样）
    const 去颜文字 = (t) => {
      let s = String(t == null ? '' : t)
      s = s.replace(/[（(][^（()）]{0,30}[)）]/g, (m) =>
        /[\u4e00-\u9fa5A-Za-z0-9]/.test(m.replace(/[（()）]/g, '')) ? m : ' ',
      )
      // ② 只留「念得出来的」：汉字、字母、数字、正常标点、空白
      //    其余一律切掉 —— emoji、★♡♪、ωΩ、阿拉伯字母、西里尔字母……
      //    这些不是被跳过就是被念成怪音（「欧米伽」就是它 ✗），干脆一个都不留 ✓
      s = s.replace(/[^\u4e00-\u9fa5\u3000-\u303F\uFF00-\uFFEFA-Za-z0-9\s.,!?;:'"()\[\]…—－-]+/g, ' ')
      // ③ 纯 ASCII 的颜文字（字符白名单拦不住它们 ✗）—— 按常见样式切
      //    >_<  T_T  ><  orz  :(  ……
      //  ⚠ 中间**必须有分隔符**才算颜文字 —— 不然 `to`、`ox` 这种正常词会被吃掉 ✗
      s = s.replace(/[（(]?\s*[>＞<＜^vV][-_^.,;:·]{1,3}[>＜<^vV]\s*[)）]?/g, ' ')
      s = s.replace(/[（(]?\s*[TToO0xX][-_^.,;:·]{1,3}[TToO0xX]\s*[)）]?/g, ' ')
      s = s.replace(/\borz\b/gi, ' ')
      s = s.replace(/[:;=8][-o*']?[)(\[\]dDpP/\\|{}]/g, ' ')
      s = s.replace(/[（(]\s*[)）]/g, ' ')
      // ⚠⚠⚠ 2026-10-12 修我自己的大错 ✗：
      //   我加规则③的时候，把这下面的 `return s` **吃掉**了 ✗
      //   → 这个函数就变成"返回空" ✓ → enqueue 里 `if (!clean) return false` ✓
      //   → **一条都排不进队列** ✗ → 她点一万遍都一点动静没有 ✓
      //   （时间线也正好对上：她一重启 DSH，这段坏代码就生效了 ✗）
      s = s
        .replace(/ ([，。！？、；：）】》])/g, '$1')
        .replace(/([（【《]) /g, '$1')
        .trim()
      return s
    }

    const remember = (text) => {
      const clean = String(text == null ? '' : text).trim()
      if (!clean) return
      state.recent.unshift({ id: state.recentId++, text: clean, at: Date.now() })
      state.recent = state.recent.slice(0, 30)
    }

    const enqueue = (text, force, messageId) => {
      // ⚠⚠ 2026-10-12：这里过一道「去颜文字」（念的时候跳过 ✗→✓）
      const clean = 去颜文字(text)
      if (!clean) return false
      if (state.queue.length >= 6) state.queue.shift()
      state.queue.push({
        id: state.nextId++,
        text: clean,
        force: !!force,
        messageId: messageId ? String(messageId) : null,
        at: Date.now(),
        claimedBy: null,
        claimedAt: 0,
      })
      say('排队 ' + state.queue.length + ' 条：' + clean.slice(0, 40).replace(/\s+/g, ' '))
      return true
    }

    // 只认「一整轮说完」的助手文字；工具调用、思考框不念
    const absorb = (events) => {
      const turnText = new Map()
      for (const ev of events) {
        if (ev.type === 'assistant/message') {
          const d = ev.data || {}
          const arr = turnText.get(d.turn) || []
          const blocks = d.message && d.message.content
          if (Array.isArray(blocks)) {
            for (const b of blocks) {
              if (b && b.type === 'text' && typeof b.text === 'string' && b.text.trim()) arr.push(b.text.trim())
            }
          }
          turnText.set(d.turn, arr)
        } else if (ev.type === 'turn/end') {
          const d = ev.data || {}
          const arr = turnText.get(d.turn)
          turnText.delete(d.turn)
          const kind = d.reason && d.reason.kind
          if (kind === 'completed' && arr && arr.length) {
            const text = arr.join('\n\n')
            remember(text)
            if (state.auto) enqueue(text, false, null)
          }
        }
      }
    }

    const scan = () => {
      for (const s of targets()) {
        const id = String(s.id)
        const seq = Number(s.seq)
        if (!seen.has(id)) {
          seen.set(id, seq)
          say('开始盯着 ' + id + '（seq=' + seq + '）')
          continue
        }
        const prev = seen.get(id)
        if (seq <= prev) continue
        let events = []
        try {
          events = s.snapshotEvents(prev)
        } catch (error) {
          say('读 ' + id + ' 出错：' + (error && error.message))
          continue
        }
        seen.set(id, seq)
        absorb(events)
      }
    }
    ctx.effect(() => ctx.interval(scan, 1500))

    // ⭐ 设置页那个「检查更新」：查这个插件自己的仓库（地址从 package.json 读）
    const 自查更新 = createSelfUpdate({
      packageRoot: fileURLToPath(new URL('..', import.meta.url)),
      diag: (m) => say('查更新：' + m),
    })

    const route = (path, handler) =>
      ctx.effect(() =>
        ctx.webServer.register({
          kind: 'exact',
          path: path,
          handler: async (req, res) => {
            if (req.method === 'OPTIONS') {
              res.writeHead(204, HEADERS)
              res.end()
              return
            }
            try {
              await handler(req, res)
            } catch (error) {
              say('路由 ' + path + ' 出错：' + (error && error.message))

              try {
                reply(res, 500, { ok: false, error: String(error && error.message) })
              } catch (e2) {}
            }
          },
        }),
      )

    // 界面按钮：念这一条
    // ⭐ 设置页的「检查更新」：查这个插件自己的仓库（地址从 package.json 读）
    route(P + '/update', async (req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1')
      const r = await 自查更新.check(u.searchParams.get('refresh') === '1')
      reply(res, 200, { ok: true, ...r })
    })

    route(P + '/speak', async (req, res) => {
      const body = await readJson(req)
      const 找 = locate(String(body.sessionId || ''), String(body.messageId || ''))
      // ⚠⚠ 2026-10-12 加的"眼睛"（她说怎么改都没用 → 不猜了，让它自己交代）：
      //   她点一下，这里就把「收到了什么 / 找到没有 / 它自己推导出几条消息、尾巴几个 id」
      //   写进一个文件 ✓ 我直接读那个文件，一眼看清卡在哪儿 ✓
      try {
        const 会话们 = ctx.sessions.list()
        const 单 = {
          at: Date.now(),
          收到: {
            sessionId: String(body.sessionId || ''),
            messageId: String(body.messageId || ''),
            她发来的字段: Object.keys(body || {}),
          },
          找到: !!找,
          会话数: 会话们.length,
          各会话: 会话们.slice(0, 8).map((s) => {
            let 数 = -1
            let 尾 = []
            try {
              const 们 = (typeof s.deriveMessages === 'function' ? s.deriveMessages() : []) || []
              数 = 们.length
              尾 = 们.slice(-3).map((m) => String((m && m.id) || ''))
            } catch (error) {
              尾 = ['取不到：' + ((error && error.message) || '')]
            }
            return { id: String(s.id), 消息数: 数, 尾巴: 尾 }
          }),
        }
        writeFileSync(join(CFG_DIR, 'tts-bridge-diag.json'), JSON.stringify(单, null, 2))
      } catch (error) {}
      if (!找) {
        reply(res, 200, { ok: false, error: '没找到这条回复的文字' })
        return
      }
      enqueue(找.text, true, body.messageId)
      const 尾 = state.queue[state.queue.length - 1]
      if (尾 && String(尾.messageId) === String(body.messageId)) 尾.sessionId = 找.sessionId
      reply(res, 200, { ok: true, waiting: state.queue.length })
    })

    // 界面按钮：停止（队列一起清掉，免得后面还排着）
    route(P + '/stop', async (req, res) => {
      state.stopWanted = true
      state.playing = null
      state.queue = []
      reply(res, 200, { ok: true })
    })

    // 界面按钮：现在有没有在出声
    route(P + '/status', (req, res) => {
      sweep()
      reply(res, 200, {
        ok: true,
        auto: state.auto,
        playing: state.playing !== null,
        waiting: state.queue.length,
      })
    })

    // 浏览器扩展：取件
    // 扩展后台来打个招呼：「我还在」（不管 DeepSeek 页面开没开）
    // 有了它，卡片就能分清「没装扩展」和「装了但页面没开」
    route(P + '/hello', (req, res) => {
      state.lastHello = Date.now()
      if (!cfg.everSeen) {
        cfg.everSeen = true
        saveCfg(cfg)
      }
      reply(res, 200, { ok: true })
    })

    route(P + '/next', async (req, res) => {
      state.lastNext = Date.now()
      if (!cfg.everSeen) {
        cfg.everSeen = true
        saveCfg(cfg)
      }
      sweep()
      const body = req.method === 'POST' ? await readJson(req) : {}
      const client = String(body.client || 'anon').slice(0, 40)
      const watching = targets().map((s) => String(s.id))
      const base = {
        ok: true,
        auto: state.auto,
        watching: watching,
        waiting: state.queue.length,
        lastError: state.history.length ? state.history[0].error : null,
      }
      if (state.stopWanted) {
        state.stopWanted = false
        base.item = { id: 0, stop: true }
        reply(res, 200, base)
        return
      }
      const head = state.queue[0]
      let item = null
      if (head && (state.auto || head.force)) {
        if (!head.claimedBy || head.claimedBy === client || Date.now() - head.claimedAt > 30000) {
          head.claimedBy = client
          head.claimedAt = Date.now()
          item = { id: head.id, text: head.text }
        }
      }
      base.item = item
      reply(res, 200, base)
    })

    route(P + '/ack', async (req, res) => {
      const body = await readJson(req)
      const id = Number(body.id)
      const item = state.queue.filter((i) => i.id === id)[0]
      state.queue = state.queue.filter((i) => i.id !== id)
      if (state.playing && state.playing.itemId === id && body.ok === false) state.playing = null
      state.history.unshift({
        id: id,
        ok: body.ok !== false,
        error: body.error ? String(body.error).slice(0, 200) : null,
        detail: body.detail ? String(body.detail).slice(0, 700) : null,
        text: item ? item.text.slice(0, 80) : null,
        at: Date.now(),
      })
      state.history = state.history.slice(0, 20)
      reply(res, 200, { ok: true })
    })

    // 扩展报告：真的在出声了 / 出完了（on:true 是心跳，on:false 无论哪条都直接清掉）
    route(P + '/playing', async (req, res) => {
      const body = await readJson(req)
      const id = Number(body.id) || 0
      if (body.on) {
        const item = state.queue.filter((i) => i.id === id)[0]
        // ⭐ 1.3.0：还在念就顺手续一下「认领时间」——
        //   长段落要念好几分钟，光靠每秒轮询续期，后台标签一被节流就可能被判「领走太久」丢掉
        if (item) item.claimedAt = Date.now()
        const msgId =
          item && item.messageId ? item.messageId : state.playing && state.playing.itemId === id ? state.playing.messageId : null
        state.playing = { itemId: id, messageId: msgId, at: Date.now() }
      } else {
        state.playing = null
      }
      reply(res, 200, { ok: true, playing: state.playing !== null })
    })

    route(P + '/auto', async (req, res) => {
      const body = await readJson(req)
      state.auto = body.auto !== false
      if (!state.auto) state.queue = []
      say('自动朗读 = ' + (state.auto ? '开' : '关'))
      reply(res, 200, { ok: true, auto: state.auto })
    })

    route(P + '/say', async (req, res) => {
      const body = await readJson(req)
      enqueue(body.text, true, null)
      reply(res, 200, { ok: true, waiting: state.queue.length })
    })

    route(P + '/reset', async (req, res) => {
      state.playing = null
      state.queue = []
      state.stopWanted = true
      reply(res, 200, { ok: true, auto: state.auto })
    })

    route(P + '/recent', (req, res) => {
      reply(res, 200, { ok: true, recent: state.recent.map((r) => ({ id: r.id, text: r.text, at: r.at })) })
    })

    route(P + '/state', (req, res) => {
      sweep()
      reply(res, 200, {
        ok: true,
        auto: state.auto,
        watching: targets().map((s) => String(s.id)),
        waiting: state.queue.length,
        playing: state.playing !== null,
        next: state.queue.length ? state.queue[0].text.slice(0, 80) : null,
        remembered: state.recent.length,
        watch: cfg.watch,
        lastNext: state.lastNext,
        lastHello: state.lastHello,
        everSeen: !!cfg.everSeen,
        extDir: EXT_DIR,
        live: ctx.sessions.list().map((s) => String(s.id)),
        favorites: cfg.favorites.length,
        // ⚠ 自己给自己留的体检口：把「首页注入」这张表读出来看一眼。
        //   桌面端卡片出不来的时候，先看这里有没有 script-src:/dsh-tts-bridge/panel.js
        injectRows: (() => {
          const 表 = []
          try {
            ctx.emit('webserver/index-inject', 表)
          } catch (error) {}
          return 表.map((r) => (r && r.kind ? r.kind + ':' + String(r.src || r.name || '') : '?'))
        })(),
        history: state.history.slice(0, 8),
      })
    })

    // ---- 配置（听哪些会话）与收藏（最爱） ----

    // 可选的会话。只列「活着的」—— 插件只能读被载入的会话，关着的它看不见。
    route(P + '/sessions', (req, res) => {
      const list = []
      const watching = cfg.watch
      const arch = archivedSet()
      const ids = new Set()
      for (const s of ctx.sessions.list()) ids.add(String(s.id))
      for (const id of watching) ids.add(id)
      // 不过滤了：之前那个 parentSession 判断会把会话筛掉，而且她想在清单里看到自己这边
      for (const id of ids) {
        if (arch.has(id)) continue
        const s = ctx.sessions.get(id)
        if (s === undefined) continue
        let title = ''
        try {
          const snap = ctx.sessionTitle.get(s)
          if (snap && snap.title) title = String(snap.title)
        } catch (error) {}
        // 还没起名字的会话（刚点开、还没说话）不列出来 —— 里面也没有东西可念。
        // 说上一句话它就有了标题，自然会出现。
        if (!title) continue
        list.push({
          id: id,
          title: title,
          watching: watching.indexOf(id) >= 0,
        })
      }
      list.sort((a, b) => String(a.title).localeCompare(String(b.title), 'zh'))
      reply(res, 200, { ok: true, sessions: list, watch: watching, live: Array.from(ids) })
    })

    // 加一个 / 去掉一个 要听的会话
    route(P + '/watch', async (req, res) => {
      const body = await readJson(req)
      const id = String(body.id || '')
      if (!id) {
        reply(res, 200, { ok: false, error: '没给会话 id' })
        return
      }
      const set = new Set(cfg.watch)
      if (body.remove) set.delete(id)
      else set.add(id)
      cfg.watch = Array.from(set)
      saveCfg(cfg)
      say('听这些会话：' + (cfg.watch.length ? cfg.watch.join(' , ') : '（一个都没选）'))
      reply(res, 200, { ok: true, watch: cfg.watch })
    })

    // 收藏 / 取消收藏某一条
    route(P + '/favorite', async (req, res) => {
      const body = await readJson(req)
      const messageId = String(body.messageId || '')
      if (!messageId) {
        reply(res, 200, { ok: false, error: '没给消息 id' })
        return
      }
      const at = cfg.favorites.findIndex((f) => String(f.messageId) === messageId)
      let on
      if (at >= 0) {
        cfg.favorites.splice(at, 1)
        on = false
      } else {
        // ⚠ 桌面端那个插槽不给 sessionId → 靠 locate 自己找出来（收藏那栏要写清是谁说的）
        const 找 = locate(String(body.sessionId || ''), messageId)
        const text = 找 ? 找.text : ''
        // 记下「这句话是谁说的」——用会话自己的标题，通用又准确
        const sid = 找 ? 找.sessionId : String(body.sessionId || '')
        const who = titleOf(sid)
        cfg.favorites.unshift({
          messageId: messageId,
          sessionId: sid,
          text: text,
          who: who,
          folder: String(body.folder || DEFAULT_FOLDER),
          at: Date.now(),
        })
        cfg.favorites = cfg.favorites.slice(0, 200)
        on = true
      }
      saveCfg(cfg)
      reply(res, 200, { ok: true, on: on, count: cfg.favorites.length })
    })

    route(P + '/favorites', (req, res) => {
      reply(res, 200, {
        ok: true,
        folders: cfg.folders.map((f) => ({
          id: String(f.id),
          name: String(f.name || f.id),
          count: cfg.favorites.filter((x) => String(x.folder) === String(f.id)).length,
        })),
        favorites: cfg.favorites.map((f) => ({
          messageId: f.messageId,
          text: String(f.text || '').slice(0, 400),
          who: String(f.who || ''),
          folder: String(f.folder || DEFAULT_FOLDER),
          at: f.at,
        })),
      })
    })

    // 建 / 改名 / 删分区。删分区只是把里面的收藏挪回默认，不删句子。
    route(P + '/folder', async (req, res) => {
      const body = await readJson(req)
      if (body.remove) {
        const id = String(body.remove)
        if (id === DEFAULT_FOLDER) {
          reply(res, 200, { ok: false, error: '默认分区不能删' })
          return
        }
        cfg.folders = cfg.folders.filter((f) => String(f.id) !== id)
        cfg.favorites = cfg.favorites.map((f) =>
          String(f.folder) === id ? Object.assign({}, f, { folder: DEFAULT_FOLDER }) : f,
        )
        saveCfg(cfg)
        reply(res, 200, { ok: true, folders: cfg.folders })
        return
      }
      const name = String(body.name || '').trim()
      if (!name) {
        reply(res, 200, { ok: false, error: '分区名不能空' })
        return
      }
      if (body.id) {
        const id = String(body.id)
        cfg.folders = cfg.folders.map((f) => (String(f.id) === id ? Object.assign({}, f, { name: name }) : f))
        saveCfg(cfg)
        reply(res, 200, { ok: true, folders: cfg.folders })
        return
      }
      const id = 'f' + Date.now().toString(36)
      cfg.folders.push({ id: id, name: name })
      saveCfg(cfg)
      reply(res, 200, { ok: true, id: id, folders: cfg.folders })
    })

    // 把一条收藏移到别的分区
    route(P + '/move', async (req, res) => {
      const body = await readJson(req)
      const messageId = String(body.messageId || '')
      const folder = String(body.folder || DEFAULT_FOLDER)
      cfg.favorites = cfg.favorites.map((f) =>
        String(f.messageId) === messageId ? Object.assign({}, f, { folder: folder }) : f,
      )
      saveCfg(cfg)
      reply(res, 200, { ok: true })
    })

    route(P + '/forget', async (req, res) => {
      const body = await readJson(req)
      const messageId = String(body.messageId || '')
      cfg.favorites = cfg.favorites.filter((f) => String(f.messageId) !== messageId)
      saveCfg(cfg)
      reply(res, 200, { ok: true, count: cfg.favorites.length })
    })

    // DSH 界面右下角那张小卡片：脚本注进每个 DSH 窗口
    // 每次现读磁盘 —— 这样改卡片只要刷新页面，不用重启 DSH
    route(P + '/panel.js', (req, res) => {
      let text = PANEL_JS
      try {
        text = readFileSync(new URL('./panel.js', import.meta.url), 'utf8')
      } catch (error) {}
      res.writeHead(200, {
        'content-type': 'application/javascript; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.end(text)
    })

    // DSH 界面右下角那张小卡片：**两条路都注册一遍**。
    //  ⚠⚠ 2026-09-29（官方桌面端 DSH Desktop 报的「没有小窗口」）：
    //    桌面壳子把首页当**静态文件**直接发给窗口（dsh-app://app），
    //    **不走服务器的 renderIndex** —— 所以下面那段 tapIndex 在桌面端**一次都不会跑**，
    //    卡片就永远不出现。
    //    桌面壳子认的是**结构化注入表**：它先 collectIndexInjections()，再把每一行交给前端，
    //    前端按 kind 处理（script-src = 真去 createElement('script') 加载）✓
    //    → 老的（网页那套）走 tapIndex，新的（桌面端）走这一行；
    //      卡片文件自己有 window.__ttsBridgePanelLoaded 那道闸，两条都跑到也不会出两张。
    ctx.effect(() =>
      ctx.on('webserver/index-inject', (table) => {
        if (!Array.isArray(table)) return
        const 已有 = table.some(
          (r) => r && r.kind === 'script-src' && String(r.src || '').indexOf(P + '/panel.js') === 0,
        )
        if (!已有) table.push({ kind: 'script-src', placement: 'body', src: P + '/panel.js' })
      }),
    )

    ctx.effect(() =>
      ctx.webServer.tapIndex((html) => {
        if (html.indexOf('/dsh-tts-bridge/panel.js') >= 0) return html
        const tag = '<script src="/dsh-tts-bridge/panel.js" defer></script>'
        return html.indexOf('</body>') >= 0 ? html.replace('</body>', tag + '</body>') : html + tag
      }),
    )

    // ---------- 问路端口（固定门牌） ----------
    // ⚠⚠ 2026-10-17（官方桌面端更新后）：
    //   老版桌面壳启动宿主时**写死** `--port 19387`；
    //   新版改成 `--port 0`（让系统随便挑一个空闲端口）→ 每次启动地址都不一样
    //   （19387 → 13633 → 5646 —— 已实测三次都不同）✗
    //   扩展那边"猜几个常见端口"就永远追不上 ✗
    //   → 在**固定端口**上守一个"问路员"：扩展敲这个门，它回答"我现在在哪儿" ✓
    //   这不是猜，是问。
    const 问路端口 = [19387, 39871, 39872]
    const 问路应答 = (req, res) => {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, HEADERS)
        res.end()
        return
      }
      let base = ''
      try {
        base = ctx.webServer.getOrigin() + P
      } catch (error) {}
      reply(res, 200, { ok: true, base: base, pid: process.pid })
    }
    ctx.effect(() => {
      const 开着的 = []
      let 收摊 = false
      const 守一个 = (端口) =>
        new Promise((resolve) => {
          const 服务器 = createServer((req, res) => {
            const 路 = String((req.url || '').split('?')[0])
            if (路 === P + '/where') return 问路应答(req, res)
            res.writeHead(404, HEADERS)
            res.end(JSON.stringify({ ok: false, error: '这里只回答 ' + P + '/where' }))
          })
          服务器.once('error', () => resolve(null))
          服务器.listen(端口, '127.0.0.1', () => {
            开着的.push(服务器)
            resolve(服务器)
          })
        })
      ;(async () => {
        for (const 端口 of 问路端口) {
          if (收摊) return
          const 成 = await 守一个(端口)
          if (成) {
            say('问路端口已就位：127.0.0.1:' + 端口)
            return
          }
        }
        say('问路端口一个都没占上（19387/39871/39872 都被占了）')
      })()
      return () => {
        收摊 = true
        for (const 服务器 of 开着的) {
          try {
            服务器.close()
          } catch (error) {}
        }
      }
    })

    say('宿主端就绪：' + P + '/next')
  } catch (error) {
    console.error('[朗读桥] 启动失败（不影响 DSH）：' + (error && error.message))
  }
}
