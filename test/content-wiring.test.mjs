// content.js 的生命周期接线：在 vm 里加载真正的 extension/playback.js + extension/content.js，
// 用假 DOM、假 chrome.runtime、假时钟（含 Date.now）跑。只用合成数据，不连任何宿主。
// 跑法：node --test test/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const SRC_PLAYBACK = readFileSync(new URL('../extension/playback.js', import.meta.url), 'utf8')
const SRC_CONTENT = readFileSync(new URL('../extension/content.js', import.meta.url), 'utf8')
const flush = () => new Promise((r) => setImmediate(r))
const S = 1_000_000 // 假时钟起点（busySince 为 0 时看门狗不动，所以不能从 0 开始）

function fakeClock(start) {
  let now = start
  let seq = 0
  const timers = new Map()
  const add = (fn, ms, every) => {
    const id = ++seq
    timers.set(id, { at: now + Math.max(0, ms | 0), fn, every })
    return id
  }
  return {
    now: () => now,
    setTimeout: (fn, ms) => add(fn, ms, 0),
    setInterval: (fn, ms) => add(fn, ms, ms),
    clearTimeout: (id) => timers.delete(id),
    async advanceTo(rel) {
      const end = start + rel
      for (;;) {
        let next = null
        for (const [id, t] of timers) if (t.at <= end && (!next || t.at < next[1].at)) next = [id, t]
        if (!next) break
        const [id, t] = next
        now = t.at
        if (t.every) t.at += t.every
        else timers.delete(id)
        t.fn()
        await flush()
      }
      now = end
      await flush()
    },
  }
}

// dom.md：页面上有没有（新的）回复；dom.readBtn：「朗读」按钮挂出来没有
function loadContent(respond) {
  const clock = fakeClock(S)
  const log = []
  const sent = []
  const dom = { md: false, readBtn: false, stopBtn: false }
  const el = (extra) => ({
    style: {},
    dataset: {},
    textContent: '',
    className: '',
    innerText: '',
    parentElement: null,
    getAttribute: () => null,
    getBoundingClientRect: () => ({ width: 10, height: 10, left: 0, top: 0, right: 10 }),
    appendChild() {},
    addEventListener() {},
    dispatchEvent() {},
    querySelectorAll: () => [],
    ...extra,
  })
  class HTMLTextAreaElement {
    get value() {
      return this._v || ''
    }
    set value(v) {
      this._v = v
      log.push('setValue')
    }
  }
  class HTMLInputElement extends HTMLTextAreaElement {}
  const input = Object.assign(Object.create(HTMLTextAreaElement.prototype), el({ tagName: 'TEXTAREA', focus() {} }))
  input.dispatchEvent = (ev) => log.push('ev:' + ev.type)
  const sendBtn = el({
    tagName: 'BUTTON',
    getAttribute: (n) => (n === 'aria-label' ? '发送' : null),
    click: () => log.push('click:send'),
  })
  const md = el({ tagName: 'DIV', className: 'ds-markdown', innerText: '甲', compareDocumentPosition: () => 4 })
  const readBtn = el({
    tagName: 'BUTTON',
    getAttribute: (n) => (n === 'aria-label' ? '朗读' : null),
    click: () => log.push('click:read'),
  })
  // dom.stopBtn：页面上挂着一个「停止朗读」，但点它会抛错
  const stopBtn = el({
    tagName: 'BUTTON',
    getAttribute: (n) => (n === 'aria-label' ? '停止朗读' : null),
    click: () => {
      log.push('click:stop')
      throw new Error('合成的点击失败')
    },
  })
  const document = {
    title: 't',
    body: { innerText: '' },
    documentElement: { appendChild() {} },
    createElement: () => el({ tagName: 'DIV' }),
    querySelectorAll(sel) {
      if (sel === 'textarea') return [input]
      if (sel === '.ds-markdown') return dom.md ? [md] : []
      if (sel === '*') return dom.readBtn ? [readBtn] : []
      if (sel.includes('button')) return dom.stopBtn ? [sendBtn, stopBtn] : [sendBtn]
      return []
    },
  }
  class Ev {
    constructor(type) {
      this.type = type
    }
  }
  const ctx = {
    console,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval,
    clearInterval: clock.clearTimeout,
    Date: class extends Date {
      static now() {
        return clock.now()
      }
    },
    document,
    location: { href: 'https://example.invalid/' },
    localStorage: { getItem: () => null, setItem() {} },
    requestAnimationFrame: (f) => f(),
    getComputedStyle: () => ({ visibility: 'visible', display: 'block', opacity: '1' }),
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    Event: Ev,
    KeyboardEvent: Ev,
    MouseEvent: Ev,
    HTMLTextAreaElement,
    HTMLInputElement,
    Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
    chrome: {
      runtime: {
        sendMessage: (msg) => {
          sent.push({ at: clock.now() - S, msg })
          return respond(msg)
        },
      },
    },
  }
  ctx.self = ctx
  ctx.window = ctx
  vm.createContext(ctx)
  vm.runInContext(SRC_PLAYBACK, ctx, { filename: 'extension/playback.js' })
  vm.runInContext(SRC_CONTENT, ctx, { filename: 'extension/content.js' })
  // vm 里造的对象原型不是这边的 Object.prototype，deepStrictEqual 会判不等 —— 先转成本 realm 的普通对象
  const acks = () => sent.filter((s) => s.msg.type === 'ack').map((s) => JSON.parse(JSON.stringify(s.msg.payload)))
  return { clock, log, sent, dom, acks }
}

const ok = (data) => Promise.resolve({ ok: true, data: data || {} })

test('看门狗复位后：旧条目不许点新条目的「朗读」；回执写回旧条目自己的窝', async () => {
  let polls = 0
  let pending = null
  const env = loadContent((msg) => {
    if (msg.type !== 'poll') return ok()
    polls++
    // 第一次：窝 A 发来第 1 条；之后换成窝 B 在答话
    if (polls === 1) return ok({ base: 'A', item: { id: 1, text: '甲' }, watching: true })
    const item = pending
    pending = null
    return ok({ base: 'B', item, watching: true })
  })
  await flush()
  // 第 1 条：发出去了；8 秒时回复出来了，但朗读按钮一直没挂出来 → 它在 findReadButton 里耐心找
  await env.clock.advanceTo(8000)
  env.dom.md = true
  await env.clock.advanceTo(20999)
  assert.equal(env.acks().length, 0, '看门狗还没到点')
  pending = { id: 2, text: '乙' } // 窝 B 排了第 2 条
  await env.clock.advanceTo(21000) // 看门狗：卡了 21 秒，复位
  const wd = env.acks().find((a) => a.id === 0)
  assert.ok(wd && /^卡住超时/.test(wd.error), '看门狗回执')
  assert.equal(wd.base, 'A', '看门狗回执写回卡住那条的窝，不是当前的 B')
  await env.clock.advanceTo(21700) // 21.6 秒那次 poll 接走了第 2 条
  assert.equal(env.log.filter((x) => x === 'setValue').length, 2, '第 2 条已经开始')
  env.dom.readBtn = true // 现在页面上挂出了一个「朗读」按钮（属于新那条的现场）
  await env.clock.advanceTo(25000)
  assert.ok(!env.log.includes('click:read'), '旧条目醒过来也不许去点')
  const a1 = env.acks().filter((a) => a.id === 1)
  assert.deepEqual(a1, [{ id: 1, ok: false, error: '已取消', detail: null, base: 'A' }], '旧条目照样回执失败，写回 A')
  assert.ok(!env.acks().some((a) => a.base === 'B'), '旧条目没有往 B 写任何回执')
})

test('看门狗复位会了结在盯的播放；卡住的 audible 迟到回来也不再报 playing', async () => {
  let polls = 0
  let releaseAudible = null
  const env = loadContent((msg) => {
    if (msg.type === 'audible') return new Promise((r) => (releaseAudible = r)) // 永远不回（直到测试放行）
    if (msg.type !== 'poll') return ok()
    polls++
    if (polls === 1) return ok({ base: 'A', item: { id: 1, text: '甲' }, watching: true })
    return ok({ base: 'B', item: null, watching: true })
  })
  await flush()
  await env.clock.advanceTo(3000)
  env.dom.md = true
  env.dom.readBtn = true
  await env.clock.advanceTo(8000)
  assert.deepEqual(env.log.filter((x) => x === 'click:read'), ['click:read'], '点了朗读')
  assert.equal(typeof releaseAudible, 'function', '在盯播放，问 audible 卡住了')
  await env.clock.advanceTo(28000) // 盯播放第一拍续过一次 busySince，之后卡住 → 看门狗到点
  const a1 = env.acks().filter((a) => a.id === 1)
  assert.deepEqual(a1, [{ id: 1, ok: false, error: '卡太久了，已复位', detail: null, base: 'A' }])
  assert.equal(env.acks().find((a) => a.id === 0).base, 'A')
  const playingBefore = env.sent.filter((s) => s.msg.type === 'playing').length
  releaseAudible({ ok: true, data: { audible: true } })
  await flush()
  await env.clock.advanceTo(40000)
  assert.equal(env.sent.filter((s) => s.msg.type === 'playing').length, playingBefore, '迟到的「出声了」不报')
  assert.equal(env.acks().filter((a) => a.id === 1).length, 1, '不会再回执一次')
})

test('看门狗复位时停止按钮点击抛错：没有未处理 rejection；诊断与旧条目失败回执都写回原窝', async () => {
  const unhandled = []
  const onUnhandled = (e) => unhandled.push(e)
  process.on('unhandledRejection', onUnhandled)
  try {
    let polls = 0
    const env = loadContent((msg) => {
      if (msg.type !== 'poll') return ok()
      polls++
      if (polls === 1) return ok({ base: 'A', item: { id: 1, text: '甲' }, watching: true })
      return ok({ base: 'B', item: null, watching: true })
    })
    await flush()
    await env.clock.advanceTo(8000)
    env.dom.md = true
    await env.clock.advanceTo(20999)
    env.dom.stopBtn = true // 复位那一刻页面上有「停止朗读」，点它会抛错
    await env.clock.advanceTo(21000)
    env.dom.stopBtn = false
    await env.clock.advanceTo(25000)
    assert.deepEqual(env.log.filter((x) => x === 'click:stop'), ['click:stop'], '只点了一次，不重试')
    const diag = env.acks().find((a) => a.id === 0 && /^复位时停止朗读失败/.test(a.error))
    assert.ok(diag && /合成的点击失败/.test(diag.error), '停止失败有诊断')
    assert.equal(diag.base, 'A', '诊断写回卡住那条的窝')
    assert.equal(env.acks().find((a) => a.id === 0 && /^卡住超时/.test(a.error)).base, 'A')
    assert.deepEqual(env.acks().filter((a) => a.id === 1), [{ id: 1, ok: false, error: '已取消', detail: null, base: 'A' }])
    assert.ok(!env.acks().some((a) => a.base === 'B'), '没有往 B 写任何回执')
    await flush()
    assert.deepEqual(unhandled, [], '没有未处理的 rejection')
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

test('停止指令的回执写回发停止的那个窝', async () => {
  let polls = 0
  const env = loadContent((msg) => {
    if (msg.type !== 'poll') return ok()
    polls++
    if (polls === 1) return ok({ base: 'C', item: { stop: true }, watching: true })
    return ok({ base: 'D', item: null, watching: true })
  })
  await flush()
  await env.clock.advanceTo(3000)
  assert.deepEqual(env.acks(), [{ id: 0, ok: true, error: null, detail: '没找到停止按钮', base: 'C' }])
})
