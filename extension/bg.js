// DSH 朗读桥 · 后台
// 三件事：
//   1. 替页面去问本机的 DSH 插件「有没有新的一句」（放后台是为了拿到 host_permissions，不受跨域限制）；
//   2. 万一 DeepSeek 那个页面不在了、而队列里又有话要说，就自己把它叫回来（后台标签，不抢你视线）；
//   3. 本机可能同时开着两个 DSH（网页版 3080 + 桌面版 43129），所以两个都要问 ——
//      谁手里有活儿就干谁的。只认一个的话，另一个窝里点朗读就永远没反应。

const BASES = ['http://127.0.0.1:3080/dsh-tts-bridge', 'http://127.0.0.1:43129/dsh-tts-bridge']
const DS_URL = 'https://chat.deepseek.com/'

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

// 取件：两个窝都问，谁有活儿就返回谁的
async function pollAll(client) {
  let firstOk = null
  for (const base of BASES) {
    try {
      const data = await askBase(base, '/next', { client: client })
      if (data && data.item) return data
      if (firstOk === null) firstOk = data
    } catch (e) {
      /* 这个窝没起来，跳过 */
    }
  }
  return firstOk || { ok: false, error: '两个窝都连不上' }
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
  for (const base of BASES) {
    try {
      const st = await askBase(base, '/state')
      if (st && st.ok && st.waiting > 0) {
        await chrome.tabs.create({ url: DS_URL, active: false })
        return
      }
    } catch (e) {
      /* 这个窝没起来 */
    }
  }
}

chrome.runtime.onStartup.addListener(ensureTab)
chrome.runtime.onInstalled.addListener(ensureTab)
chrome.alarms.create('tts-bridge-ensure', { periodInMinutes: 0.5 })
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'tts-bridge-ensure') ensureTab()
})

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  ;(async () => {
    try {
      if (msg.type === 'poll') {
        sendResponse({ ok: true, data: await pollAll(msg.client || 'anon') })
      } else if (msg.type === 'ack') {
        const base = msg.payload && msg.payload.base ? msg.payload.base : BASES[0]
        sendResponse({ ok: true, data: await askBase(base, '/ack', msg.payload) })
      } else if (msg.type === 'playing') {
        const base = msg.base || BASES[0]
        sendResponse({ ok: true, data: await askBase(base, '/playing', { id: msg.id, on: msg.on }) })
      } else if (msg.type === 'auto') {
        const base = msg.base || BASES[0]
        sendResponse({ ok: true, data: await askBase(base, '/auto', { auto: msg.value }) })
      } else if (msg.type === 'say') {
        const base = msg.base || BASES[0]
        sendResponse({ ok: true, data: await askBase(base, '/say', { text: msg.text }) })
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
