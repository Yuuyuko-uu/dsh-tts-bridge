// DSH 朗读桥 · 后台
// 四件事：
//   1. 替页面去问本机的 DSH 插件「有没有新的一句」（放后台是为了拿到 host_permissions，不受跨域限制）；
//   2. **自己找到 DSH 在哪个端口**（原来写死 3080/43129，别人换端口就连不上）；
//   3. 万一 DeepSeek 那个页面不在了、而队列里又有话要说，就自己把它叫回来（后台标签，不抢你视线）；
//   4. 本机可能同时开着两个 DSH，所以**所有应声的窝都要问** ——
//      谁手里有活儿就干谁的。只认一个的话，另一个窝里点朗读就永远没反应。
//
// ⚠ 找端口的逻辑在 find.js 里（那份不碰 chrome API，能拿真服务器直接测）

importScripts('find.js')

const DS_URL = 'https://chat.deepseek.com/'
const 找窝 = self.__ttsFind.找窝

// 现在认得的窝：[{ 端口, base }]
let 窝们 = []
let 上次找 = 0
const 找一次管多久 = 15000 // 15 秒内不重复找

// 问某一个窝
async function askBase(base, path, body) {
  const opt = body
    ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    : { method: 'GET', cache: 'no-store' }
  const r = await fetch(base + path, opt)
  if (!r.ok) throw new Error('HTTP ' + r.status)
  const data = await r.json()
  data.base = base
  return data
}

// ---------- 找窝 ----------
async function 刷新窝(强) {
  const 现在 = Date.now()
  if (!强 && 窝们.length && 现在 - 上次找 < 找一次管多久) return 窝们

  // 记着的：用户手工填的优先，然后是上次成功的
  const 记着的 = []
  try {
    const 存 = await chrome.storage.local.get(['ttsPortManual', 'ttsPort'])
    if (存 && 存.ttsPortManual) 记着的.push(存.ttsPortManual)
    if (存 && 存.ttsPort) 记着的.push(存.ttsPort)
  } catch (e) {}

  let 标签们 = []
  try {
    标签们 = await chrome.tabs.query({})
  } catch (e) {}

  let 找到 = []
  try {
    找到 = (await 找窝(标签们, 记着的)) || []
  } catch (e) {
    找到 = []
  }

  上次找 = 现在
  if (找到.length) {
    窝们 = 找到
    // 把这次认下来的端口记着，下次先试它
    try {
      await chrome.storage.local.set({ ttsPort: 找到[0].端口 })
    } catch (e) {}
  } else if (!窝们.length) {
    窝们 = []
  }
  return 窝们
}

// 取件：所有窝都问，谁有活儿就返回谁的
async function pollAll(client) {
  const 名单 = await 刷新窝(false)
  let firstOk = null
  for (const w of 名单) {
    try {
      const data = await askBase(w.base, '/next', { client: client })
      if (data && data.item) return data
      if (firstOk === null) firstOk = data
    } catch (e) {
      /* 这个窝没起来，跳过 */
    }
  }
  return firstOk || { ok: false, error: 名单.length ? '窝没回应' : '找不到朗读桥（DSH 开着吗？）' }
}

// 没有 DeepSeek 页面、又确实有东西要念 —— 就把页面开起来（后台标签）
async function ensureTab() {
  let tabs = []
  try {
    tabs = await chrome.tabs.query({ url: 'https://chat.deepseek.com/*' })
  } catch (e) {
    return
  }
  if (tabs && tabs.length) return
  const 名单 = await 刷新窝(false)
  for (const w of 名单) {
    try {
      const st = await askBase(w.base, '/state')
      if (st && st.ok && st.waiting > 0) {
        await chrome.tabs.create({ url: DS_URL, active: false })
        return
      }
    } catch (e) {
      /* 这个窝没起来 */
    }
  }
}

chrome.runtime.onStartup.addListener(() => {
  刷新窝(true)
  ensureTab()
})
chrome.runtime.onInstalled.addListener(() => {
  刷新窝(true)
  ensureTab()
})
chrome.alarms.create('tts-bridge-ensure', { periodInMinutes: 0.5 })
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'tts-bridge-ensure') {
    刷新窝(false)
    ensureTab()
  }
})

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  ;(async () => {
    try {
      if (msg.type === 'poll') {
        sendResponse({ ok: true, data: await pollAll(msg.client || 'anon') })
      } else if (msg.type === 'ack') {
        const base = msg.payload && msg.payload.base ? msg.payload.base : (窝们[0] && 窝们[0].base) || ''
        sendResponse({ ok: true, data: base ? await askBase(base, '/ack', msg.payload) : { ok: false } })
      } else if (msg.type === 'playing') {
        const base = msg.base || (窝们[0] && 窝们[0].base) || ''
        sendResponse({ ok: true, data: base ? await askBase(base, '/playing', { id: msg.id, on: msg.on }) : { ok: false } })
      } else if (msg.type === 'auto') {
        const base = msg.base || (窝们[0] && 窝们[0].base) || ''
        sendResponse({ ok: true, data: base ? await askBase(base, '/auto', { auto: msg.value }) : { ok: false } })
      } else if (msg.type === 'say') {
        const base = msg.base || (窝们[0] && 窝们[0].base) || ''
        sendResponse({ ok: true, data: base ? await askBase(base, '/say', { text: msg.text }) : { ok: false } })
      } else if (msg.type === 'ports') {
        // 给外面看：现在认得哪些窝
        sendResponse({ ok: true, data: { 窝们: 窝们.map((w) => ({ 端口: w.端口, base: w.base })) } })
      } else if (msg.type === 'setPort') {
        // 用户手工填一个端口
        const p = Number(msg.port)
        if (Number.isInteger(p) && p > 0 && p < 65536) {
          await chrome.storage.local.set({ ttsPortManual: p })
          窝们 = []
          const 名单 = await 刷新窝(true)
          sendResponse({ ok: true, data: { 窝们: 名单.map((w) => w.端口) } })
        } else {
          sendResponse({ ok: false, error: '端口不对' })
        }
      } else if (msg.type === 'audible') {
        let audible = false
        try {
          const id = sender && sender.tab && sender.tab.id
          if (typeof id === 'number') audible = !!(await chrome.tabs.get(id)).audible
        } catch (e) {}
        sendResponse({ ok: true, data: { audible: audible } })
      } else {
        sendResponse({ ok: false, error: '不认识的消息：' + msg.type })
      }
    } catch (e) {
      sendResponse({ ok: false, error: (e && e.message) || String(e) })
    }
  })()
  return true
})
