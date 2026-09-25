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
  const 常见端口 = [3080, 43129, 8080, 3000, 5173, 8000, 5000, 9000, 4000, 7000, 8888, 1234]

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
    try {
      const r = await fetch(base + '/state', { cache: 'no-store' })
      if (!r.ok) return null
      const j = await r.json()
      if (j && j.ok) return base
    } catch (e) {
      // 没人应 / 不是它，都算没有
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

  // 全试一遍，把**所有**应声的都留下
  // ⚠ 不能只留一个：本机可能同时开着两个 DSH（网页一个、桌面一个），
  //   只认一个的话，另一个窝里点朗读就永远没反应
  async function 找窝(标签们, 记着的) {
    const 们 = 候选(标签们, 记着的)
    const 果 = await Promise.all(们.map((p) => 探(p).then((b) => (b ? { 端口: p, base: b } : null))))
    return 果.filter(Boolean)
  }

  self.__ttsFind = { 本地端口们, 探, 候选, 找窝, 常见端口, 路径 }
})()
