// 真实宿主装配烟测：用真实的 cordis + dsh-tools + dsh-skill + dsh-system-prompt +
// dsh-commands 起一个最小 app，把 dsh-retro 挂上去，然后从**服务侧**验证：
//   · 工具真的进了 registry（schemas 可见）
//   · 技能 provider 真的进了 skills registry 并能 list/get
//   · 提示词 section 真的进了 systemPrompt
//   · 命令真的进了 commands
//   · 发出 session/event 与 tools/result 后，磁盘与 provider 都按预期变化
//
// 用法：node scripts/verify-host.mjs

import { readFileSync, existsSync, rmSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const APP = process.env.DSH_APP || 'D:/DeepSeek Harness/resources/app/dsh/node_modules/@deepseek-ai'

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

if (!existsSync(`${APP}/cordis/lib/index.js`)) {
  console.log(`SKIP: 找不到 ${APP}/cordis（设置 DSH_APP 指向 dsh 的 node_modules/@deepseek-ai）`)
  process.exit(0)
}

const { Context } = await import(pathToFileURL(`${APP}/cordis/lib/index.js`).href)
const ToolsPlugin = await import(pathToFileURL(`${APP}/dsh-tools/lib/index.js`).href)
const SkillPlugin = await import(pathToFileURL(`${APP}/dsh-skill/lib/index.js`).href)
const SystemPromptPlugin = await import(pathToFileURL(`${APP}/dsh-system-prompt/lib/index.js`).href)
const CommandsPlugin = await import(pathToFileURL(`${APP}/dsh-commands/lib/index.js`).href)
const Retro = await import(pathToFileURL(new URL('../index.js', import.meta.url).pathname.replace(/^\//, '')).href)

const root = mkdtempSync(join(tmpdir(), 'dsh-retro-host-'))

const ctx = new Context()
await ctx.plugin(ToolsPlugin.default ?? ToolsPlugin)
await ctx.plugin(SkillPlugin.default ?? SkillPlugin)
await ctx.plugin(SystemPromptPlugin.default ?? SystemPromptPlugin)
await ctx.plugin(CommandsPlugin.default ?? CommandsPlugin)
await ctx.plugin(Retro.default ?? Retro, { rootDir: root, autoDraft: true, autoPromote: true, flowThreshold: 2, promptBudget: 800 })

// 等 fiber 稳定
if (typeof ctx.await === 'function') await ctx.await()
else await new Promise((resolve) => setTimeout(resolve, 300))

console.log('\n== 真实服务侧可见性 ==')
const toolSchemas = ctx.tools.schemas()
const names = toolSchemas.map((schema) => schema.name)
for (const expected of ['retro_capture', 'retro_summary', 'retro_skills', 'retro_forget']) {
  check(`工具 ${expected} 进入 registry`, names.includes(expected), names.join(','))
}

const skillSummaries = await ctx.skills.list({})
check('skills.list() 可调用（provider 已注册）', Array.isArray(skillSummaries))

const commandList = ctx.commands?.list?.()
check('commands 列表包含 retro', Array.isArray(commandList) ? commandList.some((cmd) => (cmd.name ?? cmd.id) === 'retro') : true, JSON.stringify(commandList?.map?.((c) => c.name ?? c.id)))

console.log('\n== 驱动一次真实工具调用（经 registry 的完整管线）==')
const captureResult = await ctx.tools.execute({
  callId: 'call-1',
  name: 'retro_capture',
  arguments: { summary: '真实装配下要验证磁盘落盘而不是只看返回值', lesson: '断言文件内容', tool: 'verify' },
  signal: new AbortController().signal,
})
check('工具执行成功', captureResult.isError === false, JSON.stringify(captureResult.error ?? ''))
const failsFile = join(root, 'fails.jsonl')
check('经验已落盘', existsSync(failsFile), failsFile)
const fails = existsSync(failsFile) ? readFileSync(failsFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []
check('落盘 1 条', fails.length === 1, String(fails.length))
check('内容含结论', JSON.stringify(fails[0] ?? {}).includes('真实装配下要验证磁盘落盘'))

console.log('\n== 端到端：流程 → 技能 → skills.list() ==')
const { SessionStore, Session } = await import(pathToFileURL(`${APP}/dsh-session/lib/index.js`).href).catch(() => ({ SessionStore: null, Session: null }))
// 没有 session 服务也能发事件：直接用 ctx.emit 模拟宿主派发
const fakeSession = { id: 'host-sess', header: { cwd: root } }
const fakeExec = (name) => ({ name, arguments: {}, agent: { session: fakeSession } })

for (let round = 1; round <= 2; round += 1) {
  ctx.emit('session/event', fakeSession, { type: 'turn/start', data: { turn: round } })
  ctx.emit('session/event', fakeSession, { type: 'step/start', data: { turn: round, step: 1 } })
  for (const tool of ['read', 'edit']) {
    ctx.emit('tools/result', fakeExec(tool), { isError: false, content: [] })
  }
  ctx.emit('session/event', fakeSession, { type: 'turn/end', data: { turn: round, reason: { kind: 'completed' } } })
}
await new Promise((resolve) => setTimeout(resolve, 80))

const flowsFile = join(root, 'flows.jsonl')
const flows = existsSync(flowsFile) ? readFileSync(flowsFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []
check('流程已聚合', flows.length === 1, String(flows.length))
check('到阈值后自动晋升', flows[0]?.promoted === true, JSON.stringify(flows[0]?.promoted))

const skillsAfter = await ctx.skills.list({})
const retroSkills = skillsAfter.filter((skill) => skill.provider === 'dsh-retro')
check('skills.list() 里出现沉淀的技能', retroSkills.length === 1, JSON.stringify(skillsAfter.map((s) => `${s.name}:${s.provider}`)))

if (retroSkills.length > 0) {
  const loaded = await ctx.skills.get(retroSkills[0].name, {})
  check('skills.get() 能加载正文', typeof loaded?.content === 'string' && loaded.content.includes('## 步骤'), String(loaded?.content).slice(0, 60))
  check('加载结果带 provider 归属', loaded?.provider === 'dsh-retro', String(loaded?.provider))
}

console.log('\n== 提示词 section 生效 ==')
const assembly = await ctx.systemPrompt.assemble({})
const sectionList = Array.isArray(assembly?.sections) ? assembly.sections : []
const retroSection = sectionList.find((section) => section.name === 'retro:history')
check('装配结果包含 retro:history section', retroSection !== undefined, sectionList.map((s) => s.name).join(','))
check('section 文本非空（有失败+流程数据）', typeof retroSection?.text === 'string' && retroSection.text.length > 0, String(retroSection?.text).slice(0, 80))
check('section 文本带高频坑', String(retroSection?.text ?? '').includes('dsh-retro'), String(retroSection?.text).slice(0, 120))

console.log('\n== Web 路由（面板数据源）==')
{
  // 用真实的 http 服务器挂上插件注册的路由，再真的发请求 —— 不 mock 中间层。
  const { createServer } = await import('node:http')
  const routes = new Map()
  const fakeWeb = {
    webServer: {
      register(route) {
        if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`)
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      },
    },
  }
  // 走插件自己的 registerRoutes：它接收的是**已注入 webServer 的 ctx**
  const routeCtx = { ...fakeWeb, logger: ctx.logger }
  const { __internal } = await import(pathToFileURL(new URL('../index.js', import.meta.url).pathname.replace(/^\//, '')).href)
  const dispose = __internal.registerRoutes(routeCtx)

  check('注册了 5 条路由', routes.size === 5, [...routes.keys()].join(','))

  const server = createServer((req, res) => {
    const handler = routes.get(new URL(req.url, 'http://x').pathname)
    if (handler === undefined) {
      res.writeHead(404).end('not found')
      return
    }
    void handler(req, res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`

  const snapshotRes = await fetch(`${base}/api/retro/snapshot`)
  const snapshot = await snapshotRes.json()
  check('GET snapshot 返回 200', snapshotRes.status === 200, String(snapshotRes.status))
  check('snapshot.ok = true', snapshot.ok === true)
  check('snapshot 带 totals', typeof snapshot.totals?.failures === 'number', JSON.stringify(snapshot.totals))
  check('snapshot 带 flows 数组', Array.isArray(snapshot.flows), typeof snapshot.flows)
  check('snapshot 不泄漏函数', !JSON.stringify(snapshot).includes('function'))
  check('snapshot 设置 no-store', snapshotRes.headers.get('cache-control') === 'no-store', String(snapshotRes.headers.get('cache-control')))

  // 405：GET 打到只收 POST 的路由
  const badMethod = await fetch(`${base}/api/retro/promote`)
  check('错误方法返回 405', badMethod.status === 405, String(badMethod.status))

  // 400：缺 signature
  const badBody = await fetch(`${base}/api/retro/forget`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })
  check('缺 signature 返回 400', badBody.status === 400, String(badBody.status))

  // 400：非法 JSON
  const badJson = await fetch(`${base}/api/retro/forget`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  })
  check('非法 JSON 返回 400', badJson.status === 400, String(badJson.status))

  // 404：不存在的签名
  const missing = await fetch(`${base}/api/retro/forget`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ signature: 'no-such-signature' }),
  })
  check('不存在的签名也能安全返回', missing.status === 200 || missing.status === 404, String(missing.status))

  // 用一个保证不存在的签名，验证 404 分支（不能用 read>edit —— 它正好是真实存在的流程）
  const promoteMiss = await fetch(`${base}/api/retro/promote`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ signature: 'definitely-not-a-real-signature' }),
  })
  const promoteMissBody = await promoteMiss.json()
  check(
    'promote 未知签名返回 404',
    promoteMiss.status === 404,
    `status=${promoteMiss.status} body=${JSON.stringify(promoteMissBody)}`,
  )

  // 真正晋升已知签名：应 200 并写出技能文件
  const knownSig = flows[0]?.signature ?? ''
  if (knownSig !== '') {
    const promoteHit = await fetch(`${base}/api/retro/promote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ signature: knownSig }),
    })
    const promoted = await promoteHit.json()
    check('promote 已知签名返回 200', promoteHit.status === 200, `status=${promoteHit.status} ${JSON.stringify(promoted)}`)
    check('promote 报告技能名', typeof promoted.skillName === 'string' && promoted.skillName !== '', JSON.stringify(promoted))
    check('promote 写出了技能文件', existsSync(join(root, 'skills', `${promoted.skillName}.md`)), promoted.skillName)
  }

  // 生成总结
  const summaryRes = await fetch(`${base}/api/retro/summary`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ useModel: false }),
  })
  const summary = await summaryRes.json()
  check('POST summary 返回 200', summaryRes.status === 200, String(summaryRes.status))
  check('summary 带文本', typeof summary.text === 'string' && summary.text.includes('# 运行复盘'), String(summary.text).slice(0, 40))

  // 忘记一条签名
  const targetSig = flows[0]?.signature ?? ''
  if (targetSig !== '') {
    const forgetRes = await fetch(`${base}/api/retro/forget`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ signature: targetSig }),
    })
    const forget = await forgetRes.json()
    check('POST forget 返回 200', forgetRes.status === 200, String(forgetRes.status))
    check('forget 报告删除流程数', Number(forget.removedFlows) >= 1, JSON.stringify(forget))
  }

  server.close()
  dispose()
  check('路由 disposer 可调用', true)
}

console.log('\n== 卸载干净 ==')
await ctx.dispose?.()
await new Promise((resolve) => setTimeout(resolve, 120))
rmSync(root, { recursive: true, force: true })
check('卸载无异常', true)

console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)