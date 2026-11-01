// scripts/verify-switches.mjs — 四个自动开关组合的回归（每个组合真跑一遍）
//
// 为什么值得单独一个文件：autoDraft / autoPromote 曾经是"嵌套"关系
// （晋升写在草稿分支里），于是「只开 autoPromote」看起来配置生效了、
// 日志也不报错，但技能永远不出现。这类"沉默失效"的开关必须逐个组合实测，
// 不能只看代码读着对不对。
//
// 期望行为（正交）：
//   autoDraft=0 autoPromote=0 → 什么都不产出
//   autoDraft=1 autoPromote=0 → drafts/ 有草稿，skills/ 空（等人工晋升）
//   autoDraft=0 autoPromote=1 → drafts/ + skills/ 都有（草稿顺带留一份）
//   autoDraft=1 autoPromote=1 → 同上
//
// 用法：node scripts/verify-switches.mjs

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
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
 * 用给定配置真跑插件：装配 → 喂 N 轮同一工具序列 → 读磁盘产物。
 * @returns {{ skills: string[], drafts: string[], flows: object[] }}
 */
/**
 * 用给定配置真跑插件：装配 → 喂 N 轮同一工具序列 → 读磁盘产物。
 * @param {object} config 传给插件的配置
 * @param {number} rounds 跑几轮
 * @param {{ usePureDefaults?: boolean }} options
 *   usePureDefaults=true 时不注入任何测试专用的默认覆盖，
 *   用于验证「别人刚装完、什么配置都不给」的真实行为。
 * @returns {{ skills: string[], drafts: string[], flows: object[], draftBodies: string[], skillBodies: string[] }}
 */
async function runScenario(config, rounds = 3, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'retro-switch-'))
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

  // 每次导入一个新模块实例：插件的 runtime 是模块级单例，
  // 复用同一次导入会让第二个场景看到第一个场景的 config。
  const mod = await import(`${pluginUrl}?scenario=${Date.now()}-${Math.random()}`)
  // 只有跑「默认值」场景时才不覆盖 flowThreshold —— 其余场景固定 2 轮触发，
  // 让断言与阈值解耦。
  const base = options.usePureDefaults === true ? {} : { flowThreshold: 2 }
  await mod.apply(ctx, { rootDir: root, ...base, ...config })

  const session = { id: 's', header: { cwd: root } }
  for (let turn = 1; turn <= rounds; turn += 1) {
    for (const handler of handlers.sessionEvent) {
      handler(session, { type: 'turn/start', data: { turn } })
      handler(session, { type: 'step/start', data: { turn, step: 1 } })
    }
    for (const tool of ['read', 'edit']) {
      for (const handler of handlers.toolsResult) {
        handler({ name: tool, arguments: {}, agent: { session } }, { isError: false, content: [] })
      }
    }
    for (const handler of handlers.sessionEvent) {
      handler(session, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
    }
  }

  const flowsFile = join(root, 'flows.jsonl')
  const flows = existsSync(flowsFile)
    ? readFileSync(flowsFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
    : []
  const listOf = (dir) => (existsSync(dir) ? readdirSync(dir) : [])

  const result = {
    skills: listOf(join(root, 'skills')),
    drafts: listOf(join(root, 'drafts')),
    flows,
  }
  // 草稿/技能的正文要在删目录前读出来
  result.draftBodies = result.drafts.map((name) => readFileSync(join(root, 'drafts', name), 'utf8'))
  result.skillBodies = result.skills.map((name) => readFileSync(join(root, 'skills', name), 'utf8'))
  rmSync(root, { recursive: true, force: true })
  return result
}

console.log('== 组合 1：两个都关 ==')
{
  // 默认值已改为全自动，测"都关"必须显式关掉两者
  const r = await runScenario({ autoDraft: false, autoPromote: false })
  check('流程仍被聚合（这是基础功能，不该被开关影响）', r.flows.length === 1 && r.flows[0].count === 3, JSON.stringify(r.flows[0]?.count))
  check('没有草稿', r.drafts.length === 0, r.drafts.join(','))
  check('没有技能', r.skills.length === 0, r.skills.join(','))
  check('流程未被标记为已晋升', r.flows[0]?.promoted !== true, String(r.flows[0]?.promoted))
}

console.log('\n== 组合 2：只开 autoDraft ==')
{
  const r = await runScenario({ autoDraft: true, autoPromote: false })
  check('生成了草稿', r.drafts.length === 1, r.drafts.join(','))
  check('草稿未进 catalog（skills 为空）', r.skills.length === 0, r.skills.join(','))
  check('流程未被标记为已晋升', r.flows[0]?.promoted !== true, String(r.flows[0]?.promoted))
  check('草稿是完整 SKILL.md（有 frontmatter 和步骤段）',
    r.draftBodies.length === 1 && r.draftBodies[0].startsWith('---\n') && r.draftBodies[0].includes('## 步骤'),
    r.draftBodies[0]?.slice(0, 40))
}

console.log('\n== 组合 3：只开 autoPromote（曾经的失效组合）==')
{
  const r = await runScenario({ autoDraft: false, autoPromote: true })
  check('生成了技能（关键：只开这一项也必须生效）', r.skills.length === 1, r.skills.join(','))
  check('技能文件名是 kebab-case', r.skills.length === 1 && /^[a-z0-9-]+\.md$/.test(r.skills[0]), r.skills.join(','))
  check('流程被标记为已晋升', r.flows[0]?.promoted === true, String(r.flows[0]?.promoted))
  check('同时留了一份草稿（便于回看来源）', r.drafts.length === 1, r.drafts.join(','))
  check('晋升来源记为 auto', r.flows[0]?.promotedBy === 'auto', String(r.flows[0]?.promotedBy))
}

console.log('\n== 组合 4：两个都开 ==')
{
  const r = await runScenario({ autoDraft: true, autoPromote: true })
  check('生成了技能', r.skills.length === 1, r.skills.join(','))
  check('生成了草稿', r.drafts.length === 1, r.drafts.join(','))
  check('技能与草稿同名', r.skills[0] === r.drafts[0], `${r.skills[0]} vs ${r.drafts[0]}`)
  check('流程未被重复晋升', r.flows[0]?.promoted === true, String(r.flows[0]?.promoted))
}

console.log('\n== 阈值未达时不该产出 ==')
{
  // flowThreshold 设 5，只跑 3 轮 → 不该有任何产物
  const r = await runScenario({ autoDraft: true, autoPromote: true, flowThreshold: 5 }, 3)
  check('流程 count 未达阈值', (r.flows[0]?.count ?? 0) < 5, String(r.flows[0]?.count))
  check('不生成草稿', r.drafts.length === 0, r.drafts.join(','))
  check('不生成技能', r.skills.length === 0, r.skills.join(','))
}

console.log('\n== 幂等：第 4 轮不该重复晋升 ==')
{
  // 跑 5 轮，阈值 2：应在第 2 轮晋升一次，之后保持
  const r = await runScenario({ autoDraft: true, autoPromote: true, flowThreshold: 2 }, 5)
  check('技能只有 1 个（没有重复写）', r.skills.length === 1, r.skills.join(','))
  check('草稿只有 1 个', r.drafts.length === 1, r.drafts.join(','))
  check('流程累计到 5 次', r.flows[0]?.count === 5, String(r.flows[0]?.count))
}

console.log('\n== 默认值：装完即最佳配置 ==')
{
  // 不传任何配置，直接用 DEFAULT_CONFIG —— 模拟"别人刚下载安装"
  const r = await runScenario({}, 5, { usePureDefaults: true })
  check('默认就落盘失败经验目录（基础功能自带）', r.flows.length === 1, String(r.flows.length))
  check('默认 autoDraft 开（生成草稿）', r.drafts.length === 1, r.drafts.join(','))
  check('默认 autoPromote 开（技能直接可用）', r.skills.length === 1, r.skills.join(','))
  check('默认阈值是 4 次（5 轮才触发，避免误判）', r.flows[0]?.count === 5, String(r.flows[0]?.count))
}

console.log('\n== 默认阈值不会把 3 次误判为固定流程 ==')
{
  // 默认 flowThreshold=4，只跑 3 轮不该晋升
  const r = await runScenario({}, 3, { usePureDefaults: true })
  check('3 轮未达默认阈值 4', (r.flows[0]?.count ?? 0) === 3, String(r.flows[0]?.count))
  check('未生成技能（避免噪音）', r.skills.length === 0, r.skills.join(','))
  check('未生成草稿', r.drafts.length === 0, r.drafts.join(','))
}

console.log('\n== 数量上限：自动技能不无限膨胀 ==')
{
  // 造 3 条不同流程、上限设 2 → 只应保留 2 个技能文件
  const root = mkdtempSync(join(tmpdir(), 'retro-prune-'))
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
  const mod = await import(`${pluginUrl}?prune=${Date.now()}`)
  await mod.apply(ctx, { rootDir: root, flowThreshold: 2, autoPromote: true, autoDraft: false, maxAutoSkills: 2 })

  const session = { id: 'p', header: { cwd: root } }
  const runFlow = (tools, rounds) => {
    for (let turn = 0; turn < rounds; turn += 1) {
      for (const h of handlers.sessionEvent) {
        h(session, { type: 'turn/start', data: { turn } })
        h(session, { type: 'step/start', data: { turn, step: 1 } })
      }
      for (const tool of tools) {
        for (const h of handlers.toolsResult) h({ name: tool, arguments: {}, agent: { session } }, { isError: false, content: [] })
      }
      for (const h of handlers.sessionEvent) {
        h(session, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
      }
    }
  }

  // 三类**工具集合互不相同**的工作（骨架是工具集合，所以要造真正不同的类别）：
  //   read+edit      → read>edit
  //   grep+pwsh      → grep>pwsh
  //   read+glob+task → glob>read>task
  runFlow(['read', 'edit'], 2)
  runFlow(['grep', 'pwsh'], 2)
  runFlow(['read', 'glob', 'task'], 2)

  const skillsAfter = readdirSync(join(root, 'skills'))
  check('技能数被限制在上限内', skillsAfter.length <= 2, `${skillsAfter.length}: ${skillsAfter.join(',')}`)
  // 最后晋升的那条一定被保留（keepSignature 保护）
  check('最新晋升的技能被保留', skillsAfter.some((name) => name.includes('glob') || name.includes('task')), skillsAfter.join(','))

  // 淘汰是「最久未命中优先」：最早的 read>edit 应已不在
  check('最久未命中的被淘汰', !skillsAfter.some((name) => name === 'flow-read-edit.md'), skillsAfter.join(','))

  rmSync(root, { recursive: true, force: true })
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
