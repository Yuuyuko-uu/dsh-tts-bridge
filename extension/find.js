// DSH 朗读桥 · 找窝（端口探测）
//
// 为什么要这份：原来的端口是**写死**的（3080 / 43129）。
//   可 DSH 支持 `--port`，还能 `--port 0` 让系统随便挑一个 ——
//   别人换个端口，扩展就永远连不上。
//
// 找法（从最靠得住到最兜底）：
//   ① **用户填的**（存着，最优先）
//   ② **上次成功那个**（存着，换端口之前基本不用再找）
//   ③ **浏览器里开着的 DSH 页面** —— 它的地址里就带着端口，
//      而且用户要用朗读桥，DSH 界面必然是开着的 ✓  ← 这条最灵
//   ④ 几个常见的端口（兜底）
//
// ⚠ 这份**不碰 chrome API**（标签页从外面传进来），
//   所以能拿真服务器直接测 —— 光读代码不算数。
;(() => {
  const 路径 = '/dsh-tts-bridge'

  // 兜底名单：DSH 默认的、以前写死的、以及几个常见的开发端口
  // ⚠ 19387 = **旧版**桌面端写死的端口
  //    新版桌面端（2026-10-17 更新后）改成自己挑一个空闲端口（这次是 13633），
  //    而且桌面端不把界面开在浏览器标签里 → ③ 那条路也抠不到端口，
  //    所以光靠这份固定名单会漏 → 下面再加一段"扫一片"兜底 ↓
  const 常见端口 = [19387, 13633, 3080, 43129, 8080, 3000, 5173, 8000, 5000, 9000, 4000, 7000, 8888, 1234]

  // 上面那串都不应声时，再扫这几段 —— 桌面端挑的临时端口落在这儿的概率最大
  // ⚠ 只在上面的名单全军覆没时才扫（平时一次就找到了，别白扫一百多个端口）
  const 扫描段 = [[13600, 13700], [19380, 19400]]

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

  // 问一个端口：是朗读桥的窝吗？
  async function 探(端口) {
    const base = 'http://127.0.0.1:' + 端口 + 路径
    // 扫一片的时候会一次问上百个端口 —— 万一有个端口接了连接却不出声，
    // 不设超时就会把整批拖死，所以每个最多等 1.2 秒
    const 超时 = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(1200) : null
    try {
      const r = await fetch(base + '/state', 超时 ? { cache: 'no-store', signal: 超时 } : { cache: 'no-store' })
      if (!r.ok) return null
      const j = await r.json()
      if (j && j.ok) return base
    } catch (e) {
      // 没人应 / 不是它 / 超时，都算没有
    }
    return null
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
    const 果 = await Promise.all(名单.map((p) => 探(p).then((b) => (b ? { 端口: p, base: b } : null))))
    return 果.filter(Boolean)
  }

  // 问路端口：宿主会在这些**固定**端口上守一个"问路员"
  //   （新版桌面端每次启动都随机换端口，只有这几个门牌是不变的）
  //   扩展敲一下门，门里回答"我现在在哪儿" —— 这就不是猜了 ✓
  const 问路端口 = [19387, 39871, 39872]

  async function 问路(端口) {
    const 超时 = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(800) : null
    try {
      const r = await fetch(
        'http://127.0.0.1:' + 端口 + 路径 + '/where',
        超时 ? { cache: 'no-store', signal: 超时 } : { cache: 'no-store' },
      )
      if (!r.ok) return null
      const j = await r.json()
      if (j && j.ok && typeof j.base === 'string' && j.base) {
        const m = j.base.match(/:(\d+)\//)
        return { 端口: m ? Number(m[1]) : 端口, base: j.base }
      }
    } catch (e) {
      // 没人应 / 不是它 / 超时，都算没有
    }
    return null
  }

  // 找窝：先敲门问，再按老办法补
  // ⚠ 不能只留一个：本机可能同时开着两个 DSH（网页一个、桌面一个），
  //   只认一个的话，另一个窝里点朗读就永远没反应
  async function 找窝(标签们, 记着的) {
    const 果 = []
    const 见过 = new Set()
    const 收 = (w) => {
      if (!w || !w.base || 见过.has(w.base)) return
      见过.add(w.base)
      果.push(w)
    }
    // ① 敲门问 —— 宿主自己报的地址，最靠得住
    for (const w of await Promise.all(问路端口.map(问路))) 收(w)
    // ② 老办法（记住的 / 浏览器标签 / 常见端口）
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

  self.__ttsFind = { 本地端口们, 探, 问路, 候选, 找窝, 探一批, 常见端口, 扫描段, 问路端口, 路径 }
})()
