// 盯播放的生命周期：直接加载 extension/playback.js（扩展里真跑的那份），用假时钟 + 假「在出声」测。
// 跑法：node --test test/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

globalThis.self = globalThis
vm.runInThisContext(readFileSync(new URL('../extension/playback.js', import.meta.url), 'utf8'), {
  filename: 'extension/playback.js',
})
const { createPlaybackWait, runItem } = globalThis.__ttsPlayback

const flush = () => new Promise((r) => setImmediate(r))

function fakeClock() {
  let now = 0
  let seq = 0
  const timers = new Map()
  return {
    setTimeout: (fn, ms) => {
      const id = ++seq
      timers.set(id, { at: now + ms, fn })
      return id
    },
    clearTimeout: (id) => timers.delete(id),
    pending: () => timers.size,
    async advance(ms) {
      const end = now + ms
      for (;;) {
        let next = null
        for (const [id, t] of timers) if (t.at <= end && (!next || t.at < next[1].at)) next = [id, t]
        if (!next) break
        timers.delete(next[0])
        now = next[1].at
        next[1].fn()
        await flush()
      }
      now = end
      await flush()
    },
  }
}

// audible: 数组（按拍取，取完沿用最后一个）或函数
function setup(audible, extra = {}) {
  const clock = fakeClock()
  const log = []
  let i = 0
  const opts = {
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    askAudible: async () => {
      if (typeof audible === 'function') return audible()
      const v = audible[Math.min(i, audible.length - 1)]
      i++
      return v
    },
    onPlaying: async (on) => log.push('playing:' + on),
    onStatus: (s) => log.push('status:' + s),
    retry: async () => log.push('retry'),
    ...extra,
  }
  const w = createPlaybackWait(opts)
  let verdict
  w.promise.then((v) => (verdict = v))
  return { clock, log, w, get verdict() { return verdict } }
}

test('第一次出声只报 playing，不算完成', async () => {
  const s = setup([true])
  await s.clock.advance(1000)
  assert.deepEqual(s.log, ['status:出声了', 'playing:true'])
  assert.equal(s.verdict, undefined)
  assert.equal(s.w.settled, false)
  assert.equal(s.clock.pending(), 2, '下一拍 + 墙钟期限')
})

test('一直在出声：不结束，第 25 拍发心跳', async () => {
  const s = setup([true])
  await s.clock.advance(30000)
  assert.equal(s.verdict, undefined)
  assert.deepEqual(s.log.filter((x) => x.startsWith('playing')), ['playing:true', 'playing:true'])
})

test('出过声后连续 3 次静着才算念完', async () => {
  const s = setup([true, true, true, false, false, true, false, false, false])
  await s.clock.advance(5000)
  assert.equal(s.verdict, undefined, '静 2 次不算完')
  await s.clock.advance(3000)
  assert.equal(s.verdict, undefined, '中间又出声，静音计数清零')
  await s.clock.advance(1000)
  assert.deepEqual(s.verdict, { ok: true })
  assert.equal(s.log.at(-1), 'playing:false')
  assert.equal(s.clock.pending(), 0)
})

test('一直不出声：第 6 拍重试一次，第 18 拍失败并带页面提示', async () => {
  const s = setup([false], { warning: () => '朗读已达今日限额' })
  await s.clock.advance(5000)
  assert.ok(!s.log.includes('retry'))
  await s.clock.advance(1000)
  assert.deepEqual(s.log.filter((x) => x === 'retry'), ['retry'])
  await s.clock.advance(11000)
  assert.equal(s.verdict, undefined)
  await s.clock.advance(1000)
  assert.deepEqual(s.verdict, { ok: false, why: '点了朗读但没出声', detail: '页面提示：朗读已达今日限额' })
  assert.equal(s.log.at(-1), 'playing:false')
  assert.deepEqual(s.log.filter((x) => x === 'retry'), ['retry'])
  assert.equal(s.clock.pending(), 0)
})

test('取消：isCancelled 下一拍收敛；cancel() 立即收敛；之后不再有动作', async () => {
  let cancelled = false
  const s = setup([true], { isCancelled: () => cancelled })
  await s.clock.advance(2000)
  cancelled = true
  await s.clock.advance(1000)
  assert.deepEqual(s.verdict, { ok: false, why: '已取消' })
  assert.equal(s.clock.pending(), 0)

  const t = setup([true])
  await t.clock.advance(1000)
  t.w.cancel('被新的一条接替')
  await flush()
  assert.deepEqual(t.verdict, { ok: false, why: '被新的一条接替' })
  const before = t.log.length
  await t.clock.advance(10000)
  assert.equal(t.log.length, before)
  assert.equal(t.clock.pending(), 0)
})

test('askAudible 很慢时不重入：上一拍没回来不排下一拍', async () => {
  let inFlight = 0
  let maxInFlight = 0
  let calls = 0
  let release
  const s = setup(() => {
    calls++
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    return new Promise((r) => {
      release = (v) => {
        inFlight--
        r(v)
      }
    })
  })
  await s.clock.advance(10000)
  assert.equal(calls, 1)
  assert.equal(s.clock.pending(), 1, '挂着的那拍回来之前没有新的拍子（只剩墙钟期限）')
  release(true)
  await flush()
  await s.clock.advance(1000)
  assert.equal(calls, 2)
  assert.equal(maxInFlight, 1)
})

test('旧回调无效：结束后迟到的 askAudible / retry 结果不改状态、不再排拍', async () => {
  let release
  const s = setup(() => new Promise((r) => (release = r)))
  await s.clock.advance(1000)
  s.w.cancel('已取消')
  release(true)
  await flush()
  assert.deepEqual(s.log, [], '取消后迟到的「出声了」不能报出去')
  assert.equal(s.clock.pending(), 0)

  // 重试的 0.9 秒里被取消
  let finishRetry
  const t = setup([false], { retry: () => new Promise((r) => (finishRetry = r)) })
  await t.clock.advance(6000)
  assert.equal(typeof finishRetry, 'function')
  t.w.cancel('已取消')
  finishRetry()
  await flush()
  assert.equal(t.clock.pending(), 0)
  assert.ok(!t.log.includes('status:点了朗读但没出声'))
})

test('一直响也会收敛（上限）', async () => {
  const s = setup([true], { maxTicks: 40 })
  await s.clock.advance(40000)
  assert.deepEqual(s.verdict, { ok: false, why: '响太久了，不再等' })
  assert.equal(s.log.at(-1), 'playing:false')
  assert.equal(s.clock.pending(), 0)
})

test('runItem：出声时不回执，念完才回执；下一条要等上一条回执后才开始', async () => {
  const clock = fakeClock()
  const events = []
  // 每条：2 拍出声，然后静
  const audibleFor = new Map()
  let current = null
  const deps = {
    speak: async (text) => {
      events.push('speak:' + text)
      return null
    },
    waitPlayback: (id) => {
      current = id
      audibleFor.set(id, 0)
      const w = createPlaybackWait({
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
        askAudible: async () => {
          const n = audibleFor.get(id) + 1
          audibleFor.set(id, n)
          return n <= 2
        },
        onPlaying: async (on) => events.push('playing:' + id + ':' + on),
      })
      return w.promise
    },
    ack: async (id, ok, why) => events.push('ack:' + id + ':' + ok + (why ? ':' + why : '')),
  }

  // 模拟 content.js 的 loop：busy 时不接新条目
  const queue = [
    { id: 1, text: '甲' },
    { id: 2, text: '乙' },
  ]
  let busy = false
  const results = []
  const pollOnce = () => {
    if (busy || !queue.length) return
    const item = queue[0]
    busy = true
    runItem(item, deps).then((s) => {
      results.push(s)
      queue.shift() // 宿主收到 ack 才出队
      busy = false
    })
  }

  pollOnce()
  await flush()
  await clock.advance(1000)
  assert.deepEqual(events, ['speak:甲', 'playing:1:true'])
  for (let t = 0; t < 3; t++) {
    pollOnce()
    await clock.advance(1000)
  }
  // 第 2 拍还在响、第 3、4 拍静 —— 还没满 3 次静音
  assert.ok(!events.some((e) => e.startsWith('ack')), '还在念时不能回执')
  assert.ok(!events.includes('speak:乙'), '上一条没念完，下一条不能开始')
  await clock.advance(1000)
  assert.deepEqual(events.slice(-2), ['playing:1:false', 'ack:1:true'])
  pollOnce()
  await flush()
  assert.equal(events.at(-1), 'speak:乙')
  assert.equal(current, 2)
  await clock.advance(10000)
  assert.deepEqual(events.slice(-2), ['playing:2:false', 'ack:2:true'])
  assert.deepEqual(results, ['念完了', '念完了'])
})

test('runItem：未出声、取消、speak 抛错都回执失败', async () => {
  const acks = []
  const ack = async (id, ok, why, detail) => acks.push([id, ok, why, detail])
  await runItem({ id: 7, text: 'x' }, {
    speak: async () => '页面提示：朗读失败',
    waitPlayback: async () => ({ ok: false, why: '点了朗读但没出声', detail: null }),
    ack,
  })
  await runItem({ id: 8, text: 'x' }, {
    speak: async () => null,
    waitPlayback: async () => ({ ok: false, why: '已取消' }),
    ack,
  })
  const e = new Error('没找到对话框')
  e.detail = 'd'
  const s = await runItem({ id: 9, text: 'x' }, {
    speak: async () => {
      throw e
    },
    waitPlayback: async () => assert.fail('不该走到这'),
    ack,
  })
  assert.deepEqual(acks, [
    [7, false, '点了朗读但没出声', '页面提示：朗读失败'],
    [8, false, '已取消', null],
    [9, false, '没找到对话框', 'd'],
  ])
  assert.equal(s, '没念成：没找到对话框')
})

// ---------- 出错收敛 ----------
const never = () => new Promise(() => {})

test('onStatus 抛错：收敛成失败，清掉计时器，补一句没在响', async () => {
  const s = setup([true], {
    onStatus: () => {
      throw new Error('画状态炸了')
    },
  })
  await s.clock.advance(1000)
  assert.deepEqual(s.verdict, { ok: false, why: '盯播放出错：画状态炸了' })
  assert.deepEqual(s.log, ['playing:false'])
  assert.equal(s.clock.pending(), 0)
  await s.clock.advance(10000)
  assert.deepEqual(s.log, ['playing:false'], '收敛后不再有动作')
})

test('onTick 抛错 / retry reject：都收敛成失败', async () => {
  const s = setup([true], {
    onTick: () => {
      throw new Error('tick 炸了')
    },
  })
  await s.clock.advance(1000)
  assert.deepEqual(s.verdict, { ok: false, why: '盯播放出错：tick 炸了' })
  assert.equal(s.clock.pending(), 0)

  const t = setup([false], { retry: async () => Promise.reject(new Error('找不到按钮')) })
  await t.clock.advance(6000)
  assert.deepEqual(t.verdict, { ok: false, why: '盯播放出错：找不到按钮' })
  assert.equal(t.clock.pending(), 0)
  await t.clock.advance(20000)
  assert.ok(!t.log.includes('status:点了朗读但没出声'))
})

test('出错路径里的回调自己也炸：照样收敛', async () => {
  // onPlaying 同步抛错：第一次出声时炸 → 走出错收尾 → 收尾的 onPlaying(false) 又炸 → 不影响结论
  const s = setup([true], {
    onPlaying: () => {
      throw new Error('playing 炸了')
    },
  })
  await s.clock.advance(1000)
  assert.deepEqual(s.verdict, { ok: false, why: '盯播放出错：playing 炸了' })
  assert.equal(s.clock.pending(), 0)

  // onPlaying 返回 reject 的 promise：收尾那次的 reject 也被吞掉，不留 unhandled rejection
  const t = setup([true], { onPlaying: () => Promise.reject(new Error('发不出去')) })
  await t.clock.advance(1000)
  assert.deepEqual(t.verdict, { ok: false, why: '盯播放出错：发不出去' })
  assert.equal(t.clock.pending(), 0)
})

// ---------- 墙钟期限 ----------
test('askAudible 永远不回来：墙钟到点收敛，不靠拍数', async () => {
  const s = setup(never, { maxMs: 5000 })
  await s.clock.advance(4999)
  assert.equal(s.verdict, undefined)
  await s.clock.advance(1)
  assert.deepEqual(s.verdict, { ok: false, why: '响太久了，不再等' })
  assert.deepEqual(s.log, ['status:响太久了，不再等', 'playing:false'])
  assert.equal(s.clock.pending(), 0)
})

test('onPlaying(true) / retry 永远不回来：墙钟到点收敛', async () => {
  const s = setup([true], {
    maxMs: 8000,
    onPlaying: (on) => (on ? never() : Promise.resolve()),
  })
  await s.clock.advance(8000)
  assert.deepEqual(s.verdict, { ok: false, why: '响太久了，不再等' })
  assert.equal(s.clock.pending(), 0)

  const t = setup([false], { maxMs: 10000, retry: never })
  await t.clock.advance(10000)
  assert.deepEqual(t.verdict, { ok: false, why: '响太久了，不再等' })
  assert.equal(t.clock.pending(), 0)
})

test('墙钟到期后迟到的回调：不改状态、不报 playing、不排拍', async () => {
  let release
  const s = setup(() => new Promise((r) => (release = r)), { maxMs: 3000 })
  await s.clock.advance(3000)
  assert.deepEqual(s.verdict, { ok: false, why: '响太久了，不再等' })
  const before = s.log.slice()
  release(true)
  await flush()
  await s.clock.advance(10000)
  assert.deepEqual(s.log, before, '迟到的「出声了」不能报出去')
  assert.equal(s.clock.pending(), 0)

  // 重试卡住、到期后才回来：不会接着点「没出声」那一套
  let finishRetry
  const t = setup([false], { maxMs: 7000, retry: () => new Promise((r) => (finishRetry = r)) })
  await t.clock.advance(7000)
  assert.equal(t.verdict.why, '响太久了，不再等')
  const tBefore = t.log.slice()
  finishRetry()
  await flush()
  await t.clock.advance(20000)
  assert.deepEqual(t.log, tBefore)
  assert.equal(t.clock.pending(), 0)
})

test('正常念完 / 取消都会清掉墙钟期限', async () => {
  const s = setup([true, false, false, false], { maxMs: 60000 })
  await s.clock.advance(4000)
  assert.deepEqual(s.verdict, { ok: true })
  assert.equal(s.clock.pending(), 0)
  const t = setup([true], { maxMs: 60000 })
  await t.clock.advance(1000)
  t.w.cancel()
  assert.equal(t.clock.pending(), 0)
})

test('runItem + askAudible 永远不回来：到期只回执一次失败，迟到的结果不再回执', async () => {
  const clock = fakeClock()
  const events = []
  let release
  const s = runItem({ id: 5, text: 'x' }, {
    speak: async () => null,
    waitPlayback: () =>
      createPlaybackWait({
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
        maxMs: 4000,
        askAudible: () => new Promise((r) => (release = r)),
        onPlaying: async (on) => events.push('playing:' + on),
      }).promise,
    ack: async (id, ok, why) => events.push('ack:' + id + ':' + ok + ':' + why),
  })
  await flush()
  await clock.advance(4000)
  assert.equal(await s, '没念成：响太久了，不再等')
  release(true)
  await flush()
  await clock.advance(10000)
  assert.deepEqual(events, ['playing:false', 'ack:5:false:响太久了，不再等'])
})
