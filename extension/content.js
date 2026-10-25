// DSH 朗读桥 · 页面端（跑在 chat.deepseek.com 上）
// 流程：取到一句话 → 输进对话框发出去 → 等 DeepSeek 复述完 → 点「朗读」→ 回执。
// 判断「发出去了没有」以「有没有新的回复」为准，不看输入框清没清空（那玩意儿不准）。
// 左下角小面板：只显示一行状态（双击它可以把诊断信息回传给宿主，排错用）。

;(() => {
  const POLL_MS = 1200
  // ⚠⚠⚠ 2026-10-12 她要的（**这一版是她专用的，不往外发** ✗）：大肥鱼爱发颜文字，
  //   可朗读那边是**一字不差全念**、它自己不会判断 → 有时不念、有时念成「欧米伽」很怪 ✗
  //   → 就在最前面这句里交代清楚：表情、颜文字、特殊符号**不用重复，跳过就行** ✓
  //   （宿主那边另有一道「去颜文字」兜底 ✓ 就算它没听话，也不会被念出来 ✓）
  const PREFIX =
    '请只原样重复下面这一段，不要加任何自己的话，也不要解释。\n' +
    '里面的表情、颜文字和特殊符号（比如 (´｡• ω •｡`)、★、♡、～、Ω 这一类）不用重复，跳过就行：\n\n'
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
  const PB = self.__ttsPlayback // playback.js（manifest 里排在本文件前面）
  let curWait = null // 正在盯的那次播放（同一时刻只有一个）
  let handleGen = 0 // 第几条；旧条目迟到的收尾不许动新条目的 busy/状态
  let noteUntil = 0
  let cancelWanted = false
  let busySince = 0
  let lastWarning = null
  let curBase = null // 这次是哪个窝（3080 还是 43129）
  let curJob = null // 正在处理的那条：{ gen, base } —— 看门狗回执要写回它自己的窝

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
    // ⚠ 2026-10-03：写上「朗读」但后面带了别的字（「朗读这条」「朗读回复」）也要认 ——
    //   原来只认**一字不差**的「朗读」，DeepSeek 稍微改一下文案就整条找不到了 ✗
    //   （「停止…」的按钮要排除，那是正在出声时的状态）
    const 像朗读 = (s) => !!s && s.indexOf('朗读') >= 0 && s.indexOf('停止') < 0
    return (
      a === '朗读' ||
      t === '朗读' ||
      txt === '朗读' ||
      像朗读(a) ||
      像朗读(t) ||
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

  // ⚠⚠⚠ 按钮必须属于**最后这一条** —— 判法跟 readReadyNearLast 一样：
  //   按钮在文档里的位置必须在 last **之后** ✓
  //   不这么判的后果（她实测踩到的）：被拦时**最后这条没有朗读按钮**，
  //   它就一路往上找、最后全页面找 → 点到**上一条**的朗读，
  //   把**旧的内容**念出来 —— 比不弹提示还糟 ✗✗
  function 属于最后这条(hit, last) {
    if (!hit || !last) return false
    try {
      return !!(last.compareDocumentPosition(hit) & Node.DOCUMENT_POSITION_FOLLOWING)
    } catch (e) {
      return false
    }
  }

  // ⚠⚠⚠ 2026-10-03 改（她报的「内容发出去了，却报拦住、也不去点，得自己手点」）：
  //   原来这里**只找一轮**（直接找 → 划鼠标 400 毫秒 → 展开「更多」），前后大约一秒；
  //   找不到就报「被拦了」。可她撞到的正是这一条：**复述其实已经好了**（话也发出去了），
  //   只是工具条还没挂出来（长段落更慢）→ 报「被拦了」、也不去点；
  //   她过一会儿自己手点反而成 —— 因为那会儿按钮已经出来了 ✗✗
  //   → 现在改成**耐心找**：最多找约 15 秒，每一轮都滚到底、重新划一遍鼠标；
  //     真的一直没有，才说「没找到朗读按钮」——
  //     **不再把「按钮没出来」硬说成「被拦」（那是两码事，混着说她也没法分辨）** ✓
  async function findReadButton(check) {
    const 只看最后这条 = (last, root) => {
      const hit = pickRead(root || document)
      return 属于最后这条(hit, last) ? hit : null
    }
    // 先直接找 —— 等回复那一步多半已经确认「按钮挂出来了」，所以大多数情况这里一击即中，
    // 不用划鼠标、不用等那 0.4 秒
    const 快找 = (last) => {
      let n = last
      for (let i = 0; i < 6 && n; i++) {
        const hit = pickRead(n)
        if (属于最后这条(hit, last)) return hit
        n = n.parentElement
      }
      return 只看最后这条(last)
    }
    const t0 = Date.now()
    let 轮 = 0
    while (true) {
      check()
      轮++
      const last = lastMarkdown()
      const quick = 快找(last)
      if (quick) return quick
      // 没找到：滚到底 + 划鼠标让工具条浮出来，再找一遍
      if (last) {
        scrollToBottom()
        revealToolbar(last)
        await sleep(400)
        check()
        const second = 快找(last)
        if (second) return second
      }
      // 还没找到：试着点开「更多」再看一次（只在前两轮点，免得点开又点关上）
      if (last && 轮 <= 2) {
        let n = last
        for (let i = 0; i < 4 && n; i++) {
          const more = Array.from(n.querySelectorAll('button, [role="button"], [aria-label], [title]'))
            .filter((el) => isVisible(el) && /更多|more|⋯|\.\.\./.test(labels(el)))
            .pop()
          if (more) {
            check()
            more.click()
            await sleep(600)
            check()
            const hit = 只看最后这条(last)
            if (hit) return hit
          }
          n = n.parentElement
        }
      }
      if (Date.now() - t0 > 15000) throw fail('没找到朗读按钮')
      await sleep(400)
    }
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
  // ⚠⚠ 页面里「被拦」那句话出现了几次 —— 用**数量变化**判「新出现」✓
  //   为什么要数数量：页面上**以前**的对话里可能就有同样的话（她聊过一次），
  //   光判「有没有」会一直误报 → 只有**比发之前多出来**才算这次被拦 ✗
  function countRefusal(t) {
    const s = String(t || '')
    let n = 0
    for (const w of REFUSAL_WORDS) {
      let i = -1
      while ((i = s.indexOf(w, i + 1)) >= 0) n++
    }
    return n
  }
  // 被拦时 DeepSeek **不挂朗读按钮**，所以「等按钮」那条判据永远不成立 ——
  //   必须另外从**页面文字**上认它，不能只等 markdown 节点 ✓
  //   （认出来就返回这个记号；以前是个全局标记，旧条目迟到的判定会改到新条目头上 ✗）
  const 被拦记号 = '__被拦__'

  // isActive：这条还算不算数（被停止 / 看门狗复位 / 新的一条接替就不算了）——
  //   不算数就立刻收手，不再认页面上的新回复（那可能是下一条的）✓
  async function waitForReply(beforeText, beforeCount, beforeNode, timeoutMs, 拒绝, isActive) {
    const t0 = Date.now()
    let last = ''
    let lastChange = Date.now()
    let same = 0
    let appeared = false
    let done = null
    let kick = null
    const 我方词 = 拒绝 && typeof 拒绝.我方词 === 'number' ? 拒绝.我方词 : 0
    const 页基准 = 拒绝 && typeof 拒绝.页基准 === 'number' ? 拒绝.页基准 : null
    const evaluate = () => {
      if (done || !isActive()) return
      // ⚠⚠⚠ 先认「被拦」—— 这条要放在**最前面**，而且**不依赖 markdown 节点**：
      //   被拦时没有朗读按钮、主判据永远不成立，会一路等到超时（200 秒）✗
      //   它拒绝时，页面上会多出那句
      //   「你好，这个问题我暂时无法回答，让我们换个话题再聊聊吧。」
      // ⚠ 2026-10-03 把判据收紧成两条（原来只看整页数量，会被我们自己发过去的那段带偏）：
      //   ① 末尾这条**新复述**里的拒绝词，比我们发过去的原文**还多** → 它自己加了那句拒绝 ✓
      //      （原文对白里本来就有「换个话题」这种话，复述出来一模一样 → 差是 0，不算 ✗）
      //   ② 新回复还没挂出来时，整页多出来的拒绝词要**超过我们那段话本身能带来的**才算 ✓
      if (页基准 !== null) {
        const nodes0 = document.querySelectorAll(MD_SEL)
        const node0 = nodes0.length ? nodes0[nodes0.length - 1] : null
        const cur0 = node0 && node0 !== beforeNode ? (node0.innerText || '').trim() : ''
        const 它多出来的 = cur0 ? countRefusal(cur0) - 我方词 : 0
        const 整页多出来的 = countRefusal(document.body.innerText || '') - 页基准 - 我方词
        if (它多出来的 > 0 || (!cur0 && 整页多出来的 > 0)) {
          done = 被拦记号
          return
        }
      }
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
      while (!done && isActive() && Date.now() - t0 < (timeoutMs || 200000)) {
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

  // ⚠⚠ 复述被拦：有些内容 DeepSeek 不肯原样重复，它会改口说一句拒绝 ——
  //   原话是：「你好，这个问题我暂时无法回答，让我们换个话题再聊聊吧。」
  //   这时候它**根本没在复述**，念出来等于念了句拒绝给她听，
  //   而旧代码看不出来，照点朗读、状态还写「念完了」→ 她以为没事 ✗
  //   → 认出来，卡片上就写「没成：被拦了」✓
  //
  //   ⚠⚠ 只认**它自己那套话**，不许拿「无法」「不能」这种通用词去撞 ——
  //     正文里本来就可能出现（小说对白、旁白），撞了就误报 ✗
  //   ⚠⚠ 而且**还要看我们发过去的那段里有没有**：
  //     要是原文自己就写着「换个话题」，那复述里出现它是**对的**，不能算被拦
  //     → 所以「回复里有、发过去的里没有」才算 ✓
  const REFUSAL_WORDS = [
    '暂时无法回答',
    '换个话题',
    '换一个话题',
    '聊点别的',
    '我们聊别的',
    '这个话题我不能',
    '这个问题我不能',
  ]
  function looksLikeRefusal(t) {
    const s = String(t || '')
    for (const w of REFUSAL_WORDS) if (s.indexOf(w) >= 0) return w
    return null
  }

  // isActive：这条还算不算数。每个 await 回来、在动页面（发送 / 点朗读）或改共享状态之前都要再问一次 ——
  //   看门狗复位 / 按了停止之后，旧条目慢吞吞醒过来，不许去点**新条目**的按钮 ✗
  async function speak(text, isActive) {
    const check = () => {
      if (!isActive()) throw fail('已取消')
    }
    check()
    const input = findInput()
    if (!input) throw fail('没找到对话框', dump(document, 20).join(' ;; '))
    // 发送前先记住「现在末尾是哪一条」——新回复是一条全新的 markdown 节点，
    // 靠「节点换人了」来认，比靠字数/条数稳得多（秒回的回复会把条数基准冲掉）
    const before = lastMarkdown()
    const beforeText = before ? (before.innerText || '').trim() : ''
    const beforeCount = document.querySelectorAll(MD_SEL).length
    // ⚠⚠ 发之前先数一下页面上「拒绝词」有几个 ——
    //   发完比这个数多，才可能是这次被拦的 ✓（光判「有没有」会被以前的对话误报）
    // ⚠ 2026-10-03：我们自己发过去的那段**也会显示在页面上**（用户消息一条、复述再一条），
    //   所以要把「我方词数」一起交给判据，让它扣掉这一截（见 waitForReply 里那两条）✗
    const beforeRefusal = countRefusal(document.body.innerText || '')
    const payload = PREFIX + text
    const 我方词 = countRefusal(payload)

    input.focus()
    setNativeValue(input, payload)
    await sleep(250)
    check()

    key(input, 'keydown')
    key(input, 'keypress')
    key(input, 'keyup')
    await sleep(900)
    check()
    const clearedByEnter = readInput(input) !== payload
    if (!clearedByEnter) {
      const btn = findSendButton(input)
      if (btn) {
        btn.click()
        await sleep(900)
        check()
      }
    }
    const cleared = readInput(input) !== payload

    // 发出去之后、等界面稳一下，再记「之前是什么样」——
    // 不然发送过程本身带来的渲染会被当成「DeepSeek 回复好了」
    status = '等 DeepSeek 复述…'
    paint()
    // ⚠⚠⚠ 2026-10-12 修（她报的「点了网页一点反应都没有」）
    //   这里第 4 个参数是**超时**，原来传的是 `undefined` →
    //   函数内部就用了默认值 **200 秒** ✗（它自己的注释写着「会一路等到超时（200 秒）」）
    //   → 她看到的就是"干等三分多钟、什么都不发生"✓ 而我在 25 秒/40 秒就去读记录 ✗ 当然读不到 ✓
    //   改成 45 秒：到点就走到下面的 fail('没发出去', diagnostics…) ✓
    //   那一报会把页面现场带回来（输入框还剩什么、有没有 node、朗读按钮在不在 ……）✓
    const reply = await waitForReply(
      beforeText,
      beforeCount,
      before,
      45000,
      {
        页基准: beforeRefusal,
        我方词: 我方词,
      },
      isActive,
    )
    check()
    // ⚠⚠⚠ 被拦了 —— 这条要**放在「没发出去」前面**判：
    //   被拦时没有朗读按钮、可能连 markdown 节点都没有 → reply 会是 null，
    //   走下面那条就会误报成「没发出去」，她看到的提示就是错的 ✗
    if (reply === 被拦记号) throw fail('被拦了')
    if (!reply) {
      throw fail(
        '没发出去',
        '清空=' + clearedByEnter + '/' + cleared + ' | 输入框还剩=' + readInput(input).slice(0, 30) + ' | ' + diagnostics(before),
      )
    }

    status = '点朗读…'
    paint()
    // ⚠⚠ 先看看它是不是在拒绝，再点朗读 ✗
    //   复述被拦时它回的是「…暂时无法回答，让我们换个话题再聊聊吧」——
    //   那不是复述，念出来是念了句拒绝给她听，不如**别念、直接告诉她** ✓
    //   ⚠ 判断两头看：**回复里有、发过去的原文里没有** 才算被拦 ——
    //     原文自己就写着「换个话题」（小说对白）的话，复述里出现是对的 ✗
    const 拦的词 = looksLikeRefusal(reply)
    if (拦的词 && !looksLikeRefusal(text)) {
      // ⚠ 话要短 —— 她说的：「太长了，就说被拦了就行」✗
      //   卡片上显示成「没成：被拦了」，一行看完 ✓
      throw fail('被拦了')
    }
    scrollToBottom()
    const btn = await findReadButton(check)
    check()
    btn.click()
    await sleep(800)
    check()
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
  // ⚠ 一出声**不算完**：要等它真念完（连续静 3 次）才回执，否则下一条会把这一条打断 ✗
  //   具体规则在 playback.js（能拿假时钟测）；这里只接上页面这头的手脚。
  // base / isActive 都是这一条进门时定下的：旧条目的 playing 不许写到另一个窝，也不许动新条目的状态
  function waitPlayback(itemId, base, isActive) {
    if (curWait) curWait.cancel('被新的一条接替')
    const w = PB.createPlaybackWait({
      isCancelled: () => !isActive(),
      askAudible: askAudible,
      onTick: () => {
        if (!isActive()) return
        noteUntil = Date.now() + 15000
        // 念长段落会超过看门狗的 20 秒 —— 还在正常盯着就续上，免得被当成卡死
        if (busy) busySince = Date.now()
      },
      onStatus: (s) => {
        if (!isActive()) return
        status = s
        paint()
      },
      onPlaying: (on) => tell({ type: 'playing', id: itemId, on: on, base: base }),
      retry: async () => {
        if (w.settled || !isActive()) return
        const stopBtn = findReadOrStop()
        if (stopBtn) stopBtn.click()
        await sleep(900)
        if (w.settled || !isActive()) return // 这 0.9 秒里被停止/取消了，就别再点开
        const playBtn = findReadOrStop()
        if (playBtn) playBtn.click()
      },
      warning: () => lastWarning,
    })
    curWait = w
    return w.promise.then((v) => {
      if (curWait === w) curWait = null
      return v
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

  // base：回执写回哪个窝。条目 / 停止 / 看门狗都传自己进门时记下的那个；不传才用当前的（诊断之类）
  async function ack(id, ok, error, detail, base) {
    await tell({
      type: 'ack',
      payload: { id: id, ok: ok, error: error || null, detail: detail || null, base: base === undefined ? curBase : base },
    })
  }

  // 念 → 等**真念完** → 才回执（见 playback.js 的 runItem）
  // gen 是这一条的令牌：看门狗复位 / 新的一条接替后就失效；按了停止也算不再有效
  async function handle(item, gen, base) {
    const isActive = () => gen === handleGen && !cancelWanted
    // 看门狗复位后又来了新的一条：旧条目就算慢吞吞走到这一步，也不许去顶掉新条目的播放
    const wait = (id) =>
      gen === handleGen ? waitPlayback(id, base, isActive) : Promise.resolve({ ok: false, why: '被新的一条接替' })
    // 失败回执照发（宿主要知道这条没念成），只是写回它自己的窝
    const s = await PB.runItem(item, {
      speak: (text) => speak(text, isActive),
      waitPlayback: wait,
      ack: (id, ok, error, detail) => ack(id, ok, error, detail, base),
    })
    if (gen !== handleGen) return
    status = s
    paint()
  }

  // 看门狗复位：不光清 busy —— 当前这条的令牌作废、在盯的播放了结、正在响的停掉，
  // 旧条目再醒过来也动不了页面、改不了新条目的状态 ✓
  function abandonCurrent() {
    const job = curJob
    curJob = null
    handleGen++
    busy = false
    busySince = 0
    cancelWanted = true
    if (curWait) curWait.cancel('卡太久了，已复位')
    const base = job ? job.base : curBase
    // stopReading 是 async：里面抛错不会被同步 try 接住，变成没人管的 rejection ✗
    // 这里显式接住，只往卡住那条自己的窝报一句诊断；不动 status / paint（别盖掉新条目的界面），也不重试去点 ✓
    stopReading().catch((e) => {
      ack(0, false, '复位时停止朗读失败：' + ((e && e.message) || String(e)), null, base).catch(() => {})
    })
    return base
  }

  // ⚠⚠⚠ 2026-10-12：**独立的看门狗**（关键：不能放在 loop 里面 ✗）
  //   上一版我写在 loop 的循环体里 —— 可 loop 一旦在某个 await 上卡住，
  //   那个判断就**永远轮不到执行** ✗ 所以它一声不吭 ✓（现在明白了 ✓）
  //   这里用独立定时器：不管 loop 卡在哪儿，到点就报现场 ✓
  setInterval(() => {
    try {
      if (!busy || !busySince || Date.now() - busySince < 20000) return
      const 卡了 = Math.round((Date.now() - busySince) / 1000)
      let 现场 = { 卡了秒: 卡了 }
      try {
        const 框 = findInput()
        const 钮 = 框 ? findSendButton(框) : null
        const 可点 = Array.from(document.querySelectorAll('button, [role="button"]')).filter(isVisible)
        现场 = {
          卡了秒: 卡了,
          地址: String(location.href || '').slice(0, 120),
          标题: String(document.title || '').slice(0, 60),
          输入框: 框 ? String(框.tagName) + ' / ' + short(框.getAttribute('placeholder') || 框.className || '', 60) : '没找到',
          发送按钮: 钮 ? short(textLabel(钮) || 钮.className || '', 60) : '没找到',
          可点个数: 可点.length,
          可点头几个: 可点.slice(0, 6).map((el) => short(textLabel(el) || el.className || '', 30)),
          正文尾巴: short(document.body.innerText || '', 200),
        }
      } catch (e2) {}
      const base = abandonCurrent()
      status = '卡太久了，我自己复位了'
      noteUntil = Date.now() + 8000
      try {
        ack(0, false, '卡住超时：' + JSON.stringify(现场), null, base)
      } catch (e3) {}
      try {
        paint()
      } catch (e4) {}
    } catch (e) {}
  }, 3000)

  async function loop() {
    while (!dead) {
      try {
        // ⚠⚠⚠ 2026-10-12：她说「跟取文字无关，是网页那边压根没反应」✗
        //   查到的：扩展**有来领**活儿 ✓ 但领走之后**连自己的报错都没走到** ✗
        //   → 说明它卡在一个"一直等、等不到、又没有超时"的地方 ✓
        //   这里把判断从 150 秒缩到 30 秒 ✓ 并且**卡住的时候把页面现场报回去** ✓
        //   （报回去就会出现在宿主的 history 里 ✓ 我一看就知道它想找什么、页面上有什么 ✓）
        if (busy && busySince && Date.now() - busySince > 30000) {
          const 卡了 = Math.round((Date.now() - busySince) / 1000)
          const base = abandonCurrent()
          status = '卡太久了，我自己复位了'
          noteUntil = Date.now() + 8000
          try {
            const 框 = findInput()
            const 钮 = 框 ? findSendButton(框) : null
            const 可点 = Array.from(document.querySelectorAll('button, [role="button"]')).filter(isVisible)
            const 现场 = {
              卡了秒: 卡了,
              地址: String(location.href || '').slice(0, 120),
              标题: String(document.title || '').slice(0, 60),
              输入框: 框 ? String(框.tagName) + ' / ' + short(框.getAttribute('placeholder') || 框.className || '', 60) : '没找到',
              发送按钮: 钮 ? short(textLabel(钮) || 钮.className || '', 60) : '没找到',
              可点个数: 可点.length,
              可点头几个: 可点.slice(0, 6).map((el) => short(textLabel(el) || el.className || '', 30)),
              正文尾巴: short(document.body.innerText || '', 200),
            }
            await ack(0, false, '卡住超时：' + JSON.stringify(现场), null, base)
          } catch (e2) {}
        }
        const res = await tell({ type: 'poll', client: CLIENT })
        if (!res || !res.ok) {
          status = '连不上朗读桥：' + ((res && res.error) || '未知')
        } else {
          auto = res.data.auto !== false
          if (res.data.base) { curBase = res.data.base }
          const item = res.data.item
          if (item && item.stop) {
            const stopBase = curBase // 停止是哪个窝发的，回执就写回哪个
            cancelWanted = true
            if (curWait) curWait.cancel('已取消')
            const stopped = await stopReading()
            await ack(0, true, null, stopped ? '已停止' : '没找到停止按钮', stopBase)
            status = stopped ? '停了' : '没找到停止按钮'
            noteUntil = Date.now() + 8000
          } else if (item && !busy) {
            busy = true
            busySince = Date.now()
            cancelWanted = false
            // 看门狗复位过的话，上一条可能还挂着在盯 —— 先了结它，别让它去点新这条的按钮
            if (curWait) curWait.cancel('被新的一条接替')
            const gen = ++handleGen
            const base = curBase // 这一条是哪个窝的：playing / ACK（包括失败）都写回这里
            curJob = { gen: gen, base: base }
            const done = () => {
              if (gen !== handleGen) return
              busy = false
              curJob = null
            }
            // 注意：这里不能 await —— 一 await，循环就堵住了，停止指令要等它超时才能收到
            handle(item, gen, base).then(done, done)
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
