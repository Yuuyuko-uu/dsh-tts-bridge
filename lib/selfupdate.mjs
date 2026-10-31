// 插件自查更新 —— 查的是**这个插件自己的仓库**，并且能一键装
//
// 每个插件在自己设置页放一个「检查更新」：点一下去自己的仓库 / npm 看最新版本。
//
// 原则：
//   · 仓库地址从包里自己的 package.json 读（`repository`），不在代码里写死
//   · **多源全查、取最大的那个版本** —— 以前是"谁先返回用谁"，GitHub 一超时就落到
//     jsDelivr 那个**带 CDN 缓存**的源上，于是同一分钟能报出两个不同的"最新"，甚至比本机还旧
//   · 查不到要如实说"查不到"，绝不能显示成"已是最新"
//   · 结果缓存 6 小时；点按钮（refresh）就绕过缓存
//   · 「一键更新」走宿主自己的 pluginManager.installBundle —— 装完由宿主决定要不要重载；
//     **本地开发副本（link:）不给装**，那会把她正在改的目录换成仓库里的版本
//
// ⚠ 这个文件是**复制多份**到各个插件里的同一份实现，只在这一个地方改了要同步给其它插件。
//
// 2026-11-01：多源取最大 + 一键更新（install）+ 装完把结果原样带回界面。

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
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

// 三个源都要查：GitHub raw（真值）· jsDelivr（有缓存，可能滞后）· npm registry（发过就有）
function sources(meta, repo) {
  const out = []
  const s = String(repo || '').trim()
  const m = /github\.com[/:]([^/]+)\/([^/#?]+)/i.exec(s)
  if (m) {
    const owner = m[1]
    const name = m[2].replace(/\.git$/i, '')
    out.push({ url: `https://raw.githubusercontent.com/${owner}/${name}/HEAD/package.json`, from: 'GitHub' })
    out.push({ url: `https://cdn.jsdelivr.net/gh/${owner}/${name}@main/package.json`, from: 'jsDelivr' })
  }
  const pkg = String((meta && meta.name) || '').trim()
  if (pkg) {
    const enc = pkg.startsWith('@') ? '@' + pkg.slice(1).replace('/', '%2F') : encodeURIComponent(pkg)
    out.push({ url: `https://registry.npmjs.org/${enc}/latest`, from: 'npm' })
  }
  return out
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

  // 装在自己的 node_modules 里 = 正常安装；不在 = 本地 link 的开发副本
  const 是开发副本 = !/[\\/]node_modules[\\/]/.test(String(packageRoot))

  let cache = null

  async function fetchLatest() {
    const list = sources(meta, repo)
    if (!list.length) return { latest: null, error: '包里没写仓库地址，也不像在 npm 上发过，没法查' }
    const 结果 = await Promise.all(list.map(async (s) => {
      try {
        const res = await fetch(s.url, {
          signal: AbortSignal.timeout(TIMEOUT),
          headers: { accept: 'application/json', 'user-agent': 'dsh-plugin-selfupdate' },
        })
        if (!res.ok) return { err: s.from + ' HTTP ' + res.status }
        const j = await res.json()
        const v = String((j && j.version) || '')
        if (!v) return { err: s.from + ' 没有 version' }
        return { v, from: s.from }
      } catch (e) {
        return { err: s.from + ' ' + String((e && e.message) || e) }
      }
    }))
    // ⭐ 取**最大**的那个：版本只会往前走，任何一个源报小了都只是它滞后
    let best = null
    let bestFrom = null
    for (const r of 结果) {
      if (!r.v) continue
      if (best === null || cmpVer(r.v, best) > 0) { best = r.v; bestFrom = r.from }
    }
    if (best === null) {
      return { latest: null, error: 结果.map((r) => r.err).filter(Boolean).join(' · ') || '查询失败' }
    }
    return { latest: best, from: bestFrom }
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
      devCopy: 是开发副本,
      canInstall: !是开发副本,
      checkedAt: Date.now(),
    }
    log('查更新：当前 ' + current + ' / 最新 ' + (r.latest || '查不到') + (r.from ? '（' + r.from + '）' : '') + (r.error ? '（' + r.error + '）' : ''))
    return cache
  }

  // 这个插件是以什么身份装的？从 profile 的 package.json 里把它那行依赖原样取出来 ——
  // 用它当 spec 才是"同源更新"，不会把 github 装的换成 npm 版。
  function 取安装来源() {
    const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
    const name = String(meta.name || '')
    if (!name) return ''
    let profiles = []
    try { profiles = readdirSync(join(HOME, 'profiles')) } catch (e) { return '' }
    for (const p of profiles) {
      const f = join(HOME, 'profiles', p, 'package.json')
      if (!existsSync(f)) continue
      try {
        const j = JSON.parse(readFileSync(f, 'utf8'))
        const dep = String((j.dependencies && j.dependencies[name]) || '')
        if (/^(github:|git\+|https?:)/i.test(dep)) return dep
      } catch (e) { /* 读不了就下一个 */ }
    }
    // 兜底：从 package.json 的仓库地址拼
    const m = /github\.com[/:]([^/]+)\/([^/#?]+)/i.exec(repoUrl)
    if (m) return 'github:' + m[1] + '/' + m[2].replace(/\.git$/i, '')
    return ''
  }

  async function install(ctx) {
    if (是开发副本) {
      return { ok: false, error: '这是本地开发副本（link: 进来的），一键更新会把你正在改的目录换成仓库里的版本 —— 要更新请在仓库里 git pull' }
    }
    const pm = ctx && ctx.pluginManager
    if (!pm || typeof pm.installBundle !== 'function') {
      return { ok: false, error: '这版 DSH 没有插件管理接口，装不了；请手动更新' }
    }
    const spec = 取安装来源() || (meta.name ? String(meta.name) : '')
    if (!spec) return { ok: false, error: '不知道该从哪儿装（既没有仓库地址，也没记录安装来源）' }
    try {
      log('一键更新：开始装 ' + spec)
      const r = await pm.installBundle(spec)
      log('一键更新：' + JSON.stringify(r && (r.applied ?? r.application ?? r.reason ?? r)))
      return { ok: true, spec, result: r || null }
    } catch (e) {
      log('一键更新失败：' + String((e && e.message) || e))
      return { ok: false, spec, error: String((e && e.message) || e) }
    }
  }

  function register(ctx, route) {
    const send = (res, code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(obj))
    }
    try {
      ctx.effect(() => ctx.webServer.register({
        kind: 'exact',
        path: route + '/update',
        handler: async (req, res) => {
          try {
            const url = new URL(req.url, 'http://127.0.0.1')
            const force = url.searchParams.get('refresh') === '1'
            send(res, 200, { ok: true, ...(await check(force)) })
          } catch (e) {
            log('查更新路由失败：' + (e && e.message))
            send(res, 200, { ok: false, current, latest: null, error: String((e && e.message) || e) })
          }
        },
      }))
      // ⭐ 一键更新：POST。装完的结果原样带回去（可能要重启才生效）
      ctx.effect(() => ctx.webServer.register({
        kind: 'exact',
        path: route + '/install',
        handler: async (req, res) => {
          if (req.method !== 'POST') { send(res, 405, { ok: false, error: '只接受 POST' }); return }
          try {
            const r = await install(ctx)
            send(res, 200, r)
          } catch (e) {
            log('一键更新路由失败：' + (e && e.message))
            send(res, 200, { ok: false, error: String((e && e.message) || e) })
          }
        },
      }))
    } catch (e) {
      log('查更新路由注册失败：' + (e && e.message))
    }
  }

  return { current, repo, repoUrl, check, install, register }
}
