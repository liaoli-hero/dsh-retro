// lib/skillgen.js — 把「固定流程」渲染成 SKILL.md 草稿（纯函数，零依赖）
//
// SKILL.md 的契约由 @deepseek-ai/dsh-skill-filesystem 的前置元数据解析决定：
//   - 必须有 YAML frontmatter，含 name（kebab-case）与 description
//   - 可选 whenToUse / metadata / disable-model-invocation / user-invocable
//   - 文件位置：<root>/<name>/SKILL.md 或扁平 <root>/<name>.md（本插件用扁平形式）
// 生成器只产出**已定型**的文本，不做任何 IO，便于单测与人工 review。

import { oneLine } from './util.js'

/** 把步骤序列压成紧凑的编号列表。 */
function stepLines(steps) {
  return steps.map((step, index) => {
    const note = step.note ? ` — ${oneLine(step.note, 120)}` : ''
    return `${index + 1}. \`${step.name}\`${note}`
  })
}

/** 失败规避段：把该流程里踩过的坑前置成"别这么干"。 */
function pitfallSection(pitfalls) {
  if (pitfalls.length === 0) return ''
  const lines = pitfalls.map((entry) => `- **${entry.classLabel}**（${entry.tool}，${entry.count} 次）：${entry.lesson}`)
  return `\n## 已知坑（来自历史失败记录）\n\n${lines.join('\n')}\n`
}

/**
 * 渲染 SKILL.md 草稿。
 * @param {{
 *   name: string,
 *   title: string,
 *   description: string,
 *   whenToUse?: string,
 *   signature: string,
 *   steps: Array<{ name: string, note?: string }>,
 *   samples?: number,
 *   pitfalls?: Array<{ classLabel: string, tool: string, count: number, lesson: string }>,
 *   notes?: string[]
 * }} input
 * @returns {string}
 */
export function renderSkill(input) {
  const steps = Array.isArray(input.steps) ? input.steps.filter((step) => step && typeof step.name === 'string') : []
  const pitfalls = Array.isArray(input.pitfalls) ? input.pitfalls : []
  const notes = Array.isArray(input.notes) ? input.notes.filter((note) => typeof note === 'string' && note !== '') : []
  const description = oneLine(input.description, 400)
  const whenToUse = oneLine(input.whenToUse ?? '', 300)

  const front = [
    '---',
    `name: ${input.name}`,
    `description: ${yamlScalar(description)}`,
    ...(whenToUse !== '' ? [`whenToUse: ${yamlScalar(whenToUse)}`] : []),
    'metadata:',
    '  source: dsh-retro',
    `  signature: ${yamlScalar(input.signature)}`,
    `  samples: ${Number.isFinite(input.samples) ? input.samples : 0}`,
    `  generatedAt: ${yamlScalar(new Date().toISOString().slice(0, 10))}`,
    '---',
    '',
  ].join('\n')

  const body = [
    `# ${oneLine(input.title ?? input.name, 120)}`,
    '',
    oneLine(input.description, 400),
    '',
    '## 步骤',
    '',
    ...(steps.length > 0 ? stepLines(steps) : ['1. （历史样本里没有可识别的工具序列，请人工补全）']),
    '',
  ].join('\n')

  const noteSection =
    notes.length > 0 ? `\n## 注意\n\n${notes.map((note) => `- ${oneLine(note, 200)}`).join('\n')}\n` : ''

  const verification = [
    '',
    '## 验收',
    '',
    '- 每一步都留下可复核的输出（命令回显、文件 diff、测试结果），不要只看"看起来没报错"。',
    '- 流程跑完再收尾：确认产物落盘、无残留后台进程、无未提交的临时文件。',
    '',
  ].join('\n')

  return `${front}${body}${pitfallSection(pitfalls)}${noteSection}${verification}`
}

/** YAML 标量：含特殊字符时用双引号并转义。 */
function yamlScalar(text) {
  const value = String(text ?? '')
  if (value === '') return '""'
  // 安全裸标量：不含引号、冒号+空格、井号、换行、起始特殊符号
  if (/^[A-Za-z0-9\u4e00-\u9fff][^:#\n"'`]*$/.test(value) && !/\s$/.test(value)) return value
  return JSON.stringify(value)
}

/**
 * 判断草稿是否值得晋升：样本数够、步骤数够、且不是纯读写两步。
 * @param {{ samples: number, steps: Array<{name: string}>, threshold: number }} input
 */
export function worthPromoting(input) {
  const steps = Array.isArray(input.steps) ? input.steps : []
  if (steps.length < 2) return { ok: false, reason: '步骤少于 2 步，说明不了固定流程' }
  if (input.samples < input.threshold) {
    return { ok: false, reason: `样本 ${input.samples} 次，未达到阈值 ${input.threshold} 次` }
  }
  return { ok: true, reason: '' }
}

/** 极简 frontmatter 解析（只为读回自己写的草稿，不追求通用性）。 */
export function parseFrontmatter(text) {
  const raw = String(text ?? '')
  if (!raw.startsWith('---')) return { data: {}, body: raw }
  const end = raw.indexOf('\n---', 3)
  if (end < 0) return { data: {}, body: raw }
  const head = raw.slice(4, end)
  const body = raw.slice(raw.indexOf('\n', end + 1) + 1)
  const data = {}
  const stack = [{ indent: -1, target: data }]
  for (const line of head.split(/\r?\n/)) {
    if (line.trim() === '') continue
    const indent = line.length - line.trimStart().length
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim())
    if (!match) continue
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop()
    const parent = stack[stack.length - 1].target
    const key = match[1]
    const rest = match[2]
    if (rest === '') {
      const child = {}
      parent[key] = child
      stack.push({ indent, target: child })
    } else {
      parent[key] = rest.replace(/^["']|["']$/g, '')
    }
  }
  return { data, body }
}
