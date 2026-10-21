// 插件自查更新 —— 查的是**这个插件自己的仓库**
//
// 每个插件在自己设置页放一个「检查更新」，点一下就去自己的仓库看 package.json 里的版本。
//
// 原则：
//   · 仓库地址从包里自己的 package.json 读（`repository`），不在代码里写死
//   · 只查，不装不删 —— 更新命令交给用户自己复制去跑
//   · **查不到要如实说"查不到"，绝不能显示成"已是最新"**
//   · 结果缓存 6 小时；点按钮（refresh）就绕过缓存
//
// ⚠ 内容会进客户端的一份说明：这个文件是**复制多份**到各个插件里的同一份实现，
//   只在这一个地方改了，记得同步给其它插件（别各改各的）。

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const TTL = 6 * 3600 * 1000
const TIMEOUT = 8000

function parseVer(v) {
  const s = String(v || '').trim().replace(/^v/i, '')
  const cut = s.indexOf('-')
  const core = cut >= 0 ? s.slice(0, cut) : s
  const pre = cut >= 0 ? s.slice(cut + 1) : ''
  const nums = core.split('.').map((x) => Number(x) || 0)
  return { nums: [nums[0] || 0, nums[1] || 0, nums[2] || 0], pre }
}

// 1.2.3 / v1.2.3 / 1.2.3-beta.1 都认
export function cmpVer(a, b) {
  const x = parseVer(a)
  const y = parseVer(b)
  for (let i = 0; i < 3; i++) {
    if (x.nums[i] !== y.nums[i]) return x.nums[i] > y.nums[i] ? 1 : -1
  }
  if (x.pre === y.pre) return 0
  if (!x.pre) return 1   // 正式版比预发布新
  if (!y.pre) return -1
  return x.pre > y.pre ? 1 : -1
}

function rawUrls(repo) {
  const s = String(repo || '').trim()
  const m = /github\.com[/:]([^/]+)\/([^/#?]+)/i.exec(s)
  if (!m) return []
  const owner = m[1]
  const name = m[2].replace(/\.git$/i, '')
  return [
    `https://raw.githubusercontent.com/${owner}/${name}/HEAD/package.json`,
    // 备用：jsDelivr 也能读 GitHub，但**有缓存**，可能滞后 —— 消息里会标出来
    `https://cdn.jsdelivr.net/gh/${owner}/${name}@main/package.json`,
  ]
}

export function createSelfUpdate({ packageRoot, diag }) {
  const noop = () => {}
  const log = typeof diag === 'function' ? diag : noop

  let meta = {}
  try {
    meta = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  } catch (e) {
    log('读自己的 package.json 失败：' + (e && e.message))
  }

  const current = String(meta.version || '')
  const repo = String(
    (meta.repository && (meta.repository.url || meta.repository)) || meta.homepage || ''
  )
  const repoUrl = repo
    .replace(/^git\+/, '')
    .replace(/^git:/, 'https:')
    .replace(/\.git$/, '')
    .replace(/#readme$/i, '')

  let cache = null

  async function fetchLatest() {
    const urls = rawUrls(repo)
    if (!urls.length) return { latest: null, error: '包里没写 GitHub 仓库地址，没法查' }
    let lastErr = ''
    for (const url of urls) {
      try {
        const res = await fetch(url, {
          signal: AbortSignal.timeout(TIMEOUT),
          headers: { accept: 'application/json', 'user-agent': 'dsh-plugin-selfupdate' },
        })
        if (!res.ok) { lastErr = 'HTTP ' + res.status; continue }
        const j = await res.json()
        if (!j || !j.version) { lastErr = '仓库里的 package.json 没有 version'; continue }
        return {
          latest: String(j.version),
          from: url.includes('jsdelivr') ? 'jsDelivr（有缓存，可能滞后）' : 'GitHub',
        }
      } catch (e) {
        lastErr = String((e && e.message) || e)
      }
    }
    return { latest: null, error: lastErr || '查询失败' }
  }

  async function check(force) {
    if (!force && cache && Date.now() - cache.checkedAt < TTL) return { ...cache, cached: true }
    const r = await fetchLatest()
    const hasUpdate = Boolean(r.latest && current && cmpVer(r.latest, current) > 0)
    cache = {
      ok: Boolean(r.latest),
      current,
      latest: r.latest || null,
      hasUpdate,
      // 本机比仓库还新 —— 自己改过还没推，正常
      ahead: Boolean(r.latest && current && cmpVer(r.latest, current) < 0),
      error: r.error || null,
      from: r.from || null,
      repoUrl: repoUrl || null,
      checkedAt: Date.now(),
    }
    log('查更新：当前 ' + current + ' / 最新 ' + (r.latest || '查不到') + (r.error ? '（' + r.error + '）' : ''))
    return cache
  }

  function register(ctx, route) {
    try {
      ctx.effect(() => ctx.webServer.register({
        kind: 'exact',
        path: route + '/update',
        handler: async (req, res) => {
          const send = (code, obj) => {
            res.writeHead(code, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
            })
            res.end(JSON.stringify(obj))
          }
          try {
            const url = new URL(req.url, 'http://127.0.0.1')
            const force = url.searchParams.get('refresh') === '1'
            send(200, { ok: true, ...(await check(force)) })
          } catch (e) {
            log('查更新路由失败：' + (e && e.message))
            send(200, { ok: false, current, latest: null, error: String((e && e.message) || e) })
          }
        },
      }))
    } catch (e) {
      log('查更新路由注册失败：' + (e && e.message))
    }
  }

  return { current, repo, repoUrl, check, register }
}
