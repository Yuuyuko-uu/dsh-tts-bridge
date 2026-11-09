#!/usr/bin/env node
// 把 extension/ 翻成 Firefox 能装的版本。
//
// 为什么要翻，而不是再抄一份：
//   · 火狐的 MV3 后台是**事件页**，没有 Service Worker，所以 `background.service_worker` 要换成
//     `background.scripts: [find.js, bg.js]`，`bg.js` 里的 `importScripts('find.js')` 也就不能用；
//   · 火狐里 `chrome.*` 是回调式，`browser.*` 才是 Promise —— 代码里用的是 await，必须走 browser；
//   · 火狐要求扩展带 `browser_specific_settings.gecko.id`，新版本还要申报数据收集。
//
// 产物（都在 build/ 下，不进仓库）：
//   build/firefox/extension/          解压版，给 about:debugging「临时载入」用
//   build/dsh-tts-firefox-<版本>.xpi  压缩包，给「装 xpi」用
//
// 跑法：node scripts/build-firefox.mjs

import { cpSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const 根 = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Firefox 侧的清单：在 Chrome 清单基础上改，别硬编码权限，改了上游也能跟。 */
export function 翻清单(原清单) {
  const 清单 = structuredClone(原清单)
  清单.name = '朗读桥 · Firefox'
  // 事件页：两个脚本按顺序加载，共用一个全局作用域（find.js 先挂 self.__ttsFind）
  清单.background = { scripts: ['find.js', 'bg.js'] }
  清单.browser_specific_settings = {
    gecko: {
      id: 'dsh-tts-bridge-firefox@yuuyuko',
      strict_min_version: '140.0', // data_collection_permissions 从 140 起才认
      data_collection_permissions: { required: ['none'] },
    },
  }
  return 清单
}

/** 火狐里没有 chrome.* 的 Promise，把用到的地方换成 browser（取不到就退回 chrome，Chrome 上照样能跑）。 */
const 别名 = [
  '// Firefox 兼容层：火狐里 chrome.* 是回调式、browser.* 才是 Promise；这里统一走 browser。',
  "const api = (typeof browser !== 'undefined' && browser && browser.runtime) ? browser : chrome",
  '',
].join('\n')

const 已翻 = (文) => 文.startsWith('// Firefox 兼容层')

export function 翻后台(源码) {
  if (已翻(源码)) return 源码
  let 文 = 源码.replace(/^importScripts\((['"])find\.js\1\)\s*$/m,
    '// Firefox：find.js 由 manifest 的 background.scripts 先加载，不再 importScripts')
  文 = 文.replace(/\bchrome\./g, 'api.')
  return 别名 + 文
}

export function 翻内容脚本(源码) {
  if (已翻(源码)) return 源码
  const 文 = 源码.replace(/\bchrome\.runtime\b/g, 'api.runtime')
  return 别名 + 文
}

const 怎么装 = `朗读桥 · Firefox 版

一、临时载入（改代码方便，重启浏览器失效）
  1. 地址栏打开 about:debugging#/runtime/this-firefox
  2. 「临时载入附加组件…」→ 选中本目录的 manifest.json
  3. 打开 https://chat.deepseek.com/ 并确认已登录

二、装 xpi（重启后还在）
  1. about:config 里把 xpinstall.signatures.required 设为 false
  2. 把 dsh-tts-firefox-<版本>.xpi 拖进火狐窗口
  （正式版会拒绝未签名扩展，要么走临时载入，要么交给 AMO 签名）

出问题先看：about:debugging → 本扩展 →「检查」→ Console
它连的是本机 DSH 里的朗读桥插件，找不到端口就是 DSH 没开或插件没装。
`

/** 无依赖地把一个目录打成 zip（store，不压缩）。xpi 就是 zip，只认结构。 */
export function 打包(源目录, 目标文件, 文件列表) {
  const 体 = []
  const 目录 = []
  let 偏移 = 0
  for (const 相对 of 文件列表) {
    const 数据 = readFileSync(join(源目录, 相对))
    const 名 = Buffer.from(相对.split(sep).join('/'), 'utf8')
    const 和 = crc32(数据)
    const 本地头 = Buffer.alloc(30)
    本地头.writeUInt32LE(0x04034b50, 0)
    本地头.writeUInt16LE(20, 4)          // version needed
    本地头.writeUInt16LE(0x0800, 6)      // UTF-8 文件名
    本地头.writeUInt16LE(0, 8)           // store
    本地头.writeUInt16LE(0, 10)          // time
    本地头.writeUInt16LE(0, 12)          // date
    本地头.writeUInt32LE(和, 14)
    本地头.writeUInt32LE(数据.length, 18)
    本地头.writeUInt32LE(数据.length, 22)
    本地头.writeUInt16LE(名.length, 26)
    本地头.writeUInt16LE(0, 28)
    体.push(本地头, 名, 数据)

    const 中央头 = Buffer.alloc(46)
    中央头.writeUInt32LE(0x02014b50, 0)
    中央头.writeUInt16LE(20, 4)
    中央头.writeUInt16LE(20, 6)
    中央头.writeUInt16LE(0x0800, 8)
    中央头.writeUInt16LE(0, 10)
    中央头.writeUInt16LE(0, 12)
    中央头.writeUInt16LE(0, 14)
    中央头.writeUInt32LE(和, 16)
    中央头.writeUInt32LE(数据.length, 20)
    中央头.writeUInt32LE(数据.length, 24)
    中央头.writeUInt16LE(名.length, 28)
    中央头.writeUInt16LE(0, 30)
    中央头.writeUInt16LE(0, 32)
    中央头.writeUInt16LE(0, 34)
    中央头.writeUInt16LE(0, 36)
    中央头.writeUInt32LE(0, 38)
    中央头.writeUInt32LE(偏移, 42)
    目录.push(中央头, 名)
    偏移 += 本地头.length + 名.length + 数据.length
  }
  const 中央区 = Buffer.concat(目录)
  const 收尾 = Buffer.alloc(22)
  收尾.writeUInt32LE(0x06054b50, 0)
  收尾.writeUInt16LE(0, 4)
  收尾.writeUInt16LE(0, 6)
  收尾.writeUInt16LE(文件列表.length, 8)
  收尾.writeUInt16LE(文件列表.length, 10)
  收尾.writeUInt32LE(中央区.length, 12)
  收尾.writeUInt32LE(偏移, 16)
  收尾.writeUInt16LE(0, 20)
  writeFileSync(目标文件, Buffer.concat([...体, 中央区, 收尾]))
}

/** CRC32（zlib.crc32 要 node 22.2+，这里自己算，老 node 也能跑）。 */
const 表 = (() => {
  const t = new Int32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[i] = c
  }
  return t
})()
function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = 表[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function 目录里的文件(dir, 前缀 = '') {
  const out = []
  for (const 名 of readdirSync(dir)) {
    const 全 = join(dir, 名)
    if (statSync(全).isDirectory()) out.push(...目录里的文件(全, 前缀 + 名 + sep))
    else out.push(前缀 + 名)
  }
  return out
}

export function 构建({ 仓库根 = 根, 输出根 = join(根, 'build') } = {}) {
  const 源 = join(仓库根, 'extension')
  const 目标 = join(输出根, 'firefox')
  const 扩展目录 = join(目标, 'extension')
  rmSync(目标, { recursive: true, force: true })
  mkdirSync(扩展目录, { recursive: true })
  cpSync(源, 扩展目录, { recursive: true })

  const 清单 = JSON.parse(readFileSync(join(源, 'manifest.json'), 'utf8'))
  const 新版 = 翻清单(清单)
  writeFileSync(join(扩展目录, 'manifest.json'), JSON.stringify(新版, null, 2) + '\n', 'utf8')
  writeFileSync(join(扩展目录, 'bg.js'), 翻后台(readFileSync(join(源, 'bg.js'), 'utf8')), 'utf8')
  writeFileSync(join(扩展目录, 'content.js'), 翻内容脚本(readFileSync(join(源, 'content.js'), 'utf8')), 'utf8')
  writeFileSync(join(扩展目录, '怎么装.txt'), 怎么装, 'utf8')

  const xpi = join(输出根, `dsh-tts-firefox-${新版.version}.xpi`)
  mkdirSync(输出根, { recursive: true })
  打包(扩展目录, xpi, 目录里的文件(扩展目录))
  return { 输出根, 扩展目录, xpi, 清单: 新版 }
}

const 直接跑 = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (直接跑) {
  const { 扩展目录, xpi } = 构建()
  console.log('解压版：' + 扩展目录)
  console.log('xpi：  ' + xpi)
  console.log('装法：about:debugging#/runtime/this-firefox → 临时载入附加组件 → 选解压版里的 manifest.json')
}
