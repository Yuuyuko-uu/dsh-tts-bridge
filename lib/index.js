// DSH 朗读桥 · 宿主半边
// 盯住你选的会话 → 把「说完一整轮」的话排进队列 → 浏览器扩展取走，交给 DeepSeek 网页端朗读。
// 另外：给 DSH 界面里那两个按钮（▶ 朗读 / ⏸ 停止）提供同源接口。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

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
    const textOfMessage = (sessionId, messageId) => {
      if (!sessionId || !messageId) return ''
      const s = ctx.sessions.get(sessionId)
      if (s === undefined) return ''
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
        const parts = []
        if (Array.isArray(m.content)) {
          for (const b of m.content) {
            if (b && b.type === 'text' && typeof b.text === 'string' && b.text.trim()) parts.push(b.text.trim())
          }
        }
        return parts.join('\n\n')
      }
      return ''
    }

    const remember = (text) => {
      const clean = String(text == null ? '' : text).trim()
      if (!clean) return
      state.recent.unshift({ id: state.recentId++, text: clean, at: Date.now() })
      state.recent = state.recent.slice(0, 30)
    }

    const enqueue = (text, force, messageId) => {
      const clean = String(text == null ? '' : text).trim()
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
    route(P + '/speak', async (req, res) => {
      const body = await readJson(req)
      const text = textOfMessage(String(body.sessionId || ''), String(body.messageId || ''))
      if (!text) {
        reply(res, 200, { ok: false, error: '没找到这条回复的文字' })
        return
      }
      enqueue(text, true, body.messageId)
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
        const text = textOfMessage(String(body.sessionId || ''), messageId)
        // 记下「这句话是谁说的」——用会话自己的标题，通用又准确
        const sid = String(body.sessionId || '')
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

    ctx.effect(() =>
      ctx.webServer.tapIndex((html) => {
        if (html.indexOf('/dsh-tts-bridge/panel.js') >= 0) return html
        const tag = '<script src="/dsh-tts-bridge/panel.js" defer></script>'
        return html.indexOf('</body>') >= 0 ? html.replace('</body>', tag + '</body>') : html + tag
      }),
    )

    say('宿主端就绪：' + P + '/next')
  } catch (error) {
    console.error('[朗读桥] 启动失败（不影响 DSH）：' + (error && error.message))
  }
}
