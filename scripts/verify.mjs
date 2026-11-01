// scripts/verify.mjs — 纯逻辑回归（不启动宿主、不联网、不需要 node_modules）
//
// 覆盖三块最容易悄悄坏掉的纯函数：
//   ① 失败经验的结构化与聚合（classify / signature / aggregate）
//   ② 流程序列的窗口跟踪与聚合（openWindow → recordStep → closeWindow → mergeFlow）
//   ③ 技能渲染与 frontmatter 往返（renderSkill → parseFrontmatter → 字段一致）
// 以及注入摘要的预算硬约束。
//
// 用法：node scripts/verify.mjs [--strict]
//   --strict：任何 console.warn 也算失败（CI 用）。

import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { aggregateFailures, classifyFailure, makeFailureRecord, flowSignature, skillNameFor } from '../lib/experience.js'
import { closeWindow, listSkills, mergeFlow, openWindow, readFlows, recordStep, setHint } from '../lib/flows.js'
import { parseFrontmatter, renderSkill, worthPromoting } from '../lib/skillgen.js'
import { classHistogram, pickLessons, recentLessons, renderPromptDigest, renderSummaryMarkdown } from '../lib/summary.js'
import { kebab, redact } from '../lib/util.js'

const strict = process.argv.includes('--strict')
const warnings = []
const originalWarn = console.warn
console.warn = (...args) => {
  warnings.push(args.join(' '))
  originalWarn(...args)
}

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

function group(title) {
  console.log(`\n== ${title} ==`)
}

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-retro-verify-'))

try {
  // ---------------------------------------------------------------- ① 经验
  group('失败经验：归类、签名、聚合')
  check('ENOENT → not-found', classifyFailure('Error: ENOENT: no such file or directory').id === 'not-found')
  check('权限拒绝 → sandbox-denied', classifyFailure('sandbox: file access denied under workspace-write mode').id === 'sandbox-denied')
  check('连接拒绝 → network', classifyFailure('connect ECONNREFUSED 127.0.0.1:5432').id === 'network')
  check('参数错误 → syntax-args', classifyFailure("invalid option: --frobnicate (usage: tool [opts])").id === 'syntax-args')
  check('未知错误落到 unknown', classifyFailure('qqq zzz').id === 'unknown')

  const recA = makeFailureRecord(
    { sessionId: 's1', tool: 'read', errorText: 'ENOENT: no such file C:\\a\\b.txt' },
    { now: '2026-10-31T00:00:00.000Z' },
  )
  const recB = makeFailureRecord(
    { sessionId: 's2', tool: 'read', errorText: 'ENOENT: no such file C:\\x\\y.txt' },
    { now: '2026-10-31T00:01:00.000Z' },
  )
  check('同类别同工具 → 同签名', recA.signature === recB.signature, `${recA.signature} vs ${recB.signature}`)
  check('不同会话也算同一坑', recA.signature.startsWith('not-found|read|'))

  const secret = makeFailureRecord(
    { tool: 'pwsh', errorText: 'Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz123456' },
    { now: '2026-10-31T00:02:00.000Z' },
  )
  check('脱敏：不保留原始令牌', !/sk-abcdefghijklmnopqrstuvwxyz/.test(JSON.stringify(secret)), secret.detail)

  const aggregated = aggregateFailures([recA, recB, secret])
  check('聚合出 2 个签名', aggregated.length === 2, String(aggregated.length))
  check('按命中次数降序', aggregated[0].count === 2, String(aggregated[0]?.count))
  check('会话去重计数', aggregated[0].sessions === 2, String(aggregated[0]?.sessions))
  check('聚合带出教训', typeof aggregated[0].lesson === 'string' && aggregated[0].lesson.length > 10)

  // ---------------------------------------------------------------- ② 流程
  group('固定流程：窗口、签名、聚合')
  check('单步不成流程', flowSignature(['read']) === null)
  check('相邻重复折叠', flowSignature(['read', 'read', 'edit']) === 'read>edit')

  openWindow('sess-1', 1, '')
  setHint('sess-1', '给项目加一个冒烟测试')
  recordStep('sess-1', 'read')
  recordStep('sess-1', 'edit')
  recordStep('sess-1', 'pwsh')
  const first = closeWindow('sess-1')
  check('关闭窗口得到序列', first !== null && first.signature === 'read>edit>pwsh', JSON.stringify(first))
  check('意图作为标题线索', first.hint.startsWith('给项目加一个冒烟测试'))
  check('窗口关闭后不可重复取', closeWindow('sess-1') === null)

  const flowsFile = join(sandbox, 'flows.jsonl')
  const one = mergeFlow(flowsFile, first, { sessionId: 'sess-1', now: '2026-10-31T01:00:00.000Z' })
  check('首次写入 count=1', one.count === 1 && one.created === true)
  check('生成 kebab 技能名', /^flow-[a-z0-9-]+$/.test(one.entry.skillName), one.entry.skillName)

  openWindow('sess-2', 1, '')
  recordStep('sess-2', 'read')
  recordStep('sess-2', 'edit')
  recordStep('sess-2', 'pwsh')
  const second = closeWindow('sess-2')
  const two = mergeFlow(flowsFile, second, { sessionId: 'sess-2', now: '2026-10-31T02:00:00.000Z' })
  check('同流程累加 count=2', two.count === 2, String(two.count))
  check('标题不被后续输入覆盖', two.entry.title === one.entry.title, `${two.entry.title}`)
  check('落盘只有一条记录', readFlows(flowsFile).length === 1)

  // ---------------------------------------------------------------- ③ 技能
  group('技能：渲染与 frontmatter 往返')
  const steps = [
    { name: 'read', note: '先读目标文件' },
    { name: 'edit', note: '' },
    { name: 'pwsh', note: '跑测试验证' },
  ]
  const rendered = renderSkill({
    name: 'flow-demo',
    title: '演示流程',
    description: '读 → 改 → 验证 的三步流程',
    whenToUse: '需要改动既有代码并验证时',
    signature: 'read>edit>pwsh',
    steps,
    samples: 3,
    pitfalls: [{ classLabel: '路径/对象不存在', tool: 'read', count: 2, lesson: '先列举真实路径' }],
    notes: ['注意保留原文件备份'],
  })
  check('文件以 frontmatter 开头', rendered.startsWith('---\n'))
  check('含 name 字段', /^name: flow-demo$/m.test(rendered))
  check('含 steps 列表', rendered.includes('1. `read`') && rendered.includes('3. `pwsh`'))
  check('坑段落来自失败记录', rendered.includes('先列举真实路径'))

  const parsed = parseFrontmatter(rendered)
  check('往返：name', parsed.data.name === 'flow-demo', String(parsed.data.name))
  check('往返：description', parsed.data.description === '读 → 改 → 验证 的三步流程', String(parsed.data.description))
  check('往返：metadata.signature', parsed.data.metadata?.signature === 'read>edit>pwsh', JSON.stringify(parsed.data.metadata))
  check('往返：正文可加载', parsed.body.includes('# 演示流程') && !parsed.body.startsWith('---'))

  check('样本不足不推荐晋升', worthPromoting({ samples: 1, steps, threshold: 3 }).ok === false)
  check('样本足够推荐晋升', worthPromoting({ samples: 3, steps, threshold: 3 }).ok === true)
  check('单步流程不晋升', worthPromoting({ samples: 9, steps: [{ name: 'read' }], threshold: 3 }).ok === false)

  // 技能发现（listSkills）读取磁盘上的真实文件
  const skillsDir = join(sandbox, 'skills')
  mkdirSync(skillsDir, { recursive: true })
  writeFileSync(join(skillsDir, 'flow-demo.md'), rendered, 'utf8')
  const discovered = listSkills(skillsDir)
  check('listSkills 找到 1 个技能', discovered.length === 1, String(discovered.length))
  check('listSkills 读出 description', discovered[0].description === '读 → 改 → 验证 的三步流程')
  check('listSkills 读出 whenToUse', discovered[0].whenToUse === '需要改动既有代码并验证时')

  // ---------------------------------------------------------------- ④ 摘要
  group('自我总结与提示词注入')
  const histogram = classHistogram(aggregated)
  check('直方图按命中降序', histogram[0].hits === 2, JSON.stringify(histogram[0]))

  const lessons = pickLessons(aggregated, { repeatThreshold: 2, topN: 3 })
  check('高频坑优先', lessons.length === 1 && lessons[0].count === 2, JSON.stringify(lessons.map((l) => l.count)))
  check('未达阈值不冒充高频坑', pickLessons(aggregated, { repeatThreshold: 5, topN: 3 }).length === 0)
  check('近期坑单独取', recentLessons(aggregated, { topN: 5 }).length === aggregated.length)

  const markdown = renderSummaryMarkdown({
    generatedAt: '2026-10-31T03:00:00.000Z',
    totals: { turns: 4, tools: 20, failures: 2, distinct: 2, flows: 1, skills: 1 },
    histogram,
    lessons,
    flows: [{ signature: 'read>edit>pwsh', count: 3, title: '演示流程', promoted: true }],
    skills: [{ name: 'flow-demo', description: '读 → 改 → 验证' }],
  })
  check('总结含规模表', markdown.includes('| 会话轮次 | 4 |'))
  check('总结含流程行（技能列）', markdown.includes('| 演示流程 | 3 | 已沉淀 |'))

  const digest = renderPromptDigest({
    lessons,
    flows: [{ title: '演示流程', count: 3, skillName: 'flow-demo' }],
    skills: [{ name: 'flow-demo', description: '读 → 改 → 验证' }],
    generatedAt: '2026-10-31',
    budget: 400,
  })
  check('摘要非空且在预算内', digest.length > 0 && digest.length <= 400, String(digest.length))
  check('摘要含高频坑', digest.includes('已识别的固定流程'))

  check('budget=0 不注入', renderPromptDigest({ lessons, flows: [], skills: [], generatedAt: '', budget: 0 }) === '')
  const tiny = renderPromptDigest({
    lessons,
    flows: [{ title: '演示流程', count: 3 }],
    skills: [{ name: 'flow-demo', description: 'x' }],
    generatedAt: '2026-10-31',
    budget: 30,
  })
  check('预算极小时不硬塞完整块', tiny.length <= 30, String(tiny.length))
  check('无数据时不注入', renderPromptDigest({ lessons: [], flows: [], skills: [], generatedAt: '', budget: 800 }) === '')

  // ---------------------------------------------------------------- ⑤ 杂项
  group('工具函数边界')
  check('kebab 去掉非法字符', kebab('给项目 Add a Test!') === 'add-a-test', kebab('给项目 Add a Test!'))
  check('kebab 空输入', kebab('!!!') === '')
  check('skillNameFor 回落哈希', skillNameFor('read>edit>pwsh', '').startsWith('flow-read-edit-pwsh'), skillNameFor('read>edit>pwsh', ''))
  check('redact 保留正常文本', redact('普通中文说明 without secrets') === '普通中文说明 without secrets')
  check('redact 抹掉长 base64', redact(`token=${'A'.repeat(80)}`).includes('***REDACTED***'))
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}

// 自检：本脚本必须能读到包清单里的入口
group('包清单')
try {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  check('main 指向 index.js', manifest.main === 'index.js', String(manifest.main))
  check('声明了 bundle patch', manifest.dsh?.bundle?.patch === './cordis.patch.yml', JSON.stringify(manifest.dsh))
  check('无运行时依赖', Object.keys(manifest.dependencies ?? {}).length === 0)
} catch (error) {
  check('包清单可读', false, String(error?.message ?? error))
}

if (strict && warnings.length > 0) {
  failed += warnings.length
  console.error(`\n--strict: ${warnings.length} 条 warn 视为失败`)
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
