// scripts/verify-settings.mjs — 运行期设置的完整闭环
//
// 验的是「改了不用重启」这件事本身，而不是配置读没读到：
//   ① settings.json 覆盖部署配置，且只覆盖显式写过的键
//   ② 改完立即影响行为（关掉 autoCapture → 失败不再落盘）
//   ③ 非法值被拒并说明原因，不静默夹紧
//   ④ reset 回落到部署配置
//   ⑤ 落盘可跨进程持久（重新装配后仍然生效）
//
// 用法：node scripts/verify-settings.mjs

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const base = new URL('../', import.meta.url)
const url = (rel) => pathToFileURL(new URL(rel, base).pathname.replace(/^\//, '')).href

const settings = await import(url('lib/settings.js'))
const store = await import(url('lib/store.js'))

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

const root = mkdtempSync(join(tmpdir(), 'retro-settings-'))

try {
  // ---------------------------------------------------------------- ① 合并语义
  console.log('== 合并：settings 覆盖 config，只覆盖显式键 ==')
  const baseConfig = store.normalizeConfig({ autoDraft: false, autoPromote: false, flowThreshold: 4 })
  check('部署配置基线正确', baseConfig.flowThreshold === 4 && baseConfig.autoPromote === false)

  const merged1 = settings.mergeSettings(baseConfig, { autoPromote: true })
  check('settings 覆盖 autoPromote', merged1.autoPromote === true, String(merged1.autoPromote))
  check('未写的键保留 config 值（flowThreshold）', merged1.flowThreshold === 4, String(merged1.flowThreshold))
  check('未写的键保留 config 值（autoDraft）', merged1.autoDraft === false, String(merged1.autoDraft))
  check('未涉及的键用默认值', merged1.promptBudget === 1200, String(merged1.promptBudget))

  const merged2 = settings.mergeSettings(baseConfig, {})
  check('空 settings = 完全等同 config', JSON.stringify(merged2) === JSON.stringify(baseConfig))

  // ---------------------------------------------------------------- ② 写入与持久
  console.log('\n== 写入与持久化 ==')
  const written = settings.writeSettings(root, baseConfig, { autoPromote: true, flowThreshold: 6 })
  check('写入被接受', written.rejected.length === 0, JSON.stringify(written.rejected))
  check('生效配置已更新', written.config.autoPromote === true && written.config.flowThreshold === 6)

  const file = settings.settingsPath(root)
  check('settings.json 已落盘', existsSync(file), file)
  const onDisk = JSON.parse(readFileSync(file, 'utf8'))
  check('落盘只含被改的键', Object.keys(onDisk).sort().join(',') === 'autoPromote,flowThreshold', JSON.stringify(onDisk))
  check('落盘不含未改的键', !Object.hasOwn(onDisk, 'promptBudget'))

  const reread = settings.readSettings(root)
  check('重新读取得到同样的值', reread.autoPromote === true && reread.flowThreshold === 6, JSON.stringify(reread))

  const mergedAfterReload = settings.mergeSettings(baseConfig, reread)
  check('模拟重启后仍生效（跨进程持久）', mergedAfterReload.autoPromote === true && mergedAfterReload.flowThreshold === 6)

  // ---------------------------------------------------------------- ③ 非法输入
  console.log('\n== 非法输入被拒而非静默夹紧 ==')
  const bad1 = settings.sanitizeSettings({ flowThreshold: 999 })
  check('超范围被拒', bad1.rejected.length === 1 && Object.keys(bad1.accepted).length === 0, JSON.stringify(bad1))
  check('拒绝原因写明范围', bad1.rejected[0].reason.includes('2') && bad1.rejected[0].reason.includes('10'), bad1.rejected[0].reason)

  const bad2 = settings.sanitizeSettings({ autoPromote: 'yes' })
  check('字符串冒充布尔被拒', bad2.rejected.length === 1, JSON.stringify(bad2))

  const bad3 = settings.sanitizeSettings({ rootDir: '/tmp/other' })
  check('rootDir 不许运行期改（会牵动路径）', bad3.rejected.length === 1 && bad3.rejected[0].key === 'rootDir', JSON.stringify(bad3))

  const bad4 = settings.sanitizeSettings({ flowThreshold: 3.5 })
  check('小数被拒（要求整数）', bad4.rejected.length === 1, JSON.stringify(bad4))

  const bad5 = settings.sanitizeSettings({ nonsense: 1 })
  check('未知键被拒', bad5.rejected.length === 1, JSON.stringify(bad5))

  const rejectedWrite = settings.writeSettings(root, baseConfig, { flowThreshold: 999 })
  check('非法写入整体不落盘', rejectedWrite.rejected.length === 1)
  check('原有设置未被破坏', settings.readSettings(root).flowThreshold === 6, String(settings.readSettings(root).flowThreshold))

  // ---------------------------------------------------------------- ④ 重置
  console.log('\n== 重置回落到部署配置 ==')
  const cleared = settings.clearSettings(root)
  check('重置成功', cleared === true)
  check('settings.json 已删除', !existsSync(file))
  const afterReset = settings.mergeSettings(baseConfig, settings.readSettings(root))
  check('回落到部署配置（autoPromote）', afterReset.autoPromote === false, String(afterReset.autoPromote))
  check('回落到部署配置（flowThreshold）', afterReset.flowThreshold === 4, String(afterReset.flowThreshold))
  check('重复重置是幂等的', settings.clearSettings(root) === false)
} finally {
  rmSync(root, { recursive: true, force: true })
}

// ---------------------------------------------------------------- ⑤ 行为闭环
console.log('\n== 行为闭环：改设置真的改变行为 ==')
{
  const runRoot = mkdtempSync(join(tmpdir(), 'retro-behavior-'))
  const handlers = { toolsResult: [], sessionEvent: [] }
  const ctx = {
    logger: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
    tools: { register: () => () => {} },
    on(event, handler) {
      if (event === 'tools/result') handlers.toolsResult.push(handler)
      if (event === 'session/event') handlers.sessionEvent.push(handler)
      return () => {}
    },
    inject() {},
    effect() {
      return () => {}
    },
    get() {
      return undefined
    },
  }

  const mod = await import(`${url('index.js')}?behavior=${Date.now()}`)
  // 部署配置：autoCapture 开、自动晋升关
  await mod.apply(ctx, { rootDir: runRoot, autoCapture: true, autoPromote: false })

  const session = { id: 'b', header: { cwd: runRoot } }
  const emitFailure = (message) => {
    for (const handler of handlers.toolsResult) {
      handler({ name: 'write', arguments: {}, agent: { session } }, {
        isError: true,
        content: [{ type: 'text', text: `Error: ${message}` }],
        error: { message },
      })
    }
  }

  emitFailure('sandbox: access denied one')
  const failsFile = join(runRoot, 'fails.jsonl')
  const countFails = () => (existsSync(failsFile) ? readFileSync(failsFile, 'utf8').trim().split('\n').filter(Boolean).length : 0)
  check('部署配置下失败被记录', countFails() === 1, String(countFails()))

  // 运行期关掉 autoCapture
  const patch = await fetchViaInternal(mod, { autoCapture: false })
  check('运行期改设置成功', patch === true)

  emitFailure('sandbox: access denied two')
  check('关掉后不再记录（立即生效，未重启）', countFails() === 1, String(countFails()))

  // 再打开
  await fetchViaInternal(mod, { autoCapture: true })
  emitFailure('sandbox: access denied three')
  check('重新打开后恢复记录', countFails() === 2, String(countFails()))

  rmSync(runRoot, { recursive: true, force: true })
}

/**
 * 直接走插件的 HTTP 处理器改设置（等价于面板点开关），
 * 避免依赖真实网络：构造极简 req/res。
 */
async function fetchViaInternal(mod, patch) {
  const routes = new Map()
  const routeCtx = { webServer: { register(route) { routes.set(route.path, route.handler); return () => {} } } }
  mod.__internal.registerRoutes(routeCtx)
  const handler = routes.get('/api/retro/settings')
  if (handler === undefined) throw new Error('settings 路由未注册')

  const body = JSON.stringify({ settings: patch })
  const req = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    on(event, cb) {
      if (event === 'data') cb(Buffer.from(body, 'utf8'))
      if (event === 'end') cb()
      return req
    },
    destroy() {},
  }
  let status = 0
  let payload = ''
  const res = {
    writeHead(code) {
      status = code
      return res
    },
    end(text) {
      payload = text ?? ''
      return res
    },
  }
  await handler(req, res)
  const parsed = payload === '' ? {} : JSON.parse(payload)
  return status === 200 && parsed.ok === true
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
