// lib/flows.js — 工作流序列的实时跟踪与聚合（纯逻辑 + 小 IO）
//
// 判定"固定工作流程"的方式刻意朴素：**同一条工具序列反复出现**。
// 不用 LLM 聚类的原因：
//   ① 聚类要花 token 且结果不稳定，同一份历史跑两次可能得到不同技能名；
//   ② 工具序列是客观事实，跨会话可比，且天然能映射回"可复现的步骤"；
//   ③ 该插件的产出是**草稿**，最终是否成为技能由人（或显式的晋升命令）决定。
//
// 一个 turn = 一次用户请求；序列按 turn 切分，避免跨请求拼接出不存在的流程。

import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { flowSignature, flowSkeleton, flowTitle, skillNameFor } from './experience.js'
import { atomicWrite, ensureDir, readJsonl } from './util.js'

/** 每个会话当前打开的工作流窗口（内存态，不落盘：重启后重新累积即可）。 */
const windows = new Map()

/** 开始一轮跟踪（turn 边界）。 */
export function openWindow(sessionId, turn, hint) {
  if (typeof sessionId !== 'string' || sessionId === '') return null
  const window = { turn: Number.isFinite(turn) ? turn : 0, steps: [], hint: typeof hint === 'string' ? hint : '', openedAt: Date.now() }
  windows.set(sessionId, window)
  return window
}

/** 设置窗口的意图线索（一轮里第一条真实用户输入）；只生效一次。 */
export function setHint(sessionId, hint) {
  const window = windows.get(sessionId)
  if (window === undefined) return false
  if (window.hint !== '') return false
  const text = typeof hint === 'string' ? hint.trim() : ''
  if (text === '') return false
  window.hint = text
  return true
}

/** 记录一次工具调用进当前窗口（没有窗口则忽略）。 */
export function recordStep(sessionId, toolName) {
  const window = windows.get(sessionId)
  if (window === undefined) return null
  if (typeof toolName !== 'string' || toolName === '') return window
  window.steps.push(toolName)
  return window
}

/**
 * 关闭窗口并返回观察结果。
 *
 * 两个字段分工明确：
 *   · `skeleton` —— **聚合键**（工具集合），同类任务会收敛，用于计数与晋升判定
 *   · `signature` —— **完整序列**，只给人和技能正文看"这一轮到底做了什么"
 *
 * 这两者之前是同一个值，导致真实任务（8~29 步、顺序各异）永远 count=1，
 * 阈值 4 达不到，技能一个也长不出来 —— 这是实测跑出来的问题。
 *
 * @returns {{ signature: string, skeleton: string, steps: string[], hint: string, turn: number } | null}
 */
export function closeWindow(sessionId) {
  const window = windows.get(sessionId)
  windows.delete(sessionId)
  if (window === undefined) return null
  const skeleton = flowSkeleton(window.steps)
  if (skeleton === null) return null
  return {
    signature: flowSignature(window.steps) ?? skeleton,
    skeleton,
    steps: window.steps.slice(),
    hint: window.hint,
    turn: window.turn,
  }
}

/** 供测试/诊断：当前打开的窗口数。 */
export function openWindowCount() {
  return windows.size
}

/** 读聚合表（flows.jsonl）。 */
export function readFlows(file) {
  return readJsonl(file, 5000).filter((entry) => typeof entry.signature === 'string')
}

/**
 * 把一次观察合并进聚合表并整体重写。
 *
 * 聚合键是 **skeleton**（工具集合），不是完整序列。完整序列只作为
 * `sampleSteps` 留一份实例，供技能正文展示"上一次实际怎么走的"。
 *
 * 兼容旧数据：早期条目没有 `skeleton` 字段，用它的 `signature` 兜底匹配，
 * 这样升级后已有记录不会全部作废。
 *
 * @param {string} file
 * @param {{ signature: string, skeleton?: string, steps: string[], hint: string }} observation
 * @param {{ maxFlows?: number, sessionId?: string, now?: string }} options
 * @returns {{ entry: object, count: number, created: boolean }}
 */
export function mergeFlow(file, observation, options = {}) {
  const maxFlows = Number.isFinite(options.maxFlows) ? options.maxFlows : 300
  const now = options.now ?? new Date().toISOString()
  const sessionId = typeof options.sessionId === 'string' ? options.sessionId : ''
  const skeleton = typeof observation.skeleton === 'string' && observation.skeleton !== ''
    ? observation.skeleton
    : observation.signature
  const entries = readFlows(file)
  const index = entries.findIndex((entry) => (entry.skeleton ?? entry.signature) === skeleton)

  if (index < 0) {
    const entry = {
      // signature 保留完整序列（人读 + 技能正文里的"上次实际步骤"）
      signature: observation.signature,
      // skeleton 是聚合键
      skeleton,
      steps: observation.steps.slice(0, 40),
      title: flowTitle(skeleton, observation.hint),
      skillName: skillNameFor(skeleton, observation.hint),
      count: 1,
      firstTs: now,
      lastTs: now,
      sessions: sessionId === '' ? [] : [sessionId],
      promoted: false,
      draft: null,
    }
    entries.push(entry)
    persist(file, entries, maxFlows)
    return { entry, count: 1, created: true }
  }

  const entry = entries[index]
  entry.count = (Number.isFinite(entry.count) ? entry.count : 0) + 1
  entry.lastTs = now
  // 每次命中都刷新样本：技能正文展示的是"最近一次真实执行"，而不是第一次的
  entry.signature = observation.signature
  entry.steps = observation.steps.slice(0, 40)
  if (!Array.isArray(entry.sessions)) entry.sessions = []
  if (sessionId !== '' && !entry.sessions.includes(sessionId)) {
    entry.sessions = [...entry.sessions, sessionId].slice(-50)
  }
  // 标题在首次出现时由当时的用户输入决定；后续用户输入不再覆盖，避免同名流程漂移
  if (typeof entry.title !== 'string' || entry.title === '') entry.title = flowTitle(skeleton, observation.hint)
  if (typeof entry.skillName !== 'string' || entry.skillName === '') {
    entry.skillName = skillNameFor(skeleton, observation.hint)
  }
  if (typeof entry.skeleton !== 'string') entry.skeleton = skeleton
  persist(file, entries, maxFlows)
  return { entry, count: entry.count, created: false }
}

/** 按次数排序并截断尾部。 */
function persist(file, entries, maxFlows) {
  const sorted = entries.slice().sort((a, b) => (b.count ?? 0) - (a.count ?? 0) || String(b.lastTs).localeCompare(String(a.lastTs)))
  const kept = sorted.slice(0, Math.max(20, maxFlows))
  ensureDir(join(file, '..'))
  atomicWrite(file, kept.map((entry) => JSON.stringify(entry)).join('\n') + (kept.length > 0 ? '\n' : ''))
}

/** 更新某条流程的晋升状态。 */
export function markPromoted(file, signature, skillName, maxFlows = 300) {
  const entries = readFlows(file)
  const entry = entries.find((item) => item.signature === signature)
  if (entry === undefined) return false
  entry.promoted = true
  entry.skillName = skillName
  entry.promotedAt = new Date().toISOString()
  persist(file, entries, maxFlows)
  return true
}

/** 记录晋升来源：'auto' = 达阈值自动，'manual' = 人在面板/命令里点的。 */
export function markPromotedBy(file, signature, origin, maxFlows = 300) {
  const entries = readFlows(file)
  const entry = entries.find((item) => item.signature === signature)
  if (entry === undefined) return false
  entry.promotedBy = origin === 'manual' ? 'manual' : 'auto'
  persist(file, entries, maxFlows)
  return true
}

/**
 * 自动沉淀技能的数量控制：超出上限时淘汰「最久没被再次命中」的那些。
 *
 * 为什么需要：autoPromote 默认开启后，长期使用会不断往 skills/ 里加文件。
 * 技能目录是**每轮请求**都会进入模型视野的东西（catalog 摘要），无限膨胀会
 * 挤掉真正有用的技能，也白白消耗上下文。所以按「最近一次命中时间」淘汰，
 * 保留的永远是仍在被重复使用的流程。
 *
 * 只淘汰 autoPromote 写下的文件 —— 手动晋升的技能（flows 里 promoted 但
 * 不走自动路径，或用户在面板点过）由人自己负责，不该被机器删掉。
 *
 * @param {string} flowsFile
 * @param {string} skillsDir
 * @param {number} maxSkills 0 = 不限制
 * @param {{ keepSignature?: string }} options 刚晋升的签名，永不在此次淘汰中移除
 * @returns {{ removed: string[] }}
 */
export function pruneAutoSkills(flowsFile, skillsDir, maxSkills, options = {}) {
  if (!Number.isFinite(maxSkills) || maxSkills <= 0) return { removed: [] }
  if (!existsSync(skillsDir)) return { removed: [] }

  let files
  try {
    files = readdirSync(skillsDir).filter((name) => name.toLowerCase().endsWith('.md'))
  } catch {
    return { removed: [] }
  }
  if (files.length <= maxSkills) return { removed: [] }

  const entries = readFlows(flowsFile)
  const bySkill = new Map()
  for (const entry of entries) {
    if (typeof entry.skillName === 'string' && entry.skillName !== '') bySkill.set(entry.skillName, entry)
  }

  // 排序键：最近命中时间（lastTs）→ 次数；没有流程记录的排最前（最该淘汰）
  const ranked = files
    .map((file) => {
      const name = file.replace(/\.md$/i, '')
      const flow = bySkill.get(name)
      return {
        file,
        name,
        lastTs: typeof flow?.lastTs === 'string' ? flow.lastTs : '',
        count: Number.isFinite(flow?.count) ? flow.count : 0,
        // 手动晋升 / 非本插件流程：不参与自动淘汰
        protected: flow === undefined || flow.promotedBy === 'manual',
      }
    })
    .sort((a, b) => {
      // 受保护的排最后（不容易被选中）
      if (a.protected !== b.protected) return a.protected ? 1 : -1
      if (a.lastTs !== b.lastTs) return a.lastTs < b.lastTs ? -1 : 1
      return a.count - b.count
    })

  const removed = []
  const overflow = files.length - maxSkills
  for (const item of ranked) {
    if (removed.length >= overflow) break
    if (item.protected) continue
    if (options.keepSignature !== undefined && bySkill.get(item.name)?.signature === options.keepSignature) continue
    try {
      rmSync(join(skillsDir, item.file), { force: true })
      removed.push(item.name)
    } catch {
      /* 删不掉就留着，下次再算 */
    }
  }
  return { removed }
}

/**
 * 扫描已沉淀的技能目录，读出 name/description 摘要。
 * 扁平 <name>.md 与目录式 <name>/SKILL.md 都支持（与内置 filesystem provider 一致）。
 */
export function listSkills(dir) {
  if (!existsSync(dir)) return []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const entry of entries) {
    const path = entry.isDirectory() ? join(dir, entry.name, 'SKILL.md') : join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!existsSync(path)) continue
    } else if (!entry.name.toLowerCase().endsWith('.md') || entry.name.toLowerCase() === 'skill.md') {
      continue
    }
    let raw
    try {
      raw = readFileSync(path, 'utf8')
    } catch {
      continue
    }
    const meta = quickFrontmatter(raw)
    if (typeof meta.name !== 'string' || meta.name === '') continue
    out.push({
      name: meta.name,
      description: typeof meta.description === 'string' ? meta.description : '',
      whenToUse: typeof meta.whenToUse === 'string' ? meta.whenToUse : '',
      path,
    })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** 只取前若干行做正则匹配，比完整 YAML 解析快且够用。 */
function quickFrontmatter(raw) {
  const head = raw.slice(0, 2000)
  const pick = (key) => {
    const match = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(head)
    if (match === null) return undefined
    return match[1].trim().replace(/^["']|["']$/g, '')
  }
  return { name: pick('name'), description: pick('description'), whenToUse: pick('whenToUse') }
}
