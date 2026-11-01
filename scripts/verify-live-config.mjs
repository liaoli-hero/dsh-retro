// scripts/verify-live-config.mjs — 配置层闭环：真实的 profile 配置文件 → 插件行为
//
// 这一步是必要的：曾出现「配了 autoPromote 却不生效」，当时只验了插件内部逻辑，
// 没人验「配置文件 → 插件」这条链路。
//
// 路径全部相对定位，不含任何本机绝对路径 —— 这是能随包发布的测试脚本：
//   · 插件自身：相对本脚本所在包
//   · profile 配置：由 DSH_HOME（默认 ~/.dsh）推出，或 --profile 指定目录
//   · js-yaml：由 DSH_APP 指向的 dsh 安装目录解析，找不到就跳过 YAML 段落
//
// 用法：
//   node scripts/verify-live-config.mjs                    # 用 ~/.dsh/profiles/desktop
//   node scripts/verify-live-config.mjs --profile <目录>    # 指定 profile 根
//   DSH_APP=<dsh 的 node_modules/@deepseek-ai> node ...     # 指定安装位置
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = join(here, '..')

/** 本机 dsh 安装目录（含 @deepseek-ai/*），允许用 DSH_APP 覆盖。 */
const APP = process.env.DSH_APP || 'D:/DeepSeek Harness/resources/app/dsh/node_modules/@deepseek-ai'

/** Harness home：$DSH_HOME 优先，其次 ~/.dsh。 */
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')

/** profile 根：--profile 显式指定，否则取 dsh-retro 被安装处的上一级。 */
function resolveProfileDir() {
  const argv = process.argv.slice(2)
  const at = argv.indexOf('--profile')
  if (at >= 0 && typeof argv[at + 1] === 'string') return argv[at + 1]
  // 本包通常位于 <profile>/dsh-retro（或 <profile>/node_modules/dsh-retro）
  const parent = dirname(pkgRoot)
  if (existsSync(join(parent, 'cordis.patch.yml'))) return parent
  return join(DSH_HOME, 'profiles', 'desktop')
}

const profileDir = resolveProfileDir()
const patchPath = join(profileDir, 'cordis.patch.yml')

// js-yaml 只在「真的存在 profile 配置」时用：它属于宿主安装，随包不发布。
const yamlPath = join(APP.replace(/[\\/]+$/, ''), '..', 'js-yaml', 'index.js')

console.log('== 路径解析 ==')
console.log('  插件包:', pkgRoot)
console.log('  profile:', profileDir)
console.log('  配置文件:', patchPath, existsSync(patchPath) ? '(存在)' : '(不存在)')

let config = {}
if (existsSync(patchPath) && existsSync(yamlPath)) {
  const yaml = await import(pathToFileURL(yamlPath).href)
  const doc = yaml.default.load(readFileSync(patchPath, 'utf8'))
  const entry = Array.isArray(doc) ? doc.find((item) => item && item.id === 'dsh-retro') : undefined
  console.log('\n== 配置文件读出 ==')
  console.log('  dsh-retro 条目:', JSON.stringify(entry))
  config = entry?.config ?? {}
} else {
  // 没有真实 profile 也照样跑：这正好等价于「别人刚装完、什么都没配」
  console.log('\n== 没有可用 profile 配置，按"纯默认值"继续（等价于全新安装）==')
}
console.log('  config:', JSON.stringify(config))

// 用真实插件的 normalizeConfig 把配置归一化，确认键名被正确接受
const store = await import(pathToFileURL(join(pkgRoot, 'lib', 'store.js')).href)
const normalized = store.normalizeConfig(config)
console.log('  归一化后 autoDraft =', normalized.autoDraft, ', autoPromote =', normalized.autoPromote)

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

console.log('\n== 配置归一化 ==')
// 配置文件现在只写 install 行（不带 config），所以这里验的是**默认值本身**
// 就已经是全自动配置 —— 这正是"别人下载安装即最佳配置"的断言。
check('部署配置不含 autoDraft 覆盖时，默认即 true', normalized.autoDraft === true, String(normalized.autoDraft))
check('部署配置不含 autoPromote 覆盖时，默认即 true', normalized.autoPromote === true, String(normalized.autoPromote))
check('默认 flowThreshold 是 4', normalized.flowThreshold === 4, String(normalized.flowThreshold))
check('enabled 默认为 true', normalized.enabled === true, String(normalized.enabled))
check('默认 promptBudget 是 1200', normalized.promptBudget === 1200, String(normalized.promptBudget))
check('默认 maxAutoSkills 有上限（防膨胀）', normalized.maxAutoSkills === 40, String(normalized.maxAutoSkills))

// ---------------------------------------------------------------- 真跑一遍
console.log('\n== 用这份配置真跑三轮 ==')
{
  const root = mkdtempSync(join(tmpdir(), 'retro-live-config-'))
  const handlers = { toolsResult: [], sessionEvent: [] }
  const ctx = {
    logger: { info: () => {}, debug: () => {}, warn: (m) => console.log('  WARN', m), error: (m) => console.log('  ERR', m) },
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

  const pluginUrl = pathToFileURL(join(pkgRoot, 'index.js')).href
  const mod = await import(`${pluginUrl}?live=${Date.now()}`)
  // 只给 rootDir（指到临时目录），其余**完全用默认值** ——
  // 这就是"别人下载安装、不做任何配置"的真实路径。
  await mod.apply(ctx, { ...config, rootDir: root })

  const session = { id: 'live', header: { cwd: root } }
  // 默认 flowThreshold=4，跑 4 轮正好达阈值
  const ROUNDS = 4
  for (let turn = 1; turn <= ROUNDS; turn += 1) {
    for (const h of handlers.sessionEvent) {
      h(session, { type: 'turn/start', data: { turn } })
      h(session, { type: 'step/start', data: { turn, step: 1 } })
    }
    for (const tool of ['read', 'edit', 'pwsh']) {
      for (const h of handlers.toolsResult) h({ name: tool, arguments: {}, agent: { session } }, { isError: false, content: [] })
    }
    for (const h of handlers.sessionEvent) {
      h(session, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
    }
  }

  const skillsDir = join(root, 'skills')
  const draftsDir = join(root, 'drafts')
  const skills = existsSync(skillsDir) ? readdirSync(skillsDir) : []
  const drafts = existsSync(draftsDir) ? readdirSync(draftsDir) : []
  const flowsFile = join(root, 'flows.jsonl')
  const flows = existsSync(flowsFile) ? readFileSync(flowsFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []

  console.log('  流程:', flows.length, '条, count =', flows[0]?.count, ', promoted =', flows[0]?.promoted)
  console.log('  草稿:', drafts.join(', ') || '（空）')
  console.log('  技能:', skills.join(', ') || '（空）')

  check('流程被聚合', flows.length === 1 && flows[0].count === ROUNDS, JSON.stringify(flows[0]?.count))
  check('自动晋升生效（技能已生成）', skills.length === 1, skills.join(','))
  check('草稿也留了一份', drafts.length === 1, drafts.join(','))
  check('流程被标记为已晋升', flows[0]?.promoted === true, String(flows[0]?.promoted))
  check('晋升来源记为 auto', flows[0]?.promotedBy === 'auto', String(flows[0]?.promotedBy))
  check('技能文件是完整 SKILL.md', skills.length === 1 && readFileSync(join(skillsDir, skills[0]), 'utf8').includes('## 步骤'))

  rmSync(root, { recursive: true, force: true })
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
