// DSH 朗读桥 · 客户端半边（每条助手回复下面的 ▶ 朗读 / ⏸ 停止 / ♡ 收藏）
// 正式插件里没有 host.call 那种包私有通道，所以这里用同源 fetch 直接问宿主的路由。
window.__ModuleLoader__.load({
  id: 'dsh-tts-bridge',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')

    const inject = ['slots']

    const B = '/dsh-tts-bridge'
    const CSS =
      '.xb-tts-action{width:28px;height:28px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:transparent;border:none;border-radius:28px;justify-content:center;align-items:center;padding:6px;display:inline-flex}' +
      '.xb-tts-action:hover,.xb-tts-action[aria-pressed=true]{background:var(--dsw-alias-interactive-bg-hover,#f3f4f6);color:var(--dsw-alias-label-secondary,#5f6875)}' +
      '.xb-tts-action:disabled{cursor:default;opacity:.45}' +
      '.xb-tts-action--dim{opacity:.4}'

    const get = (p) =>
      fetch(B + p, { cache: 'no-store' })
        .then((r) => r.json())
        .catch(() => null)
    const post = (p, body) =>
      fetch(B + p, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
        .then((r) => r.json())
        .catch(() => null)

    const icon = (kind) => {
      if (kind === 'heart' || kind === 'heartOff') {
        return React.createElement(
          'svg',
          {
            viewBox: '0 0 16 16',
            width: 16,
            height: 16,
            fill: kind === 'heart' ? 'currentColor' : 'none',
            stroke: 'currentColor',
            strokeWidth: 1.2,
            strokeLinejoin: 'round',
          },
          React.createElement('path', {
            d: 'M8 13.4C6.6 12.4 2.3 9.4 2.3 6.4c0-1.8 1.3-3.1 2.9-3.1 1.1 0 2.1.6 2.8 1.7.7-1.1 1.7-1.7 2.8-1.7 1.6 0 2.9 1.3 2.9 3.1 0 3-4.3 6-5.7 7z',
          }),
        )
      }
      const d =
        kind === 'play' ? 'M5.6 3.6 12.2 8l-6.6 4.4z' : kind === 'pause' ? 'M6.2 3.9v8.2M9.8 3.9v8.2' : 'M4.9 4.9h6.2v6.2H4.9z'
      return React.createElement(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: 16,
          height: 16,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        },
        React.createElement('path', { d: d }),
      )
    }

    // ⭐ 设置页「朗读桥」：状态 / 收藏 / 听谁 / 最近念过的 / 版本
    //    这些接口本来就有（只给那张浮动小卡片用），这里把它们摆成能看能管的一页。
    const 更新命令 = ['dsh plugin --profile web remove dsh-tts-bridge', 'dsh plugin --profile web add dsh-tts-bridge'].join(String.fromCharCode(10))

    const 盒子 = { padding: 12, borderRadius: 10, background: 'rgba(127,127,127,.07)' }
    const 小字 = { fontSize: 12, opacity: 0.68, lineHeight: 1.55 }
    const 按钮样式 = { padding: '4px 10px', borderRadius: 6, border: '1px solid rgba(128,128,128,.35)', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 12 }
    const 输入样式 = { padding: '5px 9px', borderRadius: 6, border: '1px solid rgba(128,128,128,.35)', background: 'transparent', color: 'inherit', fontSize: 12, minWidth: 160 }

    function 时间(t) {
      try {
        const d = new Date(t)
        const p = (n) => String(n).padStart(2, '0')
        return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
      } catch (e) { return '' }
    }

    function 朗读桥页() {
      const [st, setSt] = React.useState(null)
      const [sess, setSess] = React.useState([])
      const [fav, setFav] = React.useState({ folders: [], favorites: [] })
      const [最近, set最近] = React.useState([])
      const [up, setUp] = React.useState(null)
      const [upBusy, setUpBusy] = React.useState(false)
      const [q, setQ] = React.useState('')
      const [分区, set分区] = React.useState('')
      const [新分区, set新分区] = React.useState('')
      const [说, set说] = React.useState('')

      const flash = (t) => { set说(t); setTimeout(() => set说(''), 2200) }

      const 全拉 = async () => {
        try {
          const [a, b, c, d] = await Promise.all([get('/state'), get('/sessions'), get('/favorites'), get('/recent')])
          if (a && a.ok) setSt(a)
          if (b && b.ok) setSess(b.sessions || [])
          if (c && c.ok) setFav({ folders: c.folders || [], favorites: c.favorites || [] })
          if (d && d.ok) set最近(d.recent || [])
        } catch (e) { flash('读不到宿主那边（插件在跑吗？）：' + String((e && e.message) || e)) }
      }

      React.useEffect(() => {
        全拉()
        get('/update').then((r) => setUp(r)).catch(() => {})
      }, [])

      const 查更新 = async () => {
        setUpBusy(true)
        try { setUp(await get('/update?refresh=1')) } catch (e) { setUp({ ok: false, error: String((e && e.message) || e) }) }
        setUpBusy(false)
      }
      const 切换自动 = async () => {
        await post('/auto', { auto: !(st && st.auto) })
        await 全拉()
        flash((st && st.auto) ? '自动朗读已关' : '自动朗读已开')
      }
      const 停一下 = async () => { await post('/reset', {}); await 全拉(); flash('已停下，队列也清了') }
      const 重念 = async (文本) => { await post('/say', { text: 文本 }); await 全拉(); flash('又念一遍（排在队尾）') }
      const 删收藏 = async (messageId) => { await post('/forget', { messageId }); await 全拉() }
      const 移分区 = async (messageId, folder) => { await post('/move', { messageId, folder }); await 全拉() }
      const 改听谁 = async (id, 勾着) => { await post('/watch', { id, remove: 勾着 }); await 全拉() }
      const 建分区 = async () => {
        const n = String(新分区 || '').trim()
        if (!n) return
        await post('/folder', { name: n })
        set新分区('')
        await 全拉()
        flash('分区建好了')
      }

      const 全部 = fav.favorites || []
      const 看的 = 全部.filter((f) => {
        if (分区 && String(f.folder || '') !== 分区) return false
        if (q && !(String(f.text || '') + String(f.who || '')).includes(q)) return false
        return true
      })

      const 说更新 = !up ? '正在看有没有新版…'
        : up.hasUpdate ? '仓库里已经有 v' + up.latest + ' 了'
          : up.ok ? '已经是最新版' : '暂时查不到（' + (up.error || '网络') + '）—— 这不代表没有问题'

      return React.createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 14, padding: '2px 2px 24px' } },

        React.createElement('div', { style: 小字 },
          '每条回复下面的 ▶ 朗读 / ⏸ 停止 / ♡ 收藏，以及 DSH 窗口里那张浮动小卡片，都是这个插件。这里能看全部收藏、改听哪些会话。'),

        // ── 状态 ──
        React.createElement(
          'div',
          { style: 盒子 },
          React.createElement('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 8 } }, '现在'),
          React.createElement('div', { style: { fontSize: 13, lineHeight: 1.9 } },
            '自动朗读：' + (st ? (st.auto ? '开着' : '关着') : '—') + '　·　'
            + '正在念：' + (st ? (st.playing ? '是' : '没有') : '—') + '　·　'
            + '排队：' + (st ? (st.waiting || 0) : '—') + ' 条　·　'
            + '收藏：' + (全部.length) + ' 句　·　'
            + '听 ' + (st && st.watching ? st.watching.length : 0) + ' 个会话'),
          React.createElement('div', { style: { display: 'flex', gap: 8, marginTop: 10 } },
            React.createElement('button', { style: 按钮样式, onClick: 切换自动 }, st && st.auto ? '关掉自动朗读' : '打开自动朗读'),
            React.createElement('button', { style: 按钮样式, onClick: 停一下 }, '停下并清空队列'),
            React.createElement('button', { style: 按钮样式, onClick: 全拉 }, '刷新')),
          st && st.next
            ? React.createElement('div', { style: Object.assign({}, 小字, { marginTop: 8 }) }, '队首是：「' + st.next + '…」')
            : null),

        // ── 收藏 ──
        React.createElement(
          'div',
          { style: 盒子 },
          React.createElement('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 8 } }, '收藏的句子（' + 全部.length + '）'),
          React.createElement('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 } },
            React.createElement('input', {
              style: 输入样式, placeholder: '搜句子 / 搜是谁说的', value: q,
              onChange: (e) => setQ(e.target.value),
            }),
            React.createElement('select', {
              style: 输入样式, value: 分区, onChange: (e) => set分区(e.target.value),
            },
              React.createElement('option', { value: '' }, '全部分区'),
              ...(fav.folders || []).map((f) => React.createElement('option', { key: f.id, value: String(f.id) }, f.name + '（' + f.count + '）'))),
            React.createElement('input', {
              style: 输入样式, placeholder: '新分区名', value: 新分区,
              onChange: (e) => set新分区(e.target.value),
            }),
            React.createElement('button', { style: 按钮样式, onClick: 建分区 }, '建分区')),
          看的.length === 0
            ? React.createElement('div', { style: 小字 }, 全部.length ? '这个筛选下没有句子。' : '还没有收藏。在回复下面点 ♡ 就会收到这里。')
            : 看的.map((f) => React.createElement(
              'div',
              { key: f.messageId, style: { padding: '9px 0', borderTop: '1px solid rgba(127,127,127,.14)' } },
              React.createElement('div', { style: { fontSize: 13, lineHeight: 1.6, whiteSpace: 'pre-wrap' } }, f.text || '（这句话没存下来）'),
              React.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' } },
                React.createElement('span', { style: 小字 }, (f.who || '（不知道是谁）') + '　' + 时间(f.at)),
                React.createElement('button', { style: 按钮样式, onClick: () => 重念(f.text) }, '再念一遍'),
                React.createElement('select', {
                  style: 输入样式, value: String(f.folder || ''), onChange: (e) => 移分区(f.messageId, e.target.value),
                },
                  ...(fav.folders || []).map((x) => React.createElement('option', { key: x.id, value: String(x.id) }, x.name))),
                React.createElement('button', { style: 按钮样式, onClick: () => 删收藏(f.messageId) }, '删掉'))))),

        // ── 听谁 ──
        React.createElement(
          'div',
          { style: 盒子 },
          React.createElement('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 6 } }, '听哪些会话'),
          React.createElement('div', { style: Object.assign({}, 小字, { marginBottom: 8 }) },
            '勾上的会话，它说完一整轮会自动念最后那句。只列活着的会话（关着的读不到）。'),
          sess.length === 0
            ? React.createElement('div', { style: 小字 }, '现在没有可选的会话。')
            : sess.map((x) => React.createElement(
              'label',
              { key: x.id, style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, padding: '3px 0', cursor: 'pointer' } },
              React.createElement('input', {
                type: 'checkbox', checked: !!x.watching,
                onChange: () => 改听谁(x.id, x.watching),
              }),
              React.createElement('span', null, x.title || x.id)))),

        // ── 最近念过的 ──
        React.createElement(
          'div',
          { style: 盒子 },
          React.createElement('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 6 } }, '最近念过的'),
          最近.length === 0
            ? React.createElement('div', { style: 小字 }, '还没有记录。')
            : 最近.slice(0, 20).map((r) => React.createElement(
              'div',
              { key: r.id, style: { fontSize: 12.5, lineHeight: 1.6, padding: '4px 0', borderTop: '1px solid rgba(127,127,127,.1)' } },
              React.createElement('span', { style: { opacity: 0.6 } }, 时间(r.at) + '　'),
              (r.text || '').slice(0, 90) + ((r.text || '').length > 90 ? '…' : '')))),

        // ── 版本 ──
        React.createElement(
          'div',
          { style: 盒子 },
          React.createElement('div', { style: { fontSize: 13, marginBottom: 6 } }, '插件版本 ' + ((up && up.current) || '—') + '　·　' + 说更新),
          React.createElement('button', { style: 按钮样式, disabled: upBusy, onClick: 查更新 }, upBusy ? '查…' : '检查更新'),
          (up && up.hasUpdate)
            ? React.createElement('div', null,
              React.createElement('div', { style: Object.assign({}, 小字, { margin: '8px 0 6px' }) }, '更新方法：先卸旧版再装新版（直接装可能拿到缓存里的旧副本）。'),
              React.createElement('div', { style: { fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 11.5, whiteSpace: 'pre-wrap', wordBreak: 'break-all', padding: '8px 10px', borderRadius: 7, background: 'rgba(127,127,127,.1)' } }, 更新命令),
              React.createElement('button', { style: Object.assign({}, 按钮样式, { marginTop: 8 }), onClick: () => navigator.clipboard.writeText(更新命令).catch(() => {}) }, '复制命令'))
            : null),

        React.createElement('div', { style: { fontSize: 12, opacity: 0.75, minHeight: 16 } }, 说),
      )
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return

      ctx.effect(() => {
        const style = document.createElement('style')
        style.dataset.plugin = 'tts-bridge'
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      })

      // 所有按钮共用一个轮询：现在到底有没有在出声 / 哪些被收藏了
      const store = { playing: false, favs: new Set(), subs: new Set() }
      const notify = () => {
        for (const fn of store.subs) {
          try {
            fn()
          } catch (error) {}
        }
      }
      const tick = async () => {
        const r = await get('/status')
        const playing = !!(r && r.ok && r.playing)
        if (playing !== store.playing) {
          store.playing = playing
          notify()
        }
      }
      const tickFavs = async () => {
        const r = await get('/favorites')
        if (!r || !r.ok) return
        const next = new Set((r.favorites || []).map((f) => String(f.messageId)))
        let changed = next.size !== store.favs.size
        if (!changed) {
          for (const x of next) {
            if (!store.favs.has(x)) {
              changed = true
              break
            }
          }
        }
        if (changed) {
          store.favs = next
          notify()
        }
      }
      ctx.effect(() => {
        const id = setInterval(tick, 2000)
        return () => clearInterval(id)
      })
      ctx.effect(() => {
        tickFavs()
        const id = setInterval(tickFavs, 5000)
        return () => clearInterval(id)
      })

      const mk = (label, kind, onClick, pressed, dim) =>
        React.createElement(
          'button',
          {
            type: 'button',
            className: 'xb-tts-action' + (dim ? ' xb-tts-action--dim' : ''),
            title: label,
            'aria-label': label,
            'aria-pressed': !!pressed,
            onClick: onClick,
          },
          icon(kind),
        )

      function ReadAction(props) {
        const messageId = String(props && props.messageId ? props.messageId : '')
        const sessionId = String(props && props.sessionId ? props.sessionId : '')
        const [, force] = React.useState(0)
        React.useEffect(() => {
          const fn = () => force((n) => n + 1)
          store.subs.add(fn)
          return () => store.subs.delete(fn)
        }, [])

        const onPlay = async () => {
          store.playing = true
          notify()
          await post('/speak', { sessionId: sessionId, messageId: messageId })
          tick()
        }

        // 停止：不问现在在念哪一条，就是把 DeepSeek 那边的朗读关掉
        const onStop = async () => {
          store.playing = false
          notify()
          await post('/stop', {})
          tick()
        }

        // 爱心：把这一条记成「最爱」，再点一下取消
        const isFav = store.favs.has(messageId)
        const onFav = async () => {
          const r = await post('/favorite', { sessionId: sessionId, messageId: messageId })
          if (r && r.ok) {
            if (r.on) store.favs.add(messageId)
            else store.favs.delete(messageId)
            notify()
          }
        }

        return React.createElement(
          React.Fragment,
          null,
          mk('朗读回复（DeepSeek 的声音）', 'play', onPlay, store.playing, false),
          mk('停止朗读', 'stop', onStop, store.playing, !store.playing),
          mk(isFav ? '取消收藏' : '收藏这一条', isFav ? 'heart' : 'heartOff', onFav, isFav, false),
        )
      }

      slots.inject('settings.section', () =>
        slots.register({ name: 'settings.section', id: 'tts-bridge', order: 60, label: '朗读桥' }, 朗读桥页),
      )

      slots.inject('conversation.chat.assistant-actions', () =>
        slots.register({ name: 'conversation.chat.assistant-actions', id: 'tts-bridge', order: 30 }, ReadAction),
      )
    }

    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
