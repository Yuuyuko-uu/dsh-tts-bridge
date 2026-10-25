// 1.3.0：给「盯播放」加按字数的上限，并在放弃时让页面收手（别傻等 30 分钟）
// 跑法：node --test test/playback-cap.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const 根 = join(dirname(fileURLToPath(import.meta.url)), '..')

// 把 playback.js 装到一个假的 self 上（它本来就是挂 self.__ttsPlayback 的）
const 装 = () => {
  const 源 = readFileSync(join(根, 'extension', 'playback.js'), 'utf8')
  const self = {}
  new Function('self', 源)(self)
  return self.__ttsPlayback
}

// 假时钟：手动推进
function 假时钟() {
  let 任务们 = []
  let 现在 = 0
  return {
    setTimeout: (fn, ms) => {
      const 项 = { fn, at: 现在 + Math.max(0, ms || 0), 清: false }
      任务们.push(项)
      return 项
    },
    clearTimeout: (项) => { if (项) 项.清 = true },
    推进: (ms) => {
      现在 += ms
      const 该跑 = 任务们.filter((x) => !x.清 && x.at <= 现在).sort((a, b) => a.at - b.at)
      for (const 项 of 该跑) {
        if (项.清) continue
        项.清 = true
        项.fn()
      }
    },
    在跑的: () => 任务们.filter((x) => !x.清).length,
  }
}

test('一直不出声：到 maxMs 就收敛成失败，并叫 onGiveUp 收手一次', async () => {
  const PB = 装()
  const 钟 = 假时钟()
  let 让收手 = 0
  const w = PB.createPlaybackWait({
    intervalMs: 1000,
    maxMs: 5000,
    setTimeout: 钟.setTimeout,
    clearTimeout: 钟.clearTimeout,
    askAudible: async () => false,
    onPlaying: async () => {},
    onGiveUp: () => { 让收手++ },
  })
  钟.推进(6000)
  const 结果 = await w.promise
  assert.equal(结果.ok, false)
  assert.equal(让收手, 1, '放弃时应该让页面收手一次')
  assert.equal(钟.在跑的(), 0, '收尾后不该还留着计时器')
})

test('出过声但一直响（标签页有别的声音）：到点也是失败 + 收手', async () => {
  const PB = 装()
  const 钟 = 假时钟()
  let 收手 = 0
  let 报过响 = 0
  const w = PB.createPlaybackWait({
    intervalMs: 1000,
    maxMs: 4000,
    setTimeout: 钟.setTimeout,
    clearTimeout: 钟.clearTimeout,
    askAudible: async () => true,
    onPlaying: async (on) => { if (on) 报过响++ },
    onGiveUp: () => { 收手++ },
  })
  for (let i = 0; i < 12 && !w.settled; i++) {
    钟.推进(1000)
    await new Promise((r) => setImmediate(r))
  }
  const 结果 = await w.promise
  assert.equal(结果.ok, false)
  assert.ok(报过响 >= 1, '应该先报过「在响」')
  assert.equal(收手, 1)
})

test('正常念完：不叫 onGiveUp（别把好好的播放点停了）', async () => {
  const PB = 装()
  const 钟 = 假时钟()
  let 收手 = 0
  let 响 = true
  let 拍 = 0
  const w = PB.createPlaybackWait({
    intervalMs: 1000,
    maxMs: 60000,
    setTimeout: 钟.setTimeout,
    clearTimeout: 钟.clearTimeout,
    askAudible: async () => {
      拍++
      if (拍 > 3) 响 = false
      return 响
    },
    onPlaying: async () => {},
    onGiveUp: () => { 收手++ },
  })
  for (let i = 0; i < 30 && !w.settled; i++) {
    钟.推进(1000)
    await new Promise((r) => setImmediate(r)) // 让 tick 里的 await 跑完，才排得上下一拍
  }
  const 结果 = await w.promise
  assert.equal(结果.ok, true, '连续静 3 次应该算念完')
  assert.equal(收手, 0, '正常念完不该点停止')
})

test('content.js 里确实按字数算上限（不是写死 30 分钟）', () => {
  const 源 = readFileSync(join(根, 'extension', 'content.js'), 'utf8')
  assert.match(源, /function 等多久\(/, '应该有按字数算上限的函数')
  assert.match(源, /maxMs: 等多久\(text\)/, '应该把上限传给 createPlaybackWait')
  assert.match(源, /onGiveUp:/, '应该把收手钩子接上')
  assert.match(源, /缺 playback\.js/, '缺文件时应该有明确提示')
})
