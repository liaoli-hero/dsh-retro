// scripts/verify-client.mjs — 客户端半侧的静态契约校验（不启动浏览器）
//
// 检查的是**宿主会拒绝的那几件事**，而不是「代码看起来对不对」：
//   ① package.json 的 dsh.client + exports["./client"] 能解析出真实文件
//   ② bundle 是 window.__ModuleLoader__.load({ id, factory }) 形态，且 id 与包名一致
//   ③ factory(require) 只 require 平台模块表里存在的东西（react / react/jsx-runtime）
//   ④ 槽位 id 自洽：panellist 的 id 与 main 的 key 完全相同（不一致 = 点了没反应）
//   ⑤ 文案词典中英键集完全对齐（缺键会在切语言时露出裸 key）
//
// 用法：node scripts/verify-client.mjs

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = join(here, '..')

let passed = 0
let failed = 0
function check(label, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failed += 1
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('== 包清单 ==')
const manifest = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'))
check('dsh.client.platform = web', manifest.dsh?.client?.platform === 'web', JSON.stringify(manifest.dsh?.client))
const clientExport = manifest.exports?.['./client']
check('exports["./client"] 是字符串或带 default 的对象', typeof clientExport === 'string' || typeof clientExport?.default === 'string')

const rel = typeof clientExport === 'string' ? clientExport : clientExport?.default
const clientPath = join(pkgRoot, rel ?? '')
check('client bundle 文件存在', existsSync(clientPath), clientPath)

console.log('\n== bundle 形态 ==')
const source = existsSync(clientPath) ? readFileSync(clientPath, 'utf8') : ''
check('走 __ModuleLoader__.load 注册', /window\.__ModuleLoader__\.load\(\{/.test(source))
check('声明了 id', /id:\s*'dsh-retro'/.test(source), (source.match(/id:\s*'[^']+'/) ?? [''])[0])
check('声明了 factory(require)', /factory:\s*\(require\)\s*=>/.test(source))
check('导出 apply', /exports\.apply\s*=/.test(source))
check('导出 inject', /exports\.inject\s*=/.test(source))

console.log('\n== 平台模块表 ==')
// 宿主的 PLATFORM_MODULES：只有这些能在 factory 里 require
const PLATFORM = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  'zod',
  '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
])
const requires = [...source.matchAll(/require\(\s*'([^']+)'\s*\)/g)].map((m) => m[1])
const unknown = [...new Set(requires)].filter((name) => !PLATFORM.has(name))
check('只 require 平台表内模块', unknown.length === 0, unknown.join(', '))
check('确实 require 了 react/jsx-runtime', requires.includes('react/jsx-runtime'), requires.join(','))

console.log('\n== 槽位自洽 ==')
const panelIdMatch = /const PANEL_ID = '([^']+)'/.exec(source) ?? /const PANEL_ID = "([^"]+)"/.exec(source)
const panelId = panelIdMatch?.[1] ?? ''
check('PANEL_ID 为 kebab-case', /^[a-z0-9]+(-[a-z0-9]+)*$/.test(panelId), panelId)
check('注册到 sidebar.panellist', /slots\.inject\('sidebar\.panellist'/.test(source))
check('注册到 main', /slots\.inject\('main'/.test(source))
check('panellist 用 id = PANEL_ID', /slots\.register\(\{[\s\S]{0,200}?name: 'sidebar\.panellist',\s*\n\s*id: PANEL_ID/.test(source))
check('main 用 key = PANEL_ID', /slots\.register\(\{[\s\S]{0,200}?name: 'main',\s*\n\s*key: PANEL_ID/.test(source))
check('图标组件接收 size', /function RetroPanelIcon\(\{ size \}\)/.test(source))
check('面板组件接收 t', /function RetroPage\(props\)/.test(source))

console.log('\n== 词典键集对齐 ==')
const dictBlock = source.slice(source.indexOf('const zh = {'), source.indexOf('const en = {'))
const dictBlock2 = source.slice(source.indexOf('const en = {'), source.indexOf('/** 兜底翻译'))
function keysOf(block) {
  return [...block.matchAll(/^\s*'([^']+)':/gm)].map((m) => m[1]).sort()
}
const zhKeys = keysOf(dictBlock)
const enKeys = keysOf(dictBlock2)
check('zh 词典非空', zhKeys.length > 20, String(zhKeys.length))
check('中英键集完全一致', zhKeys.length === enKeys.length && zhKeys.every((k, i) => k === enKeys[i]),
  zhKeys.filter((k) => !enKeys.includes(k)).join(',') || enKeys.filter((k) => !zhKeys.includes(k)).join(','))

// 代码里用到的 t('key') 必须在词典里
const usedKeys = [...new Set([...source.matchAll(/\bt\('([a-z][a-zA-Z.]*)'/g)].map((m) => m[1]))]
const missing = usedKeys.filter((key) => !zhKeys.includes(key))
check('所有 t() 用到的键都已定义', missing.length === 0, missing.join(', '))

console.log('\n== 宿主 API 面 ==')
check('调用 /api/retro/snapshot', source.includes("'/api/retro/snapshot'"))
check('调用 /api/retro/promote', source.includes("'/api/retro/promote'"))
check('调用 /api/retro/forget', source.includes("'/api/retro/forget'"))
check('调用 /api/retro/summary', source.includes("'/api/retro/summary'"))
check('有加载失败的错误分支', /retro-error/.test(source) && /error\.load/.test(source))
check('locale 服务为可选注入', /ctx\.inject\(\['locale'\]/.test(source))
check('不把 locale 写进静态 inject', !/const inject = \[[^\]]*'locale'/.test(source))

console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
