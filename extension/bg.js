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

// 现在认得的窝：[{ 端口, base, token }]
//   token：DSH NEXT 会把插件路由拦住，扩展要拿问路端口发的那把令牌才进得去（老宿主没有，空着）
let 窝们 = []
let 上次找 = 0
let 要重找 = false // 有窝回 403（被宿主拦了）→ 下一轮强制重找
const 找一次管多久 = 15000 // 15 秒内不重复找

// 问某一个窝
async function askBase(w, path, body) {
  const base = w && w.base ? w.base : ''
  const 头 = {}
  if (w && w.token) 头[self.__ttsFind.令牌头] = String(w.token)
  let opt
  if (body) {
    opt = { method: 'POST', headers: Object.assign({}, 头, { 'content-type': 'application/json' }), body: JSON.stringify(body) }
  } else {
    opt = { method: 'GET', cache: 'no-store', headers: 头 }
  }
  const r = await fetch(base + path, opt)
  // 被宿主的「浏览器访问」闸挡住了：这个窝现在还进不去，标一下，等下强找一次
  if (r.status === 403) {
    要重找 = true
    throw new Error('这个窝被宿主拦住了（403）')
  }
  if (!r.ok) throw new Error('HTTP ' + r.status)
  const data = await r.json()
  data.base = base
  return data
}

// 按地址找窝（回执 / 心跳要写回它自己那个窝）
function 窝靠基(base) {
  const b = String(base || '')
  if (b) {
    const 中 = 窝们.filter((w) => w.base === b)[0]
    if (中) return 中
  }
  return 窝们[0] || null
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
    要重找 = false
    // 跟每个窝打个招呼：卡片靠这个分清「没装扩展」和「装了但 DeepSeek 页面没开」
    // （以前只有 /next 会点亮 everSeen —— 页面一关，卡片就又写「装扩展」了）
    for (const w of 找到) askBase(w, '/hello').catch(() => {})
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
async function 挨个问(名单, client) {
  let firstOk = null
  for (const w of 名单) {
    try {
      const data = await askBase(w, '/next', { client: client })
      if (data && data.item) return data
      if (firstOk === null) firstOk = data
    } catch (e) {
      /* 这个窝没起来，跳过 */
    }
  }
  return firstOk
}

async function pollAll(client) {
  let 名单 = await 刷新窝(false)
  let 果 = await 挨个问(名单, client)
  // 有窝 403（被宿主的闸拦了，例如 DSH NEXT 刚启动、令牌还是旧的）
  // → 强制重找一次（问路会发新令牌 / 新通道），再试一遍
  // ⚠ 别把「重找」做成死循环：页面 1.2 秒轮询一次，同一波 403 最多 5 秒重找一遍
  if (要重找) {
    要重找 = false
    if (Date.now() - 上次找 > 5000) {
      名单 = await 刷新窝(true)
      果 = (await 挨个问(名单, client)) || 果
    }
  }
  return 果 || { ok: false, error: 名单.length ? '窝没回应' : '找不到朗读桥（DSH 开着吗？）' }
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
      const st = await askBase(w, '/state')
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
        const w = 窝靠基(msg.payload && msg.payload.base)
        sendResponse({ ok: true, data: w ? await askBase(w, '/ack', msg.payload) : { ok: false } })
      } else if (msg.type === 'playing') {
        const w = 窝靠基(msg.base)
        sendResponse({ ok: true, data: w ? await askBase(w, '/playing', { id: msg.id, on: msg.on }) : { ok: false } })
      } else if (msg.type === 'auto') {
        const w = 窝靠基(msg.base)
        sendResponse({ ok: true, data: w ? await askBase(w, '/auto', { auto: msg.value }) : { ok: false } })
      } else if (msg.type === 'say') {
        const w = 窝靠基(msg.base)
        sendResponse({ ok: true, data: w ? await askBase(w, '/say', { text: msg.text }) : { ok: false } })
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
