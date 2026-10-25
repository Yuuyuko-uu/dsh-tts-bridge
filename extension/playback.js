// DSH 朗读桥 · 盯播放（content.js 之前加载，不碰 DOM / chrome API，能拿假时钟直接测）
//
// 一次等待 = 一条话从「点了朗读」到「念完 / 没出声 / 被取消」的完整一段：
//   - 第一次出声只报「在响」（playing on），**不算完** —— 以前一出声就回执，
//     宿主马上把下一条发过来，下一条一点朗读就把这一条打断了 ✗
//   - 出过声之后连续 3 次静着，才算念完（playing off → 成功）✓
//   - 一直不出声：第 6 次「停一下再点一次」，第 18 次还没声就算失败（老规矩不变）✓
//   - 每次等待有自己的计时器和「已结束」标记：上一拍的异步还没回来就不排下一拍（不重入），
//     结束之后迟到的回调一律作废，不会改到下一条头上 ✓
//   - 任何一步抛错 / reject（重试点页面、onStatus、onTick……）都收敛成失败，不会悬着 ✓
//   - 另有一个**墙钟**期限（不靠拍数）：askAudible / onPlaying / retry 卡住永远不回来也会到点结束 ✓
;(() => {
  // 收尾通知：不等它、它出错也不管 —— 收尾路径自己不能再把收敛卡住
  const quietly = (fn) => {
    try {
      Promise.resolve(fn()).catch(() => {})
    } catch (e) {}
  }

  function createPlaybackWait(o) {
    const intervalMs = o.intervalMs || 1000
    // 兜底：一直在响也不能无限等（比如标签页里别的东西在出声）
    const maxTicks = o.maxTicks || 1800
    // 墙钟兜底（默认 30 分钟）：哪一步 await 永远不回来，拍数就不涨，只能靠它
    const maxMs = o.maxMs || 30 * 60 * 1000
    const setT = o.setTimeout || setTimeout
    const clearT = o.clearTimeout || clearTimeout
    let settled = false
    let timer = null
    let deadline = null
    let reported = false
    let quiet = 0
    let waited = 0
    let retried = false
    let resolveFn = null

    const promise = new Promise((r) => {
      resolveFn = r
    })

    // off=true：结束后补一句「没在响」（不等、不抛）—— 用在出错 / 到期这种没走正常收尾的路径
    const finish = (verdict, off) => {
      if (settled) return
      settled = true
      if (timer) clearT(timer)
      timer = null
      if (deadline) clearT(deadline)
      deadline = null
      resolveFn(verdict)
      if (off) quietly(() => o.onPlaying(false))
    }
    const status = (s) => {
      if (!settled && o.onStatus) o.onStatus(s)
    }

    async function tick() {
      timer = null
      if (settled) return
      try {
        await step()
      } catch (e) {
        return finish({ ok: false, why: '盯播放出错：' + ((e && e.message) || String(e)) }, true)
      }
      next()
    }

    async function step() {
      if (o.isCancelled && o.isCancelled()) return finish({ ok: false, why: '已取消' })
      waited++
      if (o.onTick) o.onTick(waited)
      const audible = await o.askAudible()
      if (settled) return
      if (audible) {
        quiet = 0
        if (!reported) {
          reported = true
          status('出声了')
          await o.onPlaying(true)
        } else if (waited % 25 === 0) {
          // 心跳：告诉宿主「我还在响」，免得页面刷新后那边永远以为在响
          await o.onPlaying(true)
        }
        if (settled) return
        // 一出声不回执、不结束 —— 继续往下排下一拍，等它真念完
      } else {
        quiet++
        if (reported && quiet >= 3) {
          status('念完了')
          await o.onPlaying(false)
          return finish({ ok: true })
        }
        if (!reported && !retried && waited >= 6) {
          retried = true
          status('没出声，重来一次…')
          if (o.retry) await o.retry()
        } else if (!reported && retried && waited >= 18) {
          status('点了朗读但没出声')
          await o.onPlaying(false)
          const w = o.warning ? o.warning() : null
          return finish({ ok: false, why: '点了朗读但没出声', detail: w ? '页面提示：' + w : null })
        }
      }
      if (settled) return
      if (waited >= maxTicks) {
        status('响太久了，不再等')
        await o.onPlaying(false)
        finish({ ok: false, why: '响太久了，不再等' })
        // 放弃之后也要让页面那头收手（点一下停止）—— 不然这边说「没在响」，
        // 页面却还在念，下一句一进来又被打断
        if (o.onGiveUp) quietly(() => o.onGiveUp())
        return
      }
    }

    // 上一拍彻底跑完才排下一拍 —— askAudible 再慢也不会两拍叠在一起
    function next() {
      if (!settled) timer = setT(tick, intervalMs)
    }

    deadline = setT(() => {
      deadline = null
      try {
        status('响太久了，不再等')
      } catch (e) {}
      finish({ ok: false, why: '响太久了，不再等' }, true)
      if (o.onGiveUp) quietly(() => o.onGiveUp())
    }, maxMs)
    next()
    return {
      promise: promise,
      cancel: (why) => finish({ ok: false, why: why || '已取消' }),
      get settled() {
        return settled
      },
    }
  }

  // 一条话的完整处理：念 → 等播放真正结束 → 才回执。
  // 回执之前 promise 不结束，content.js 的 busy 就一直在，下一条不会提前开始。
  async function runItem(item, d) {
    try {
      const note = await d.speak(item.text)
      const verdict = await d.waitPlayback(item.id)
      const detail = [note, verdict.detail].filter(Boolean).join(' | ')
      await d.ack(item.id, verdict.ok, verdict.ok ? null : verdict.why, detail || null)
      return verdict.ok ? '念完了' : '没念成：' + verdict.why
    } catch (e) {
      await d.ack(item.id, false, (e && e.message) || String(e), e && e.detail)
      return '没念成：' + ((e && e.message) || e)
    }
  }

  self.__ttsPlayback = { createPlaybackWait, runItem }
})()
