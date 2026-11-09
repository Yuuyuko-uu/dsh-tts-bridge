// Firefox 构建产物的接线：翻译规则别悄悄失效。
// 跑法：node test/firefox-build.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { 构建, 翻清单, 翻后台, 翻内容脚本 } from '../scripts/build-firefox.mjs'

const 仓库根 = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 只看正文，不把兼容层注释里的「chrome.*」算成残留。 */
const 去掉兼容层 = (文) => 文.split('\n').filter((行) => !行.startsWith('//')).join('\n')

test('清单：后台改成事件页，并带上火狐要求的 gecko 段', () => {
  const 原 = JSON.parse(readFileSync(join(仓库根, 'extension', 'manifest.json'), 'utf8'))
  const 新 = 翻清单(原)

  assert.deepEqual(新.background, { scripts: ['find.js', 'bg.js'] })
  assert.equal(新.browser_specific_settings.gecko.id, 'dsh-tts-bridge-firefox@yuuyuko')
  assert.deepEqual(新.browser_specific_settings.gecko.data_collection_permissions, { required: ['none'] })
  // 权限和内容脚本照抄，别在翻译时丢掉
  assert.deepEqual(新.permissions, 原.permissions)
  assert.deepEqual(新.host_permissions, 原.host_permissions)
  assert.deepEqual(新.content_scripts, 原.content_scripts)
  // 原清单不能被改坏
  assert.equal(原.name, '朗读桥')
})

test('后台：去掉 importScripts，chrome.* 全走 browser 别名', () => {
  const 源 = readFileSync(join(仓库根, 'extension', 'bg.js'), 'utf8')
  const 文 = 翻后台(源)

  assert.ok(文.startsWith('// Firefox 兼容层'), '兼容层要放在最前面')
  assert.equal(/^\s*importScripts\(/m.test(文), false, '事件页里不能再用 importScripts')
  assert.equal(/\bchrome\./.test(去掉兼容层(文)), false, '正文里不该再有 chrome.*')
  assert.equal((文.match(/\bapi\./g) || []).length > 10, true, '应该真的把调用换过去了')
})

test('内容脚本：chrome.runtime 走 browser 别名', () => {
  const 源 = readFileSync(join(仓库根, 'extension', 'content.js'), 'utf8')
  const 文 = 翻内容脚本(源)

  assert.ok(文.startsWith('// Firefox 兼容层'))
  assert.equal(/\bchrome\.runtime\b/.test(去掉兼容层(文)), false)
  assert.equal(/\bapi\.runtime\b/.test(文), true)
})

test('翻译是幂等的：翻过的再翻一遍不变', () => {
  const 源 = readFileSync(join(仓库根, 'extension', 'bg.js'), 'utf8')
  const 一 = 翻后台(源)
  assert.equal(翻后台(一), 一)
})

test('构建：产物是解压目录 + 一个能解开的 xpi', () => {
  const 临时 = mkdtempSync(join(tmpdir(), 'tts-ff-'))
  try {
    const 结果 = 构建({ 仓库根, 输出根: 临时 })
    const 清单 = JSON.parse(readFileSync(join(结果.扩展目录, 'manifest.json'), 'utf8'))
    assert.deepEqual(清单.background, { scripts: ['find.js', 'bg.js'] })
    assert.ok(readFileSync(join(结果.扩展目录, '怎么装.txt'), 'utf8').includes('Firefox'))

    const 包 = readFileSync(结果.xpi)
    assert.equal(包.subarray(0, 4).toString('hex'), '504b0304', '得是 zip')
    // 中央目录里每个文件名都在；manifest.json 必须是顶层
    const 文本 = 包.toString('utf8')
    for (const 文件 of ['manifest.json', 'bg.js', 'content.js', 'find.js', 'playback.js']) {
      assert.ok(文本.includes(文件), 'xpi 里缺 ' + 文件)
    }
  } finally {
    rmSync(临时, { recursive: true, force: true })
  }
})
