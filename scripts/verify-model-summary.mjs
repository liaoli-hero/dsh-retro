// scripts/verify-model-summary.mjs — 模型复盘的接线回归
//
// 这个文件存在的理由是一次静默失效：
//   插件只在代码里读 `ctx.agentDefaultModel`，却没走 `ctx.inject(['agentDefaultModel'])`。
//   宿主只给**声明过**的服务在 ctx 上挂属性，所以那里永远是 undefined，
//   模型复盘恒报「当前会话没有可用的 provider/model」——看起来像"你没选模型"，
//   实际上服务引用根本没拿到。这类失效最难查：错误信息指向了错误的方向。
//
// 本文件锁四件事：
//   ① 服务通过 ctx.inject 注入后，模型复盘能拿到 provider/model 并真的发起请求
//   ② 缺服务时的降级原因**区分得开**（缺服务 ≠ 没选模型 ≠ 缺 llm）
//   ③ 模型返回的内容真的被写进总结的「模型复盘」段落
//   ④ 模型报错时如实转述，不伪造文案
//
// 用法：node scripts/verify-model-summary.mjs

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const pluginUrl = pathToFileURL(new URL('../index.js', import.meta.url).pathname.replace(/^\//, '')).href

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

/**
 * 装配插件并跑一次 useModel=true 的总结。
 * @param {{ model?: object|null, llm?: object|null, offer: string[] }} services
 *   offer = 这次假装宿主提供了哪些服务（用来测"服务不存在"）
 */
async function runSummary(services) {
  const root = mkdtempSync(join(tmpdir(), 'retro-model-'))
  const seen = { streamCalls: [] }

  const ctx = {
    logger: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
    tools: { register: () => () => {} },
    on: () => () => {},
    effect: () => () => {},
    get() {
      return undefined
    },
    inject(names, cb) {
      const scope = { ...ctx, effect: () => () => {} }
      let ready = true
      for (const name of names) {
        if (!services.offer.includes(name)) {
          ready = false // 服务不存在：宿主不会执行回调
          break
        }
      }
      if (!ready) return
      if (names.includes('agentDefaultModel')) scope.agentDefaultModel = services.model
      if (names.includes('llm')) scope.llm = services.llm
      cb(scope)
    },
  }

  const mod = await import(`${pluginUrl}?t=${Date.now()}-${Math.random()}`)
  await mod.apply(ctx, { rootDir: root, llmTimeoutMs: 5000 })

  const routes = new Map()
  mod.__internal.registerRoutes({ webServer: { register(route) { routes.set(route.path, route.handler); return () => {} } } })

  const body = JSON.stringify({ useModel: true })
  const req = {
    method: 'POST',
    headers: {},
    on(event, cb) {
      if (event === 'data') cb(Buffer.from(body))
      if (event === 'end') cb()
      return req
    },
    destroy() {},
  }
  let out = ''
  await routes.get('/api/retro/summary')(req, { writeHead() {}, end(t) { out = t } })

  const parsed = JSON.parse(out)
  rmSync(root, { recursive: true, force: true })
  return parsed
}

/** 记录调用参数的假 llm。 */
function makeLlm(reply, { fail = null } = {}) {
  return {
    stream: async function* (options) {
      this.calls = this.calls ?? []
      this.calls.push(options)
      if (fail !== null) {
        yield { type: 'finish', reason: { kind: 'error', failure: { message: fail, code: 'TEST' } } }
        return
      }
      for (const piece of reply) yield { type: 'text-delta', text: piece }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

const model = { currentSelection: () => ({ provider: 'xdpool', model: 'deepseek-v4.1-flash' }) }

console.log('== 正常路径：服务齐全 ==')
{
  const llm = makeLlm(['1. 先读文件再改。\n', '2. 改完立即验证。'])
  const result = await runSummary({ model, llm, offer: ['agentDefaultModel', 'llm'] })
  check('总结返回成功', result.ok === true)
  check('没有 modelError', result.modelError === undefined || result.modelError === '', String(result.modelError))
  check('模型复盘段落已写入', typeof result.text === 'string' && result.text.includes('## 模型复盘'), String(result.text).slice(0, 80))
  check('段落含模型原文', String(result.text).includes('先读文件再改'))
  check('模型真的被调用了一次', Array.isArray(llm.calls) && llm.calls.length === 1, String(llm.calls?.length))
  check('用的是注入的 provider', llm.calls?.[0]?.provider === 'xdpool', String(llm.calls?.[0]?.provider))
  check('用的是注入的 model', llm.calls?.[0]?.model === 'deepseek-v4.1-flash', String(llm.calls?.[0]?.model))
  check('请求带 system 提示', typeof llm.calls?.[0]?.system === 'string' && llm.calls[0].system.length > 0)
}

console.log('\n== 降级 1：agentDefaultModel 服务不存在 ==')
{
  const llm = makeLlm(['x'])
  const result = await runSummary({ model: null, llm, offer: ['llm'] })
  check('仍返回 ok（总结照常生成）', result.ok === true)
  check('说明是服务未挂载', String(result.modelError).includes('agentDefaultModel 服务未挂载'), String(result.modelError))
  check('不再误报为"没选模型"', !String(result.modelError).includes('未选择 provider'), String(result.modelError))
  check('模型未被调用', (llm.calls?.length ?? 0) === 0)
}

console.log('\n== 降级 2：llm 服务不存在 ==')
{
  const result = await runSummary({ model, llm: null, offer: ['agentDefaultModel'] })
  check('仍返回 ok', result.ok === true)
  check('说明是 llm 未挂载', String(result.modelError).includes('llm 服务未挂载'), String(result.modelError))
}

console.log('\n== 降级 3：服务在但没选模型 ==')
{
  const emptyModel = { currentSelection: () => ({ provider: '', model: '' }) }
  const llm = makeLlm(['x'])
  const result = await runSummary({ model: emptyModel, llm, offer: ['agentDefaultModel', 'llm'] })
  check('仍返回 ok', result.ok === true)
  check('说明是未选择模型', String(result.modelError).includes('未选择 provider/model'), String(result.modelError))
  check('提示了怎么修', String(result.modelError).includes('选一个模型'), String(result.modelError))
}

console.log('\n== 降级 4：currentSelection 抛错 ==')
{
  const broken = { currentSelection: () => { throw new Error('boom') } }
  const llm = makeLlm(['x'])
  const result = await runSummary({ model: broken, llm, offer: ['agentDefaultModel', 'llm'] })
  check('不崩（仍有总结）', result.ok === true)
  check('按未选择处理', String(result.modelError).includes('未选择 provider'), String(result.modelError))
}

console.log('\n== 模型报错时如实转述 ==')
{
  const llm = makeLlm([], { fail: 'quota exhausted' })
  const result = await runSummary({ model, llm, offer: ['agentDefaultModel', 'llm'] })
  check('仍返回 ok（回落规则式）', result.ok === true)
  check('保留规则式总结正文', String(result.text).includes('# 运行复盘'))
  check('转述模型报错原因', String(result.modelError).includes('quota exhausted'), String(result.modelError))
  check('不伪造模型段落', !String(result.text).includes('## 模型复盘'))
}

console.log('\n== 模型空回复 ==')
{
  const llm = makeLlm([])
  const result = await runSummary({ model, llm, offer: ['agentDefaultModel', 'llm'] })
  check('空回复有明确原因', String(result.modelError).includes('模型未返回文本'), String(result.modelError))
  check('不写入空段落', !String(result.text).includes('## 模型复盘'))
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
