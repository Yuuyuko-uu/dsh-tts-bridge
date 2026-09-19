// DSH 朗读桥 · 后台
// 两件事：
//   1. 替页面去问本机的 DSH 插件「有没有新的一句」（放后台是为了拿到 host_permissions，不受跨域限制）；
//   2. 万一 DeepSeek 那个页面不在了、而队列里又有话要说，就自己把它叫回来（后台标签，不抢你视线）。

const BASE = 'http://127.0.0.1:3080/dsh-tts-bridge'
const DS_URL = 'https://chat.deepseek.com/'

async function api(path, body) {
  const opt = body
    ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    : { method: 'GET', cache: 'no-store' }
  const r = await fetch(BASE + path, opt)
  if (!r.ok) throw new Error('HTTP ' + r.status)
  return await r.json()
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
  let st = null
  try {
    st = await api('/state')
  } catch (e) {
    return // 朗读桥那边没开着，别乱开标签
  }
  if (!st || !st.ok || !(st.waiting > 0)) return
  try {
    await chrome.tabs.create({ url: DS_URL, active: false })
  } catch (e) {}
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
        sendResponse({ ok: true, data: await api('/next', { client: msg.client || 'anon' }) })
      } else if (msg.type === 'ack') {
        sendResponse({ ok: true, data: await api('/ack', msg.payload) })
      } else if (msg.type === 'auto') {
        sendResponse({ ok: true, data: await api('/auto', { auto: msg.value }) })
      } else if (msg.type === 'say') {
        sendResponse({ ok: true, data: await api('/say', { text: msg.text }) })
      } else if (msg.type === 'recent') {
        sendResponse({ ok: true, data: await api('/recent') })
      } else if (msg.type === 'playing') {
        sendResponse({ ok: true, data: await api('/playing', { id: msg.id, on: msg.on }) })
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
