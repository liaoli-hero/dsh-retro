// lib/summary.js — 自我总结与提示词注入文本（纯函数，零依赖）
//
// 两条输出，用途不同：
//   ① renderSummaryMarkdown() —— 落盘给人看（summary.md），详尽。
//   ② renderPromptDigest()    —— 注入系统提示词给模型看，严格受限字数。
// 同一份统计喂两条路径，避免"人看到的"和"模型看到的"讲两套话。

import { oneLine } from './util.js'

/** 按类别统计失败分布。 */
export function classHistogram(aggregated) {
  const map = new Map()
  for (const entry of aggregated) {
    const key = entry.class ?? 'unknown'
    const current = map.get(key) ?? { class: key, classLabel: entry.classLabel ?? key, hits: 0, signatures: 0 }
    current.hits += entry.count
    current.signatures += 1
    map.set(key, current)
  }
  return [...map.values()].sort((a, b) => b.hits - a.hits)
}

/**
 * 从聚合结果里挑出「该记住的那几条」：命中次数 >= repeatThreshold 的才算。
 *
 * 刻意**不**在不足阈值时降级列出「只出现一次」的条目——提示词里写「已知高频坑」
 * 却列着一堆 1 次命中的噪音，会让模型过度规避本来正常的手段。要展示「近期踩过的坑」
 * 请走 {@link recentLessons}，两处文案不同、语义也不同。
 */
export function pickLessons(aggregated, { repeatThreshold = 2, topN = 6 } = {}) {
  return aggregated.filter((entry) => entry.count >= repeatThreshold).slice(0, topN)
}

/** 最近的失败（不看命中次数），供人读总结的补充段落使用。 */
export function recentLessons(aggregated, { topN = 5 } = {}) {
  return aggregated.slice(0, topN)
}

/**
 * 人读的总结（summary.md）。
 * @param {{
 *   generatedAt: string,
 *   totals: { turns: number, tools: number, failures: number, distinct: number, flows: number, skills: number },
 *   histogram: ReturnType<typeof classHistogram>,
 *   lessons: ReturnType<typeof pickLessons>,
 *   flows: Array<{ signature: string, count: number, title: string, promoted?: boolean }>,
 *   skills: Array<{ name: string, description: string }>,
 *   llmText?: string
 * }} input
 */
export function renderSummaryMarkdown(input) {
  const lines = []
  lines.push('# 运行复盘', '')
  lines.push(`生成时间：${input.generatedAt}`)
  lines.push('')
  lines.push('## 规模', '')
  lines.push('| 指标 | 数值 |')
  lines.push('| --- | --- |')
  lines.push(`| 会话轮次 | ${input.totals.turns} |`)
  lines.push(`| 工具调用 | ${input.totals.tools} |`)
  lines.push(`| 失败记录 | ${input.totals.failures} |`)
  lines.push(`| 不同失败签名 | ${input.totals.distinct} |`)
  lines.push(`| 已识别流程 | ${input.totals.flows} |`)
  lines.push(`| 已沉淀技能 | ${input.totals.skills} |`)
  lines.push('')

  if (input.histogram.length > 0) {
    lines.push('## 失败分布', '')
    lines.push('| 类别 | 命中 | 签名数 |')
    lines.push('| --- | --- | --- |')
    for (const row of input.histogram) lines.push(`| ${row.classLabel} | ${row.hits} | ${row.signatures} |`)
    lines.push('')
  }

  if (input.lessons.length > 0) {
    lines.push('## 该记住的坑（重复出现）', '')
    for (const entry of input.lessons) {
      lines.push(`### ${entry.classLabel} · \`${entry.tool}\` · ${entry.count} 次`)
      lines.push('')
      lines.push(`- 最近一次：${oneLine(entry.message, 200)}`)
      lines.push(`- 应对：${oneLine(entry.lesson, 300)}`)
      lines.push('')
    }
  } else if (Array.isArray(input.recent) && input.recent.length > 0) {
    lines.push('## 最近踩过的坑（尚未重复）', '')
    for (const entry of input.recent) {
      lines.push(`- ${entry.classLabel}／\`${entry.tool}\`：${oneLine(entry.message, 160)}`)
    }
    lines.push('')
  }

  if (input.flows.length > 0) {
    lines.push('## 固定流程', '')
    lines.push('| 流程 | 次数 | 技能 |')
    lines.push('| --- | --- | --- |')
    for (const flow of input.flows) {
      lines.push(`| ${oneLine(flow.title, 60)} | ${flow.count} | ${flow.promoted ? '已沉淀' : '草稿/未沉淀'} |`)
    }
    lines.push('')
  }

  if (input.skills.length > 0) {
    lines.push('## 已沉淀技能', '')
    for (const skill of input.skills) lines.push(`- \`${skill.name}\` — ${oneLine(skill.description, 140)}`)
    lines.push('')
  }

  if (typeof input.llmText === 'string' && input.llmText.trim() !== '') {
    lines.push('## 模型复盘', '', input.llmText.trim(), '')
  }

  if (lines.length <= 4) {
    lines.push('（还没有可复盘的数据：跑过几轮之后再看。）')
  }
  return `${lines.join('\n').trimEnd()}\n`
}

/**
 * 注入系统提示词的片段，严格受 budget 约束。
 * 返回 '' 表示不注入（关掉或没有内容），此时宿主不会追加任何文本。
 * @param {{
 *   lessons: ReturnType<typeof pickLessons>,
 *   flows: Array<{ title: string, count: number, skillName?: string }>,
 *   skills: Array<{ name: string, description: string }>,
 *   generatedAt: string,
 *   budget: number
 * }} input
 */
export function renderPromptDigest(input) {
  const budget = Number.isFinite(input.budget) ? input.budget : 0
  if (budget <= 0) return ''
  const head = '## 历史复盘（dsh-retro 自动沉淀）'
  const tail = `\n（更新于 ${input.generatedAt}；用 retro_summary 查看完整版）`

  const blocks = []
  if (input.lessons.length > 0) {
    const rows = input.lessons.map(
      (entry) => `- ${entry.classLabel}／${entry.tool}（${entry.count} 次）：${oneLine(entry.lesson, 120)}`,
    )
    blocks.push(['已知高频坑（动手前先规避）：', ...rows].join('\n'))
  }
  if (input.flows.length > 0) {
    const rows = input.flows
      .slice(0, 4)
      .map((flow) => `- ${oneLine(flow.title, 60)}${flow.skillName ? `（已有技能 ${flow.skillName}）` : ''}`)
    blocks.push(['已识别的固定流程：', ...rows].join('\n'))
  }
  if (input.skills.length > 0) {
    const rows = input.skills.slice(0, 6).map((skill) => `- ${skill.name}：${oneLine(skill.description, 90)}`)
    blocks.push(['已沉淀技能（可先看再动手）：', ...rows].join('\n'))
  }
  if (blocks.length === 0) return ''

  let text = head
  for (const block of blocks) {
    const candidate = `${text}\n\n${block}`
    if (candidate.length + tail.length > budget) break
    text = candidate
  }
  if (text === head) return ''
  const withTail = `${text}${tail}`
  return withTail.length <= budget ? withTail : text.slice(0, budget)
}

/** 给复盘模型用的输入：把统计压缩成结构化事实，禁止它自己编数据。 */
export function buildReviewPrompt(input) {
  const failLines = input.lessons.map(
    (entry) =>
      `- [${entry.classLabel}] 工具=${entry.tool} 次数=${entry.count} 最近=${oneLine(entry.message, 160)} 应对=${oneLine(entry.lesson, 200)}`,
  )
  const flowLines = input.flows.map(
    (flow) => `- 流程=${oneLine(flow.title, 60)} 次数=${flow.count} 序列=${flow.signature}`,
  )
  return [
    '你是运行复盘助手。下面是一个编码 Agent 会话的历史统计。',
    '只依据给定事实总结，不得编造未出现的命令、文件或结论。',
    '',
    '【失败统计】',
    failLines.length > 0 ? failLines.join('\n') : '（无）',
    '',
    '【流程统计】',
    flowLines.length > 0 ? flowLines.join('\n') : '（无）',
    '',
    '输出要求：',
    '1. 三条以内的「下次怎么做」可执行建议，每条一句话，动词开头。',
    '2. 一条「最该固化成技能」的流程及理由。',
    '3. 不要复述统计数字，不要写客套话，不要使用列表符号以外的格式。',
  ].join('\n')
}
