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

      slots.inject('conversation.chat.assistant-actions', () =>
        slots.register({ name: 'conversation.chat.assistant-actions', id: 'tts-bridge', order: 30 }, ReadAction),
      )
    }

    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
