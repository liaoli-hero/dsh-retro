// scripts/verify-e2e.mjs — 端到端链路：会话事件 → 失败沉淀 → 流程聚合 → 技能晋升
//
// 与 verify.mjs 的分工：verify.mjs 测纯函数；这里测**接线**：
// 再喂一串伪造的 session/event 与 tools/result，看插件是否按预期产出文件。
//
// 与 verify-host.mjs 的分工：本脚本不依赖真实宿主，只**可选地**用宿主的
// dsh-tools 校验工具 schema（找不到就明确说明跳过了什么）。
//
// 用法：
//   node scripts/verify-e2e.mjs                       # 不校验 schema，其余全跑
//   DSH_APP=<dsh 的 node_modules/@deepseek-ai> node ... # 额外校验 schema
//
// 重要：找不到宿主时**不会**假装全过 —— 会打印 SKIP 提示并说明少验了什么，
// 避免"green 但什么都没验"的假信号。

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const APP = process.env.DSH_APP || 'D:/DeepSeek Harness/resources/app/dsh/node_modules/@deepseek-ai'
const TOOLS_PATH = join(APP, 'dsh-tools', 'lib', 'index.js')

let passed = 0
let failed = 0
/** 因环境缺失而未执行的断言：单独计数并回显，绝不计入 passed。 */
const skipped = []
function check(label, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failed += 1
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

let dshTools = null
if (existsSync(TOOLS_PATH)) {
  dshTools = await import(pathToFileURL(TOOLS_PATH).href)
  console.log(`  · 用真机 dsh-tools 校验 schema：${TOOLS_PATH}`)
} else {
  // 明确写在开头和结尾，避免"green 但少验了一层"的假信号
  console.log(`  SKIP 找不到 dsh-tools（${TOOLS_PATH}）`)
  console.log('       → 本次不校验工具 JSON Schema；其余链路照常验。')
  console.log('       → 要完整校验：设 DSH_APP 指向 dsh 的 node_modules/@deepseek-ai')
}

const root = mkdtempSync(join(tmpdir(), 'dsh-retro-e2e-'))
const handlers = { toolsResult: [], sessionEvent: [], effect: [] }
const tools = new Map()
const registered = { provider: null, section: null, command: null }

const ctx = {
  logger: { info: () => {}, debug: () => {}, warn: (m) => console.log('WARN', m), error: (m) => console.log('ERR', m) },
  tools: {
    register(definition) {
      if (dshTools) {
        dshTools.assertSupportedJsonSchema(definition.parameters)
        dshTools.assertSupportedJsonSchema(definition.output.schema)
      }
      tools.set(definition.name, definition)
      return () => {}
    },
  },
  on(event, handler) {
    if (event === 'tools/result') handlers.toolsResult.push(handler)
    if (event === 'session/event') handlers.sessionEvent.push(handler)
    return () => {}
  },
  inject(names, cb) {
    // 像真 Cordis 一样：只有注入的服务确实存在时才执行回调。
    // 早期版本无条件回调，于是「webServer 不存在」也会进去跑一遍，
    // 结果是日志里多一条 WARN，却看不出这是 mock 自身的问题。
    const available = names.every((name) => ctx[name] !== undefined)
    if (available) cb(ctx)
  },
  effect(fn, label) {
    handlers.effect.push({ dispose: fn(), label })
    return () => {}
  },
  get() {
    return undefined
  },
  skills: {
    registerProvider(create) {
      registered.provider = create({ invalidate: () => {}, signal: new AbortController().signal })
      return () => {}
    },
  },
  systemPrompt: {
    section(section) {
      registered.section = section
      return () => {}
    },
  },
  commands: {
    register(command) {
      registered.command = command
      return () => {}
    },
  },
}

const plugin = await import(pathToFileURL(new URL('../index.js', import.meta.url).pathname.slice(1)).href)
await plugin.apply(ctx, {
  rootDir: root,
  autoDraft: true,
  autoPromote: true,
  flowThreshold: 2,
  repeatThreshold: 2,
  promptBudget: 900,
  mirrorToUserSkills: false,
})

console.log('\n== 接线 ==')
check('注册 4 个工具', tools.size === 4, [...tools.keys()].join(','))
check('技能 provider 名为 dsh-retro', registered.provider?.name === 'dsh-retro')
check('提示词 section 关闭插值', registered.section?.interpolate === false)
check('/retro 命令已注册', registered.command?.name === 'retro')
check('注册了 teardown effect', handlers.effect.some((entry) => entry.label === 'dsh-retro: teardown'))

// ---------------------------------------------------------------- 会话事件
const session = { id: 'sess-e2e', header: { cwd: 'C:/proj' } }
const emit = (event) => {
  for (const handler of handlers.sessionEvent) handler(session, event)
}
const emitToolFailure = (name, message, args) => {
  for (const handler of handlers.toolsResult) {
    handler({ name, arguments: args ?? {}, agent: { session } }, {
      isError: true,
      content: [{ type: 'text', text: `Error: ${message}` }],
      error: { message, info: { code: 'E_TEST' } },
    })
  }
}

console.log('\n== 三轮相同流程（应聚合成固定流程并自动晋升） ==')
for (let round = 1; round <= 3; round += 1) {
  emit({ type: 'turn/start', data: { turn: round } })
  emit({ type: 'step/start', data: { turn: round, step: 1 } })
  emit({
    type: 'user/message',
    data: { content: [{ type: 'text', text: '给项目加一个冒烟测试并验证通过' }], source: { kind: 'user' } },
  })
  for (const tool of ['read', 'edit', 'pwsh']) {
    for (const handler of handlers.toolsResult) {
      handler({ name: tool, arguments: {}, agent: { session } }, { isError: false, content: [] })
    }
  }
  emit({ type: 'step/end', data: { turn: round, step: 1 } })
  emit({ type: 'turn/end', data: { turn: round, reason: { kind: 'completed' } } })
}

const flowsFile = join(root, 'flows.jsonl')
const flows = existsSync(flowsFile) ? readFileSync(flowsFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []
check('落盘一条固定流程', flows.length === 1, String(flows.length))
check('累计 3 次', flows[0]?.count === 3, String(flows[0]?.count))
check('已标记晋升', flows[0]?.promoted === true, JSON.stringify(flows[0]?.promoted))
check('技能文件已生成', existsSync(join(root, 'skills', `${flows[0]?.skillName}.md`)), flows[0]?.skillName)

console.log('\n== 失败沉淀（同签名两次 → 进提示词） ==')
emit({ type: 'turn/start', data: { turn: 9 } })
emitToolFailure('write', 'sandbox: file access denied under workspace-write mode', { path: 'C:/outside/x.txt' })
emitToolFailure('write', 'sandbox: file access denied under workspace-write mode', { path: 'C:/outside/y.txt' })
emit({ type: 'turn/end', data: { turn: 9, reason: { kind: 'completed' } } })

const failsFile = join(root, 'fails.jsonl')
const fails = existsSync(failsFile) ? readFileSync(failsFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []
check('记录 2 条失败', fails.length === 2, String(fails.length))
check('同一签名去重', new Set(fails.map((f) => f.signature)).size === 1)
check('归类为权限拒绝', fails[0]?.class === 'sandbox-denied', fails[0]?.class)
check('保存了 cwd 与轮次', fails[0]?.cwd === 'C:/proj' && fails[0]?.turn === 9, `${fails[0]?.cwd}/${fails[0]?.turn}`)

// 摘要刷新是节流的，这里直接驱动一次 provider/section 读
const sectionText = registered.section.text({})
check('提示词已带上高频坑', sectionText.includes('权限/沙箱拒绝'), sectionText.slice(0, 120))
check('提示词已带上固定流程', sectionText.includes('已识别的固定流程'))
check('提示词长度在预算内', sectionText.length <= 900, String(sectionText.length))

console.log('\n== 技能 provider 能列出并加载 ==')
const listed = await registered.provider.list()
check('provider 列出 1 个技能', listed.candidates.length === 1, String(listed.candidates.length))
const candidate = listed.candidates[0]
const loaded = await registered.provider.get(candidate)
check('技能正文可加载', typeof loaded.content === 'string' && loaded.content.includes('## 步骤'))
check('技能名与目录一致', loaded.name === flows[0].skillName, `${loaded.name} vs ${flows[0].skillName}`)

// 幂等：再跑一轮同一流程，不应重写技能文件、也不应再次失效目录
const skillsFile = join(root, 'skills', `${flows[0].skillName}.md`)
const beforeMtime = readFileSync(skillsFile, 'utf8')
emit({ type: 'turn/start', data: { turn: 20 } })
for (const tool of ['read', 'edit', 'pwsh']) {
  for (const handler of handlers.toolsResult) handler({ name: tool, arguments: {}, agent: { session } }, { isError: false, content: [] })
}
const { setHint: _ignored } = {}
emit({ type: 'turn/end', data: { turn: 20, reason: { kind: 'completed' } } })
const flowsAgain = readFileSync(flowsFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
check('流程继续累计到 4 次', flowsAgain[0]?.count === 4, String(flowsAgain[0]?.count))
check('技能文件内容未变（幂等）', readFileSync(skillsFile, 'utf8') === beforeMtime)

// ---------------------------------------------------------------- 工具面
console.log('\n== 工具面 ==')
const summaryOut = await tools.get('retro_summary').execute({ mode: 'refresh' }, {})
check('retro_summary 输出含规模表', summaryOut.includes('| 失败记录 | 2 |'), summaryOut.split('\n').slice(0, 3).join(' '))
if (dshTools) {
  check(
    '输出符合声明 schema',
    dshTools.validateJsonSchemaValue(tools.get('retro_summary').output.schema, summaryOut, 'value').length === 0,
  )
} else {
  skipped.push('输出符合声明 schema（需要 dsh-tools）')
}

const skillsOut = await tools.get('retro_skills').execute({ action: 'list' }, {})
check('retro_skills 列出已沉淀技能', skillsOut.includes(flows[0].skillName), skillsOut.slice(0, 160))

const forgetOut = await tools.get('retro_forget').execute({ signature: fails[0].signature }, {})
check('retro_forget 报告删除数量', forgetOut.includes('失败记录 2 条'), forgetOut)

console.log('\n== 命令面 ==')
const show = await registered.command.handler({ rawInput: 'show' })
check('/retro show 可用', show.kind === 'success' && show.text.includes('运行复盘状态'))
const cleared = await registered.command.handler({ rawInput: 'forget nothing-here' })
check('/retro forget 幂等', cleared.kind === 'success')

// /retro set —— 运行期改设置，不重启
const setResult = await registered.command.handler({ rawInput: 'set flowThreshold=7 autoCapture=false' })
check('/retro set 成功', setResult.kind === 'success', setResult.text?.slice(0, 120))
check('/retro set 回显生效值', setResult.text.includes('"flowThreshold":7') || setResult.text.includes('flowThreshold = 7'), setResult.text?.slice(0, 200))
check('/retro set 标记运行期覆盖', setResult.text.includes('*'))

const configAfterSet = await registered.command.handler({ rawInput: 'config' })
check('/retro config 显示运行期覆盖值', configAfterSet.text.includes('flowThreshold = 7'), configAfterSet.text?.slice(0, 200))
check('/retro config 说明部署层与运行层', configAfterSet.text.includes('cordis.patch.yml') && configAfterSet.text.includes('settings.json'), configAfterSet.text?.slice(0, 400))

// 非法值应被拒并说明原因，而不是静默采纳
const badSet = await registered.command.handler({ rawInput: 'set flowThreshold=999' })
check('/retro set 拒绝超范围值', badSet.kind === 'error', badSet.text?.slice(0, 120))
check('/retro set 拒绝时说明范围', badSet.text.includes('10'), badSet.text)

// 重置回落到部署配置
const resetResult = await registered.command.handler({ rawInput: 'reset' })
check('/retro reset 成功', resetResult.kind === 'success', resetResult.text)
const configAfterReset = await registered.command.handler({ rawInput: 'config' })
check('/retro reset 后回落到部署配置', !configAfterReset.text.includes('flowThreshold = 7'), configAfterReset.text?.slice(0, 200))

// teardown：不应抛错
try {
  for (const entry of handlers.effect) await entry.dispose?.()
  check('teardown 无异常', true)
} catch (error) {
  check('teardown 无异常', false, String(error?.message ?? error))
}

rmSync(root, { recursive: true, force: true })
if (skipped.length > 0) {
  console.log(`\n跳过 ${skipped.length} 项（环境缺失，未计入通过）：`)
  for (const item of skipped) console.log(`  - ${item}`)
}
console.log(`\n结果：${passed} 通过 / ${failed} 失败${skipped.length > 0 ? ` / ${skipped.length} 跳过` : ''}`)
process.exit(failed === 0 ? 0 : 1)
