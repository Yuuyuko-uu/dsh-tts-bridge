// DSH 朗读桥 · 页面端（跑在 chat.deepseek.com 上）
// 流程：取到一句话 → 输进对话框发出去 → 等 DeepSeek 复述完 → 点「朗读」→ 回执。
// 判断「发出去了没有」以「有没有新的回复」为准，不看输入框清没清空（那玩意儿不准）。
// 左下角小面板：只显示一行状态（双击它可以把诊断信息回传给宿主，排错用）。

;(() => {
  const POLL_MS = 1200
  const PREFIX = '请只原样重复下面这一段，不要加任何自己的话，也不要解释：\n\n'
  // 注意：只能用 .ds-markdown（整条消息的容器）。
  // 以前写成 [class*="ds-markdown"]，结果把消息里每个 <p class="ds-markdown-paragraph">
  // 段落也匹配进来了 —— 段落永远排在它父亲后面，于是「末尾那条」永远是一个小段落，
  // 它就以为回复才几个字、还在长，永远等不到头。
  const MD_SEL = '.ds-markdown'
  const CLIENT = Math.random().toString(36).slice(2, 10)

  let auto = true
  let busy = false
  let dead = false
  let status = '刚启动'
  let playTimer = null
  let noteUntil = 0
  let cancelWanted = false
  let busySince = 0
  let lastWarning = null

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  // ---------- 小工具 ----------
  const isVisible = (el) => {
    if (!el || !el.getBoundingClientRect) return false
    const r = el.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) return false
    const cs = getComputedStyle(el)
    return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0'
  }

  const attrs = (el) => {
    const cls = el.className && typeof el.className === 'string' ? el.className : ''
    return [
      el.getAttribute && el.getAttribute('aria-label'),
      el.getAttribute && el.getAttribute('title'),
      el.getAttribute && el.getAttribute('data-testid'),
      cls,
    ]
      .filter(Boolean)
      .join(' ')
  }

  const labels = (el) => (attrs(el) + ' ' + (el.innerText || '').trim().slice(0, 30)).toLowerCase()

  const readInput = (el) => (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' ? el.value : el.innerText || '')

  const setNativeValue = (el, value) => {
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
      setter.call(el, value)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    } else {
      el.focus()
      document.execCommand('selectAll', false, null)
      document.execCommand('insertText', false, value)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
  }

  const key = (el, type) =>
    el.dispatchEvent(
      new KeyboardEvent(type, {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
      }),
    )

  const dump = (root, limit) => {
    const out = []
    const all = (root || document).querySelectorAll('button, [role="button"], [aria-label], [title], [data-testid]')
    for (const el of all) {
      if (!isVisible(el)) continue
      const a = attrs(el).trim()
      if (!a) continue
      out.push(a.slice(0, 60))
      if (out.length >= (limit || 30)) break
    }
    return out
  }

  // 失败时把现场说清楚，方便照着改选择器
  function diagnostics(last) {
    const md = document.querySelectorAll(MD_SEL).length
    const near = []
    let n = last
    for (let i = 0; i < 4 && n; i++) {
      for (const el of n.querySelectorAll('button, [role="button"], [aria-label], [title]')) {
        if (near.length >= 30) break
        const a = attrs(el).trim()
        if (a) near.push((isVisible(el) ? '显' : '隐') + ':' + a.slice(0, 55))
      }
      n = n.parentElement
    }
    const kw = []
    for (const el of document.querySelectorAll('[aria-label], [title], [data-testid], [class]')) {
      const s = attrs(el)
      if (/tts|朗读|voice|speak|audio|volume/i.test(s)) {
        kw.push((isVisible(el) ? '显' : '隐') + ':' + s.slice(0, 55))
        if (kw.length >= 12) break
      }
    }
    const node = last || lastMarkdown()
    const txt = node ? (node.innerText || '').trim() : ''
    const scrolls = []
    let s = node
    for (let i = 0; i < 10 && s; i++) {
      if (s.scrollHeight && s.scrollHeight - s.clientHeight > 20) {
        const cls = s.className && typeof s.className === 'string' ? s.className.slice(0, 30) : s.tagName
        scrolls.push(cls + ' ' + Math.round(s.scrollTop) + '/' + s.scrollHeight)
      }
      s = s.parentElement
    }
    const chain = []
    let p = node
    for (let i = 0; i < 4 && p; i++) {
      const cls = p.className && typeof p.className === 'string' ? p.className.slice(0, 34) : ''
      chain.push((p.tagName || '?').toLowerCase() + '.' + cls)
      p = p.parentElement
    }
    const allBtn = []
    for (const el of document.querySelectorAll('button, [role="button"]')) {
      if (!isVisible(el)) continue
      const a = attrs(el).trim()
      if (!a) continue
      allBtn.push(a.slice(0, 40))
      if (allBtn.length >= 14) break
    }
    return (
      'markdown=' + md +
      ' 生成中=' + isGenerating() +
      ' 朗读按钮就绪=' + readReadyNearLast() +
      ' 末条字数=' + txt.length +
      ' 末条可见=' + isVisible(node) +
      ' 末条开头=' + JSON.stringify(txt.slice(0, 20)) +
      ' || 父链：' + chain.join(' > ') +
      ' || 全页按钮：' + allBtn.join(' ;; ') +
      ' || 关键词：' + kw.slice(0, 8).join(' ;; ')
    )
  }

  const fail = (msg, detail) => {
    const e = new Error(msg)
    if (detail) e.detail = detail
    return e
  }

  const short = (t, n) => {
    const s = String(t || '').replace(/\s+/g, ' ').trim()
    return s.length > n ? s.slice(0, n) + '…' : s
  }

  // ---------- 找元素 ----------
  function findInput() {
    const ta = Array.from(document.querySelectorAll('textarea')).filter(isVisible)
    if (ta.length) return ta[ta.length - 1]
    const ce = Array.from(document.querySelectorAll('[contenteditable="true"]')).filter(isVisible)
    return ce.length ? ce[ce.length - 1] : null
  }

  function findSendButton(input) {
    const all = Array.from(document.querySelectorAll('button, [role="button"]')).filter(isVisible)
    const named = all.filter((el) => /发送|send/.test(labels(el)))
    if (named.length) return named[named.length - 1]
    let box = input
    for (let i = 0; i < 7 && box; i++) {
      box = box.parentElement
      if (!box) break
      const btns = Array.from(box.querySelectorAll('button, [role="button"]')).filter(isVisible)
      if (btns.length >= 1 && btns.length <= 8) {
        btns.sort((a, b) => a.getBoundingClientRect().right - b.getBoundingClientRect().right)
        return btns[btns.length - 1]
      }
    }
    return null
  }

  const textLabel = (el) =>
    [
      el.getAttribute && el.getAttribute('aria-label'),
      el.getAttribute && el.getAttribute('title'),
      (el.innerText || '').trim().slice(0, 30),
    ]
      .filter(Boolean)
      .join(' ')

  function isGenerating() {
    const all = Array.from(document.querySelectorAll('button, [role="button"]')).filter(isVisible)
    return all.some((el) => /停止|stop/i.test(textLabel(el)) && !/朗读|播放/.test(textLabel(el)))
  }

  function lastMarkdown() {
    const md = Array.from(document.querySelectorAll(MD_SEL))
    return md.length ? md[md.length - 1] : null
  }

  function revealToolbar(node) {
    let n = node
    for (let i = 0; i < 5 && n; i++) {
      for (const t of ['pointerover', 'mouseover', 'mouseenter', 'mousemove']) {
        n.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }))
      }
      n = n.parentElement
    }
  }

  // 只认「真正的按钮」，而且文字必须正好是朗读/停止朗读/停止播放。
  // 以前那版会匹配「类名里带 tts 的任何元素」，结果抓到的是 tts-engine 那种大容器，
  // 点上去当然没反应 —— 这就是「找不到朗读按钮 / 点了没用」的元凶。
  function looksLikeRead(el) {
    const tag = el.tagName ? el.tagName.toLowerCase() : ''
    const role = (el.getAttribute && el.getAttribute('role') ? el.getAttribute('role') : '').toLowerCase()
    if (tag !== 'button' && role !== 'button') return false
    const a = (el.getAttribute('aria-label') || '').trim()
    const t = (el.getAttribute('title') || '').trim()
    const txt = (el.innerText || '').trim()
    const dt = (el.getAttribute('data-testid') || '').toLowerCase()
    return (
      a === '朗读' ||
      t === '朗读' ||
      txt === '朗读' ||
      a === '停止朗读' ||
      t === '停止朗读' ||
      a === '停止播放' ||
      t === '停止播放' ||
      dt.indexOf('tts') >= 0 ||
      /read aloud|read-aloud/i.test(a) ||
      /read aloud|read-aloud/i.test(t)
    )
  }

  function pickRead(root) {
    if (!root) return null
    const hits = Array.from(root.querySelectorAll('*')).filter(looksLikeRead)
    if (!hits.length) return null
    const vis = hits.filter(isVisible)
    return (vis.length ? vis : hits).pop()
  }

  // 最后那条的「朗读」按钮在不在？DeepSeek 对正在生成的消息不挂工具条，
  // 所以它一出现就说明这条定稿了 —— 而工具条出现本身就是一次页面变化，
  // 不用等被 Chrome 掐慢的定时器，后台也一样立刻能判出来。
  function readReadyNearLast() {
    const last = lastMarkdown()
    if (!last) return false
    let n = last
    for (let i = 0; i < 6 && n; i++) {
      const hit = pickRead(n)
      if (hit) {
        try {
          // 必须在最后这条「之后」—— 否则可能是上一条的按钮
          return !!(last.compareDocumentPosition(hit) & Node.DOCUMENT_POSITION_FOLLOWING)
        } catch (e) {
          return false
        }
      }
      n = n.parentElement
    }
    return false
  }

  async function findReadButton() {
    const last = lastMarkdown()
    // 先直接找 —— 等回复那一步已经确认「按钮挂出来了」，所以绝大多数情况这里一击即中，
    // 不用划鼠标、不用等那 0.4 秒
    const quickSearch = () => {
      let n = last
      for (let i = 0; i < 6 && n; i++) {
        const hit = pickRead(n)
        if (hit) return hit
        n = n.parentElement
      }
      return pickRead(document)
    }
    const quick = quickSearch()
    if (quick) return quick
    // 没找到才划鼠标让工具条浮出来，再找一遍
    if (last) {
      revealToolbar(last)
      await sleep(400)
      const second = quickSearch()
      if (second) return second
    }
    // 还没找到：试着点开「更多」再看一次
    if (last) {
      let n = last
      for (let i = 0; i < 4 && n; i++) {
        const more = Array.from(n.querySelectorAll('button, [role="button"], [aria-label], [title]'))
          .filter((el) => isVisible(el) && /更多|more|⋯|\.\.\./.test(labels(el)))
          .pop()
        if (more) {
          more.click()
          await sleep(600)
          const hit = pickRead(document)
          if (hit) return hit
        }
        n = n.parentElement
      }
    }
    throw fail('没找到「朗读」按钮', diagnostics(last))
  }

  // 播放中会变成「停止朗读」
  function playingMark() {
    for (const el of document.querySelectorAll('[aria-label], [title], button, [role="button"]')) {
      if (/停止朗读|停止播放/.test(attrs(el))) return true
    }
    return false
  }

  // ---------- 主流程 ----------
  // 盯页面变化来判断「复述完了没」——比定时器靠谱，窗口最小化/后台也不会被掐慢
  async function waitForReply(beforeText, beforeCount, beforeNode, timeoutMs) {
    const t0 = Date.now()
    let last = ''
    let lastChange = Date.now()
    let same = 0
    let appeared = false
    let done = null
    let kick = null
    const evaluate = () => {
      if (done) return
      const nodes = document.querySelectorAll(MD_SEL)
      const node = nodes.length ? nodes[nodes.length - 1] : null
      const cur = node ? (node.innerText || '').trim() : ''
      // 主判据：末尾换成了一条全新的 markdown，而且它的朗读按钮已经挂出来了
      //（流式生成中的消息没有工具条）—— 这一下本身就是页面变化，不用等定时器
      if (node && node !== beforeNode && cur && !isGenerating() && readReadyNearLast()) {
        last = cur
        done = cur
        return
      }
      const fresh = cur && (nodes.length > beforeCount || cur !== beforeText)
      if (!fresh) return
      appeared = true
      if (cur !== last) {
        last = cur
        lastChange = Date.now()
        same = 0
        return
      }
      same++
      const quiet = Date.now() - lastChange
      // 主要判据：文字没变 + DeepSeek 把「停止生成」收掉了 —— 那一下本身就是页面变化，
      // 所以后台标签页里也立刻能判出来，不用等被掐慢的定时器。
      if ((!isGenerating() && same >= 2) || quiet >= 2500) done = cur
    }
    const obs = new MutationObserver(() => {
      evaluate()
      if (kick) clearTimeout(kick)
      kick = setTimeout(evaluate, 1900)
    })
    try {
      obs.observe(document.body, { childList: true, subtree: true, characterData: true })
    } catch (e) {}
    let shownLen = -1
    try {
      while (!done && !cancelWanted && Date.now() - t0 < (timeoutMs || 200000)) {
        evaluate()
        const secs = Math.round((Date.now() - t0) / 1000)
        const want = appeared
          ? '等 DeepSeek 复述…（已收到 ' + last.length + ' 字）'
          : '已发出，等 DeepSeek 回话…（' + secs + ' 秒）'
        if (want !== status) {
          status = want
          noteUntil = Date.now() + 20000
          paint()
        }
        await sleep(500)
      }
    } finally {
      if (kick) clearTimeout(kick)
      obs.disconnect()
    }
    return done || (appeared ? last : null)
  }

  function readWarning() {
    const txt = document.body.innerText || ''
    for (const w of ['朗读已达今日限额', '朗读失败', '当前语言暂不支持朗读', '该音色已下线', '获取音色列表失败']) {
      if (txt.indexOf(w) >= 0) return w
    }
    return null
  }

  async function speak(text) {
    const input = findInput()
    if (!input) throw fail('没找到对话框', dump(document, 20).join(' ;; '))
    // 发送前先记住「现在末尾是哪一条」——新回复是一条全新的 markdown 节点，
    // 靠「节点换人了」来认，比靠字数/条数稳得多（秒回的回复会把条数基准冲掉）
    const before = lastMarkdown()
    const beforeText = before ? (before.innerText || '').trim() : ''
    const beforeCount = document.querySelectorAll(MD_SEL).length
    const payload = PREFIX + text

    input.focus()
    setNativeValue(input, payload)
    await sleep(250)

    key(input, 'keydown')
    key(input, 'keypress')
    key(input, 'keyup')
    await sleep(900)
    const clearedByEnter = readInput(input) !== payload
    if (!clearedByEnter) {
      const btn = findSendButton(input)
      if (btn) {
        btn.click()
        await sleep(900)
      }
    }
    const cleared = readInput(input) !== payload

    // 发出去之后、等界面稳一下，再记「之前是什么样」——
    // 不然发送过程本身带来的渲染会被当成「DeepSeek 回复好了」
    status = '等 DeepSeek 复述…'
    paint()
    const reply = await waitForReply(beforeText, beforeCount, before)
    if (cancelWanted) throw fail('已取消')
    if (!reply) {
      throw fail(
        '没发出去',
        '清空=' + clearedByEnter + '/' + cleared + ' | 输入框还剩=' + readInput(input).slice(0, 30) + ' | ' + diagnostics(before),
      )
    }

    status = '点朗读…'
    paint()
    scrollToBottom()
    const btn = await findReadButton()
    btn.click()
    await sleep(800)
    // 页面上出现「限额」这类提示只当备注，不当结论 ——
    // 它可能是之前留下的、也可能弹一下又好了。真正的结论看有没有出声。
    lastWarning = readWarning()
    return lastWarning ? '页面提示：' + lastWarning : null
  }

  // 浏览器给的「这个标签页在出声吗」——比看图标准多了
  async function askAudible() {
    const r = await tell({ type: 'audible' })
    return !!(r && r.ok && r.data && r.data.audible)
  }

  function findReadOrStop() {
    const hits = Array.from(document.querySelectorAll('[aria-label], [title], button, [role="button"]')).filter((el) =>
      /^(朗读|停止朗读|停止播放)$/.test(((el.getAttribute('aria-label') || el.getAttribute('title') || '') + '').trim()),
    )
    const vis = hits.filter(isVisible)
    return (vis.length ? vis : hits).pop() || null
  }

  // 盯播放：第一次点经常只转图标不出声（DeepSeek 那边的解码资源还没热），
  // 所以静着就自动「停一下再点一次」——就是她手动发现的那个办法。
  // 成败以「浏览器说这个标签页到底有没有出声」为准，不看页面上出现了什么字。
  function waitPlayback(itemId) {
    return new Promise((resolve) => {
      if (playTimer) clearInterval(playTimer)
      let reported = false
      let quiet = 0
      let waited = 0
      let retried = false
      playTimer = setInterval(async () => {
        if (cancelWanted) {
          clearInterval(playTimer)
          playTimer = null
          resolve({ ok: false, why: '已取消' })
          return
        }
        waited++
        noteUntil = Date.now() + 15000
        if (await askAudible()) {
          quiet = 0
          if (!reported) {
            reported = true
            status = '出声了'
            paint()
            await tell({ type: 'playing', id: itemId, on: true })
            // 一出声音就算成功，立刻回执；后面继续盯着，等它念完再报「停」
            resolve({ ok: true })
          } else if (waited % 25 === 0) {
            // 心跳：告诉宿主「我还在响」，免得页面刷新后那边永远以为在响
            await tell({ type: 'playing', id: itemId, on: true })
          }
          return
        }
        quiet++
        if (reported && quiet >= 3) {
          clearInterval(playTimer)
          playTimer = null
          status = '念完了'
          paint()
          await tell({ type: 'playing', id: itemId, on: false })
          return
        }
        if (!reported && !retried && waited >= 6) {
          retried = true
          status = '没出声，重来一次…'
          paint()
          const stopBtn = findReadOrStop()
          if (stopBtn) stopBtn.click()
          await sleep(900)
          const playBtn = findReadOrStop()
          if (playBtn) playBtn.click()
        } else if (!reported && retried && waited >= 18) {
          clearInterval(playTimer)
          playTimer = null
          status = '点了朗读但没出声'
          paint()
          await tell({ type: 'playing', id: itemId, on: false })
          resolve({ ok: false, why: '点了朗读但没出声', detail: lastWarning ? '页面提示：' + lastWarning : null })
        }
      }, 1000)
    })
  }

  async function stopReading() {
    for (const el of document.querySelectorAll('[aria-label], [title], button, [role="button"]')) {
      if (/停止朗读|停止播放/.test(attrs(el))) {
        el.click()
        return true
      }
    }
    return false
  }

  // 按停止 = 不想听了：队列由宿主那边直接清掉，扩展不再去动开关

  // 长回复的时候，最后那条可能在屏幕外面，按钮就找不着 —— 先把它拉进视野
  function scrollToBottom() {
    try {
      const nodes = document.querySelectorAll(MD_SEL)
      const last = nodes.length ? nodes[nodes.length - 1] : null
      if (!last) return
      let n = last
      for (let i = 0; i < 8 && n; i++) {
        if (n.scrollHeight && n.scrollHeight - n.clientHeight > 20) n.scrollTop = n.scrollHeight
        n = n.parentElement
      }
      if (last.scrollIntoView) last.scrollIntoView({ block: 'end', inline: 'nearest' })
    } catch (e) {}
  }

  async function tell(msg) {
    try {
      return await chrome.runtime.sendMessage(msg)
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) }
    }
  }

  async function ack(id, ok, error, detail) {
    await tell({ type: 'ack', payload: { id: id, ok: ok, error: error || null, detail: detail || null } })
  }

  async function handle(item) {
    try {
      const note = await speak(item.text)
      const verdict = await waitPlayback(item.id)
      const detail = [note, verdict.detail].filter(Boolean).join(' | ')
      await ack(item.id, verdict.ok, verdict.ok ? null : verdict.why, detail || null)
      status = verdict.ok ? '念完了' : '没念成：' + verdict.why
    } catch (e) {
      await ack(item.id, false, (e && e.message) || String(e), e && e.detail)
      status = '没念成：' + ((e && e.message) || e)
    }
    paint()
  }

  async function loop() {
    while (!dead) {
      try {
        // 看门狗：万一 busy 卡住超过两分半，自己复位，免得永远举着「正在念」
        if (busy && busySince && Date.now() - busySince > 150000) {
          busy = false
          cancelWanted = true
          status = '卡太久了，我自己复位了'
          noteUntil = Date.now() + 8000
        }
        const res = await tell({ type: 'poll', client: CLIENT })
        if (!res || !res.ok) {
          status = '连不上朗读桥：' + ((res && res.error) || '未知')
        } else {
          auto = res.data.auto !== false
          const item = res.data.item
          if (item && item.stop) {
            cancelWanted = true
            const stopped = await stopReading()
            await ack(0, true, null, stopped ? '已停止' : '没找到停止按钮')
            status = stopped ? '停了' : '没找到停止按钮'
            noteUntil = Date.now() + 8000
          } else if (item && !busy) {
            busy = true
            busySince = Date.now()
            cancelWanted = false
            // 注意：这里不能 await —— 一 await，循环就堵住了，停止指令要等它超时才能收到
            handle(item).then(
              () => {
                busy = false
              },
              () => {
                busy = false
              },
            )
          } else if (Date.now() > noteUntil) {
            if (!auto) status = '自动朗读：关'
            else if (busy) status = '正在念…'
            else if (item) status = '有新的一句'
            else status = res.data.watching ? '待命' : '没在听任何会话'
          }
        }
      } catch (e) {
        // 任何一步出错都不能让整个循环死掉 —— 死了页面就会永远冻在上一句话上
        status = '出了点小错，我自己接着跑：' + ((e && e.message) || e)
        noteUntil = Date.now() + 6000
      }
      paint()
      await sleep(POLL_MS)
    }
  }

  // ---------- 左下角小面板 ----------
  let panel = null
  let statusEl = null
  let listEl = null
  let listOpen = false

  function paint() {
    if (!panel) return
    statusEl.textContent = (auto ? '🔊 ' : '🔇 ') + status
    statusEl.style.color = auto ? '#7fd1ae' : '#c9a0a0'
  }

  function mkButton(text, onClick) {
    const b = document.createElement('div')
    b.textContent = text
    b.dataset.xbClick = '1'
    b.style.cssText =
      'display:inline-block;margin-left:6px;padding:2px 7px;border-radius:6px;background:rgba(255,255,255,.14);' +
      'color:#e8e8e8;cursor:pointer;font-size:11px;user-select:none;white-space:nowrap'
    b.addEventListener('click', (ev) => {
      ev.stopPropagation()
      onClick()
    })
    return b
  }

  function mkLine(text, onClick) {
    const d = document.createElement('div')
    d.textContent = text
    d.style.cssText =
      'padding:3px 6px;border-radius:6px;color:' + (onClick ? '#dcdcdc' : '#8a8a8a') + ';font-size:11px;' +
      'cursor:' + (onClick ? 'pointer' : 'default') + ';white-space:nowrap;overflow:hidden;text-overflow:ellipsis'
    if (onClick) {
      d.dataset.xbClick = '1'
      d.addEventListener('mouseenter', () => (d.style.background = 'rgba(255,255,255,.12)'))
      d.addEventListener('mouseleave', () => (d.style.background = 'transparent'))
      d.addEventListener('click', (ev) => {
        ev.stopPropagation()
        onClick()
      })
    }
    return d
  }

  async function refreshRecent() {
    if (!listOpen || !listEl) return
    const res = await tell({ type: 'recent' })
    if (!res || !res.ok) {
      listEl.textContent = ''
      listEl.appendChild(mkLine('取不到清单：' + ((res && res.error) || '未知'), null))
      return
    }
    const items = (res.data && res.data.recent) || []
    listEl.textContent = ''
    if (!items.length) {
      listEl.appendChild(mkLine('（还没记下任何话）', null))
      return
    }
    for (const it of items) {
      listEl.appendChild(
        mkLine(short(it.text, 30), async () => {
          const r = await tell({ type: 'say', text: it.text })
          status = r && r.ok ? '重新排队：' + short(it.text, 14) : '没排上'
          paint()
        }),
      )
    }
  }

  function buildPanel() {
    panel = document.createElement('div')
    panel.style.cssText =
      'position:fixed;left:12px;bottom:12px;z-index:2147483000;padding:7px 10px;border-radius:10px;' +
      'background:rgba(20,20,24,.86);color:#e8e8e8;font:12px/1.6 "Microsoft YaHei",system-ui,sans-serif;' +
      'box-shadow:0 4px 14px rgba(0,0,0,.35);max-width:64vw'

    listEl = document.createElement('div')
    listEl.style.cssText =
      'display:none;max-height:42vh;overflow:auto;margin-bottom:6px;padding-bottom:4px;' +
      'border-bottom:1px solid rgba(255,255,255,.12)'
    panel.appendChild(listEl)

    const row = document.createElement('div')
    row.style.cssText = 'display:flex;align-items:center;gap:2px'

    statusEl = document.createElement('span')
    statusEl.title = '（这个页面上的开关已取消点击，防误触）'
    statusEl.style.cssText = 'user-select:none'
    statusEl.addEventListener('click', (ev) => {
      ev.stopPropagation()
    })
    row.appendChild(statusEl)

    // 三个按钮（念一句 / 重念 / 查按钮）都去掉了 —— 卡片上都有，这儿留一行状态就够。
    // 排错用的诊断留成暗门：双击这行字就回传，平时看不见。
    statusEl.addEventListener('dblclick', async (ev) => {
      ev.stopPropagation()
      await ack(0, false, '诊断', diagnostics(lastMarkdown()))
      status = '诊断已回传'
      noteUntil = Date.now() + 6000
      paint()
    })

    panel.appendChild(row)
    document.documentElement.appendChild(panel)
    makePanelDraggable()
    paint()
  }

  // 这个面板也能拖（位置记在浏览器里）—— 之前它固定在左下角，挡视线又挪不动
  const DS_POS_KEY = 'xb-tts-ds-panel-pos'
  function applyDsPos(p) {
    panel.style.left = Math.round(p.x) + 'px'
    panel.style.top = Math.round(p.y) + 'px'
    panel.style.right = 'auto'
    panel.style.bottom = 'auto'
  }
  function makePanelDraggable() {
    try {
      const saved = JSON.parse(localStorage.getItem(DS_POS_KEY) || 'null')
      if (saved && typeof saved.x === 'number' && typeof saved.y === 'number') {
        requestAnimationFrame(() => applyDsPos(saved))
      }
    } catch (e) {}
    panel.style.cursor = 'grab'
    let drag = null
    panel.addEventListener('pointerdown', (ev) => {
      if (ev.button !== undefined && ev.button !== 0) return
      const t = ev.target
      if (t && t.closest && t.closest('[data-xb-click]')) return
      const r = panel.getBoundingClientRect()
      drag = { sx: ev.clientX, sy: ev.clientY, x: r.left, y: r.top, moved: false }
      panel.style.cursor = 'grabbing'
      try {
        panel.setPointerCapture(ev.pointerId)
      } catch (e) {}
    })
    panel.addEventListener('pointermove', (ev) => {
      if (!drag) return
      const dx = ev.clientX - drag.sx
      const dy = ev.clientY - drag.sy
      if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true
      if (drag.moved) applyDsPos({ x: drag.x + dx, y: drag.y + dy })
    })
    panel.addEventListener('pointerup', (ev) => {
      if (!drag) return
      const moved = drag.moved
      drag = null
      panel.style.cursor = 'grab'
      try {
        panel.releasePointerCapture(ev.pointerId)
      } catch (e) {}
      if (moved) {
        const r = panel.getBoundingClientRect()
        try {
          localStorage.setItem(DS_POS_KEY, JSON.stringify({ x: Math.round(r.left), y: Math.round(r.top) }))
        } catch (e) {}
      }
    })
    panel.addEventListener('pointercancel', () => {
      drag = null
      panel.style.cursor = 'grab'
    })
  }

  // 页面刚加载时先报一次「没在响」：万一上次刷新时正响着，宿主那边的状态得清掉
  tell({ type: 'playing', id: 0, on: false })
  buildPanel()
  setInterval(refreshRecent, 3000)
  loop()
})()
