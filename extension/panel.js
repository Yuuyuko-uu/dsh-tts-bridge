// DSH 朗读桥 · DSH 界面里的小卡片（由宿主插件注入到每个 DSH 窗口）
// 三行状态 + 两个清单：听谁（多选）、最爱（收藏的句子，点一下重念）。
// 整张卡片按住就能拖，位置记在浏览器里。按住状态行 0.6 秒 = 开/关自动朗读。
;(() => {
  if (window.__ttsBridgePanelLoaded) return
  window.__ttsBridgePanelLoaded = true

  const B = '/dsh-tts-bridge'
  const POS_KEY = 'xb-tts-panel-pos'
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

  let auto = true
  let openList = '' // '' | 'watch' | 'fav'
  const DEFAULT_FOLDER = 'default'
  let favView = { mode: 'folders' } // {mode:'folders'} | {mode:'items',folder} | {mode:'move',messageId}

  const el = (tag, css, text) => {
    const d = document.createElement(tag)
    if (css) d.style.cssText = css
    if (text != null) d.textContent = text
    return d
  }

  const root = el(
    'div',
    'position:fixed;right:14px;bottom:14px;z-index:2147483000;padding:7px 10px;border-radius:10px;' +
      'background:rgba(20,20,24,.82);box-shadow:0 4px 14px rgba(0,0,0,.3);max-width:64vw;' +
      'font:12px/1.6 "Microsoft YaHei",system-ui,sans-serif;color:#e8e8e8;cursor:grab;' +
      'user-select:none;opacity:.74;transition:opacity .15s;touch-action:none',
  )
  root.addEventListener('mouseenter', () => (root.style.opacity = '1'))
  root.addEventListener('mouseleave', () => (root.style.opacity = '.74'))

  const titleEl = el('div', 'font-size:11px;color:#8f8f8f', '🐳 朗读桥')
  const recentEl = el(
    'div',
    'font-size:11px;color:#b9b9b9;white-space:nowrap;overflow:hidden;text-overflow:ellipsis',
    '还没念过',
  )
  const statusEl = el('div', 'font-size:12px;white-space:nowrap;cursor:pointer', '读取中…')
  statusEl.title = '按住不放 0.6 秒：开／关自动朗读（防误触）'
  const listEl = el(
    'div',
    'display:none;max-height:34vh;overflow:auto;margin:6px 0;padding-bottom:4px;' +
      'border-top:1px solid rgba(255,255,255,.1);border-bottom:1px solid rgba(255,255,255,.1)',
  )
  const rowEl = el('div', 'display:flex;align-items:center;gap:2px')

  const mkBtn = (text, onClick) => {
    const b = el(
      'div',
      'margin-right:6px;padding:2px 7px;border-radius:6px;background:rgba(255,255,255,.14);color:#e8e8e8;' +
        'cursor:pointer;font-size:11px;white-space:nowrap',
      text,
    )
    b.dataset.xbClick = '1' // 标记成「可点的」——拖动逻辑看到它就放手
    b.addEventListener('click', (ev) => {
      ev.stopPropagation()
      onClick()
    })
    return b
  }

  const mkLine = (text, onClick) => {
    const d = el(
      'div',
      'padding:3px 6px;border-radius:6px;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' +
        'color:' +
        (onClick ? '#dcdcdc' : '#8a8a8a') +
        ';cursor:' +
        (onClick ? 'pointer' : 'default'),
      text,
    )
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

  root.appendChild(titleEl)
  root.appendChild(recentEl)
  root.appendChild(statusEl)
  root.appendChild(listEl)
  root.appendChild(rowEl)
  document.documentElement.appendChild(root)

  const hhmm = (t) => {
    try {
      return new Date(t).toLocaleTimeString().slice(0, 5)
    } catch (e) {
      return '--:--'
    }
  }
  // 几月几号几点几分 —— 收藏里用，过一阵回头看才知道是什么时候说的
  const stamp = (t) => {
    try {
      const d = new Date(t)
      const p = (n) => String(n).padStart(2, '0')
      return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
    } catch (e) {
      return ''
    }
  }
  const short = (t, n) => {
    const s = String(t || '').replace(/\s+/g, ' ').trim()
    return s.length > n ? s.slice(0, n) + '…' : s
  }

  // ---------- 拖动 ----------
  function applyPos(p) {
    root.style.left = Math.round(p.x) + 'px'
    root.style.top = Math.round(p.y) + 'px'
    root.style.right = 'auto'
    root.style.bottom = 'auto'
  }
  function clampPos(x, y) {
    const w = root.offsetWidth || 120
    const h = root.offsetHeight || 60
    return {
      x: Math.max(2, Math.min(window.innerWidth - w - 2, x)),
      y: Math.max(2, Math.min(window.innerHeight - h - 2, y)),
    }
  }
  try {
    const saved = JSON.parse(localStorage.getItem(POS_KEY) || 'null')
    if (saved && typeof saved.x === 'number' && typeof saved.y === 'number') {
      requestAnimationFrame(() => applyPos(clampPos(saved.x, saved.y)))
    }
  } catch (e) {}

  let drag = null
  root.addEventListener('pointerdown', (ev) => {
    if (ev.button !== undefined && ev.button !== 0) return
    // 落在按钮/清单行上就完全不碰拖动 —— 不然「抓住指针」会把点击吃掉
    const t = ev.target
    if (t && t.closest && t.closest('[data-xb-click]')) return
    const r = root.getBoundingClientRect()
    drag = {
      sx: ev.clientX,
      sy: ev.clientY,
      x: r.left,
      y: r.top,
      moved: false,
      onStatus: statusEl.contains(ev.target),
      t0: Date.now(),
    }
    root.style.cursor = 'grabbing'
    try {
      root.setPointerCapture(ev.pointerId)
    } catch (e) {}
  })
  root.addEventListener('pointermove', (ev) => {
    if (!drag) return
    const dx = ev.clientX - drag.sx
    const dy = ev.clientY - drag.sy
    if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true
    if (drag.moved) applyPos(clampPos(drag.x + dx, drag.y + dy))
  })
  root.addEventListener('pointerup', async (ev) => {
    if (!drag) return
    const d = drag
    drag = null
    root.style.cursor = 'grab'
    try {
      root.releasePointerCapture(ev.pointerId)
    } catch (e) {}
    if (d.moved) {
      const r = root.getBoundingClientRect()
      try {
        localStorage.setItem(POS_KEY, JSON.stringify({ x: Math.round(r.left), y: Math.round(r.top) }))
      } catch (e) {}
      return
    }
    // 要按住 0.6 秒才切换 —— 远程/放大着用的时候点一下太容易误触
    if (d.onStatus && Date.now() - d.t0 >= 600) {
      auto = !auto
      paint()
      await post('/auto', { auto: auto })
      await refreshState()
    }
  })
  root.addEventListener('pointercancel', () => {
    drag = null
    root.style.cursor = 'grab'
  })
  window.addEventListener('resize', () => {
    if (root.style.left) {
      const r = root.getBoundingClientRect()
      applyPos(clampPos(r.left, r.top))
    }
  })

  // ---------- 两个清单 ----------
  let lastSig = ''

  // quiet=true 时只在内容真变了才重建 —— 这样能实时刷新，又不会一抽一抽
  async function renderList(quiet) {
    if (!openList) {
      listEl.style.display = 'none'
      lastSig = ''
      return
    }
    listEl.style.display = 'block'

    if (openList === 'watch') {
      const r = await get('/sessions')
      if (!r || !r.ok) {
        if (quiet) return
        listEl.textContent = ''
        listEl.appendChild(mkLine('取不到会话列表', null))
        return
      }
      const watching = new Set(r.watch || [])
      const list = r.sessions || []
      const sig = 'w|' + list.map((s) => s.id + (watching.has(s.id) ? '1' : '0')).join(',')
      if (quiet && sig === lastSig) return
      lastSig = sig
      listEl.textContent = ''
      listEl.appendChild(mkLine('勾上的就会听（只能选开着的对话）', null))
      if (!list.length) {
        listEl.appendChild(mkLine('（现在没有别的对话开着）', null))
      }
      for (const s of list) {
        const name = s.title || s.id.slice(0, 20)
        listEl.appendChild(
          mkLine((watching.has(s.id) ? '☑ ' : '☐ ') + name, async () => {
            await post('/watch', { id: s.id, remove: watching.has(s.id) })
            await renderList()
            await refreshState()
          }),
        )
      }
      return
    }

    const r = await get('/favorites')
    if (!r || !r.ok) {
      if (quiet) return
      listEl.textContent = ''
      listEl.appendChild(mkLine('取不到收藏', null))
      return
    }
    const folders = r.folders || []
    const all = r.favorites || []
    const cur = favView.folder || DEFAULT_FOLDER
    const items = all.filter((f) => String(f.folder) === String(cur))
    const sig2 =
      'f|' +
      favView.mode +
      '|' +
      cur +
      '|' +
      folders.map((x) => x.id + x.name + x.count).join(',') +
      '|' +
      (favView.mode === 'items' ? items.map((f) => f.messageId + ':' + String(f.text || '').length).join(',') : '')
    if (quiet && sig2 === lastSig) return
    lastSig = sig2
    listEl.textContent = ''

    if (favView.mode === 'move') {
      listEl.appendChild(mkLine('移到哪个分区？', null))
      for (const fo of folders) {
        listEl.appendChild(
          mkLine('📁 ' + fo.name, async () => {
            await post('/move', { messageId: favView.messageId, folder: fo.id })
            favView = { mode: 'items', folder: fo.id }
            await renderList()
            await refreshState()
          }),
        )
      }
      listEl.appendChild(
        mkLine('← 返回', async () => {
          favView = { mode: 'items', folder: cur }
          await renderList()
        }),
      )
      return
    }

    if (favView.mode === 'items') {
      listEl.appendChild(
        mkLine('← 分区列表', async () => {
          favView = { mode: 'folders' }
          await renderList()
        }),
      )
      if (!items.length) {
        listEl.appendChild(mkLine('（这个分区还是空的）', null))
        return
      }
    } else {
      // 分区列表：点名字进去，✎ 改名，✕ 删除（默认分区不给删）
      for (const fo of folders) {
        const fl = el('div', 'display:flex;align-items:center;gap:4px;padding:3px 6px;border-radius:6px;font-size:11px')
        fl.dataset.xbClick = '1'
        fl.addEventListener('mouseenter', () => (fl.style.background = 'rgba(255,255,255,.12)'))
        fl.addEventListener('mouseleave', () => (fl.style.background = 'transparent'))
        const fname = el(
          'div',
          'flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#dcdcdc;cursor:pointer',
          '📁 ' + fo.name + '（' + fo.count + '）',
        )
        fname.addEventListener('click', async (ev) => {
          ev.stopPropagation()
          favView = { mode: 'items', folder: fo.id }
          await renderList()
        })
        const ren = el('div', 'color:#9fb6c9;cursor:pointer;padding:0 4px;flex:none', '✎')
        ren.title = '重命名'
        ren.addEventListener('click', async (ev) => {
          ev.stopPropagation()
          let n = ''
          try {
            n = window.prompt('把「' + fo.name + '」改成：', fo.name) || ''
          } catch (error) {
            n = ''
          }
          if (!n.trim()) return
          await post('/folder', { id: fo.id, name: n.trim() })
          await renderList()
        })
        fl.appendChild(fname)
        fl.appendChild(ren)
        if (String(fo.id) !== DEFAULT_FOLDER) {
          const del = el('div', 'color:#c9a0a0;cursor:pointer;padding:0 4px;flex:none', '✕')
          del.title = '删除分区（里面的收藏会回到默认分区，不会丢）'
          del.addEventListener('click', async (ev) => {
            ev.stopPropagation()
            await post('/folder', { remove: fo.id })
            favView = { mode: 'folders' }
            await renderList()
          })
          fl.appendChild(del)
        }
        listEl.appendChild(fl)
      }
      listEl.appendChild(
        mkLine('＋ 新建分区', async () => {
          let name = ''
          try {
            name = window.prompt('新分区叫什么名字？') || ''
          } catch (error) {
            name = ''
          }
          if (!name.trim()) return
          await post('/folder', { name: name.trim() })
          await renderList()
        }),
      )
      listEl.appendChild(
        mkLine('导出成 markdown', async () => {
          const out = ['# 朗读桥 · 收藏', '']
          for (const fo of folders) {
            const its = all.filter((f) => String(f.folder) === fo.id)
            if (!its.length) continue
            out.push('## ' + fo.name, '')
            for (const f of its) {
              out.push(
                '- ' +
                  (f.who ? '**' + f.who + '**' : '') +
                  (f.at ? '（' + stamp(f.at) + '）' : '') +
                  '：' +
                  String(f.text || '').replace(/\n+/g, ' '),
              )
            }
            out.push('')
          }
          try {
            const blob = new Blob([out.join('\n')], { type: 'text/markdown;charset=utf-8' })
            const a = document.createElement('a')
            a.href = URL.createObjectURL(blob)
            a.download = '朗读桥-收藏.md'
            document.body.appendChild(a)
            a.click()
            setTimeout(() => {
              URL.revokeObjectURL(a.href)
              a.remove()
            }, 2000)
            statusEl.textContent = '💾 导出好了（看浏览器的下载）'
          } catch (error) {
            statusEl.textContent = '导出失败了'
          }
        }),
      )
      return
    }
    for (const f of items) {
      const line = el('div', 'display:flex;align-items:center;gap:6px;padding:3px 6px;border-radius:6px;font-size:11px')
      line.dataset.xbClick = '1'
      line.addEventListener('mouseenter', () => (line.style.background = 'rgba(255,255,255,.12)'))
      line.addEventListener('mouseleave', () => (line.style.background = 'transparent'))
      const box = el('div', 'flex:1;min-width:0')
      const meta = el('div', 'font-size:10px;color:#8a8a8a', (f.who ? f.who + ' · ' : '') + stamp(f.at))
      const txt = el(
        'div',
        'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#dcdcdc;cursor:pointer',
        short(f.text, 26),
      )
      txt.addEventListener('click', async (ev) => {
        ev.stopPropagation()
        if (!f.text) {
          statusEl.textContent = '🔇 这条没存到文字'
          return
        }
        await post('/say', { text: f.text })
        statusEl.textContent = '🔊 再念一遍：' + short(f.text, 12)
        setTimeout(refreshState, 700)
      })
      const del = el('div', 'color:#c9a0a0;cursor:pointer;padding:0 4px;flex:none', '✕')
      del.title = '取消收藏'
      del.addEventListener('click', async (ev) => {
        ev.stopPropagation()
        await post('/forget', { messageId: f.messageId })
        await renderList()
        await refreshState()
      })
      const mv = el('div', 'color:#9fb6c9;cursor:pointer;padding:0 4px;flex:none', '⇄')
      mv.title = '移到别的分区'
      mv.addEventListener('click', async (ev) => {
        ev.stopPropagation()
        favView = { mode: 'move', messageId: f.messageId, folder: cur }
        await renderList()
      })
      box.appendChild(meta)
      box.appendChild(txt)
      line.appendChild(box)
      line.appendChild(mv)
      line.appendChild(del)
      listEl.appendChild(line)
    }
  }

  // 停止键放最前面 —— 从收藏里念出来的，也能在这儿一键停，不用去翻消息
  const stopBtn = mkBtn('⏸ 停止', async () => {
    await post('/stop', {})
    statusEl.textContent = '🔇 停了'
    setTimeout(refreshState, 600)
  })
  rowEl.appendChild(stopBtn)
  rowEl.appendChild(
    mkBtn('听谁 ▾', async () => {
      openList = openList === 'watch' ? '' : 'watch'
      await renderList()
    }),
  )
  rowEl.appendChild(
    mkBtn('收藏 ▾', async () => {
      const on = openList !== 'fav'
      openList = on ? 'fav' : ''
      if (on) favView = { mode: 'folders' }
      await renderList()
    }),
  )

  // ---------- 状态 ----------
  function paint() {
    statusEl.style.color = auto ? '#7fd1ae' : '#c9a0a0'
  }

  async function refreshState() {
    const st = await get('/state')
    if (!st || !st.ok) {
      statusEl.textContent = '🔇 连不上朗读桥'
      recentEl.textContent = '（插件可能没开着）'
      return
    }
    auto = st.auto !== false
    // 浏览器扩展有没有在联系我？15 秒没动静 = 没装或没开
    const extAlive = !!(st.lastNext && Date.now() - st.lastNext < 15000)
    if (!extAlive) {
      recentEl.textContent = '还差一步'
      statusEl.textContent = '⚠ 浏览器扩展还没连上 —— 看说明的第二步'
      statusEl.style.color = '#e0b070'
      stopBtn.style.opacity = '.55'
      return
    }

    const watching = (st.watching || []).length > 0

    const h = (st.history || [])[0]
    recentEl.textContent = h
      ? '最近 ' + hhmm(h.at) + '　' + (h.ok ? '念好了' : '没成：' + (h.error || '未知'))
      : '还没念过'

    stopBtn.style.opacity = st.playing ? '1' : '.55'
    let line
    if (!auto) line = '自动朗读：关'
    else if (st.playing) line = '正在出声…'
    else if (st.waiting > 0) line = '已发给 DeepSeek，等它复述…'
    else line = watching ? '待命（有新消息就念）' : '没在听任何会话'
    statusEl.textContent = (auto ? '🔊 ' : '🔇 ') + line
    paint()
  }

  setInterval(async () => {
    await refreshState()
    // 清单也实时刷，但只在内容真变了才重建 —— 不然会一抽一抽
    if (openList) await renderList(true)
  }, 2500)
  refreshState()
})()
