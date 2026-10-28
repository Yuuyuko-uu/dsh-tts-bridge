// DSH 朗读桥 · 找窝（端口探测）
//
// 为什么要这份：原来的端口是**写死**的（3080 / 43129）。
//   可 DSH 支持 `--port`，还能 `--port 0` 让系统随便挑一个 ——
//   别人换个端口，扩展就永远连不上。
//
// 找法（从最靠得住到最兜底）：
//   ① **问路**：宿主在固定端口上守着一个"问路员"，敲一下它回答"我现在在哪儿"，
//      新版还会顺带给一条**本机通道**和一把**每次启动新发的令牌**（见下）
//   ② **用户填的**（存着，最优先）
//   ③ **上次成功那个**（存着，换端口之前基本不用再找）
//   ④ **浏览器里开着的 DSH 页面** —— 它的地址里就带着端口，
//      而且用户要用朗读桥，DSH 界面必然是开着的 ✓  ← 这条最灵
//   ⑤ 几个常见的端口（兜底）
//
// ⚠ 2026-10-28：DSH NEXT（2.0.19-next 起）给每个插件路由都套了「浏览器访问」闸，
//   扩展这种普通浏览器客户端拿不到 Electron 的令牌 → `/state` 一律 403。
//   所以 **403 不再等于「不是它」**：先把这一下记成「被拦」，
//   再去问路端口要一份「本机通道 + 令牌」，带上令牌重试一次。
//   问路这条链路不在那道闸里，一直是通的。
//
// ⚠ 这份**不碰 chrome API**（标签页从外面传进来），
//   所以能拿真服务器直接测 —— 光读代码不算数。
;(() => {
  const 路径 = '/dsh-tts-bridge'
  const 令牌头 = 'x-dsh-tts-token'

  // 兜底名单：DSH 默认的、以前写死的、以及几个常见的开发端口
  // ⚠ 19387 = **旧版**桌面端写死的端口
  //    新版桌面端（2026-10-17 更新后）改成自己挑一个空闲端口（这次是 13633），
  //    而且桌面端不把界面开在浏览器标签里 → ④ 那条路也抠不到端口，
  //    所以光靠这份固定名单会漏 → 下面再加一段"扫一片"兜底 ↓
  const 常见端口 = [19387, 13633, 3080, 43129, 8080, 3000, 5173, 8000, 5000, 9000, 4000, 7000, 8888, 1234]

  // 上面那串都不应声时，再扫这几段 —— 桌面端挑的临时端口落在这儿的概率最大
  // ⚠ 只在上面的名单全军覆没时才扫（平时一次就找到了，别白扫一百多个端口）
  const 扫描段 = [[13600, 13700], [19380, 19400]]

  // 问路端口：宿主会在这些**固定**端口上守一个"问路员"
  //   （新版桌面端每次启动都随机换端口，只有这几个门牌是不变的）
  const 问路端口 = [19387, 39871, 39872]

  // 从浏览器标签页里把本机端口抠出来
  // 认这几种写法：http://127.0.0.1:3080/…  http://localhost:8080/…（没写端口就是 80）
  function 本地端口们(标签们) {
    const 出 = []
    for (const t of 标签们 || []) {
      const u = String((t && t.url) || '')
      const m = u.match(/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::(\d+))?(\/|$)/i)
      if (!m) continue
      const p = Number(m[1] || 80)
      if (p > 0 && p < 65536 && 出.indexOf(p) < 0) 出.push(p)
    }
    return 出
  }

  // 从地址里取端口
  function 端口自(base) {
    const m = String(base || '').match(/:(\d+)(?:\/|$)/)
    return m ? Number(m[1]) : 0
  }

  // 问一个**具体地址**：是朗读桥吗？
  // 回 { base, token } = 能用；{ 被拦: true, base } = 有人应，但被宿主的闸挡住了；null = 没人应/不是它
  async function 探址(base, 令牌) {
    // 扫一片的时候会一次问上百个端口 —— 万一有个端口接了连接却不出声，
    // 不设超时就会把整批拖死，所以每个最多等 1.2 秒
    const 超时 = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(1200) : null
    const 头 = 令牌 ? { [令牌头]: String(令牌) } : {}
    try {
      const opt = 超时 ? { cache: 'no-store', headers: 头, signal: 超时 } : { cache: 'no-store', headers: 头 }
      const r = await fetch(base + '/state', opt)
      // ⚠ 403 不是「不是它」——DSH NEXT 会把插件路由整片拦掉，得换令牌重试
      if (r.status === 403) return { 被拦: true, base: base }
      if (!r.ok) return null
      const j = await r.json()
      if (j && j.ok) return { base: base, token: 令牌 ? String(令牌) : '' }
    } catch (e) {
      // 没人应 / 不是它 / 超时，都算没有
    }
    return null
  }

  // 问路缓存：一次「找窝」里最多问一遍
  //   （被拦的端口可能有一百个，不能每个都去敲一遍问路端口）
  let 问路结果 = null
  let 问路中 = null
  function 重置问路() {
    问路结果 = null
    问路中 = null
  }

  // 问某个端口：宿主在哪儿？
  async function 问路(端口) {
    const 超时 = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(800) : null
    try {
      const r = await fetch(
        'http://127.0.0.1:' + 端口 + 路径 + '/where',
        超时 ? { cache: 'no-store', signal: 超时 } : { cache: 'no-store' },
      )
      if (!r.ok) return null
      const j = await r.json()
      if (!j || !j.ok) return null
      // 新版宿主：bridge = 只给扩展的本机通道，token = 每次启动新发的令牌
      const 桥 = typeof j.bridge === 'string' && j.bridge ? j.bridge : ''
      const 牌 = typeof j.token === 'string' && j.token ? j.token : ''
      const 用 = 桥 || (typeof j.base === 'string' ? j.base : '')
      if (!用) return null
      return { 端口: 端口自(用) || 端口, base: 用, token: 牌, 本机: !!桥 }
    } catch (e) {
      // 没人应 / 不是它 / 超时，都算没有
    }
    return null
  }

  // 问一遍问路端口，谁先答就用谁
  async function 问一次() {
    if (问路结果) return 问路结果
    if (!问路中) {
      问路中 = (async () => {
        for (const p of 问路端口) {
          const w = await 问路(p)
          if (w) return w
        }
        return null
      })()
    }
    问路结果 = await 问路中
    return 问路结果
  }

  // 问一个端口：是朗读桥的窝吗？
  async function 探(端口) {
    const 直 = await 探址('http://127.0.0.1:' + 端口 + 路径, '')
    if (!直) return null
    if (!直.被拦) return 直
    // 被闸挡了：去问路端口要「本机通道 + 令牌」，再问一次
    const w = await 问一次()
    if (!w) return null
    const 再 = await 探址(w.base, w.token)
    return 再 && !再.被拦 ? 再 : null
  }

  // 按优先级攒出一份要试的端口名单（去重）
  function 候选(标签们, 记着的) {
    const 出 = []
    const 加 = (p) => {
      const n = Number(p)
      if (Number.isInteger(n) && n > 0 && n < 65536 && 出.indexOf(n) < 0) 出.push(n)
    }
    for (const p of 记着的 || []) 加(p)
    for (const p of 本地端口们(标签们)) 加(p)
    for (const p of 常见端口) 加(p)
    return 出
  }

  // 一批端口一起问
  async function 探一批(名单) {
    const 果 = await Promise.all(
      名单.map((p) =>
        探(p).then((b) => (b ? { 端口: 端口自(b.base) || p, base: b.base, token: b.token || '' } : null)),
      ),
    )
    return 果.filter(Boolean)
  }

  // 找窝：先敲门问，再按老办法补
  // ⚠ 不能只留一个：本机可能同时开着两个 DSH（网页一个、桌面一个），
  //   只认一个的话，另一个窝里点朗读就永远没反应
  async function 找窝(标签们, 记着的) {
    重置问路()
    const 果 = []
    const 见过 = new Set()
    const 收 = (w) => {
      if (!w || w.被拦 || !w.base || 见过.has(w.base)) return
      见过.add(w.base)
      果.push({ 端口: Number(w.端口) || 端口自(w.base), base: w.base, token: w.token || '' })
    }
    // ① 敲门问 —— 宿主自己报的地址，最靠得住（新版直接给本机通道 + 令牌）
    for (const w of await Promise.all(问路端口.map(问路))) 收(w)
    // ② 老办法（记住的 / 浏览器标签 / 常见端口）；被闸挡住的会自动去问路再来一次
    const 们 = 候选(标签们, 记着的)
    for (const w of await 探一批(们)) 收(w)
    // ③ 还是一片空 → 最后再扫一段兜底
    if (!果.length) {
      const 段 = []
      for (const 区 of 扫描段) {
        for (let p = 区[0]; p <= 区[1]; p++) if (们.indexOf(p) < 0) 段.push(p)
      }
      for (const w of await 探一批(段)) 收(w)
    }
    return 果
  }

  self.__ttsFind = {
    本地端口们,
    端口自,
    探址,
    探,
    问路,
    问一次,
    重置问路,
    候选,
    找窝,
    探一批,
    常见端口,
    扫描段,
    问路端口,
    令牌头,
    路径,
  }
})()
