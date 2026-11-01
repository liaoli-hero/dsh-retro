// lib/experience.js — 失败经验的结构化与归因（纯函数，零依赖）
//
// 一句话：把「一次工具调用报错」压成可去重、可检索、可生成教训的结构。
//
// 为什么必须结构化而不是直接存错误文本：
//   ① 同一类错误会在几十次会话里反复出现，文本各不相同（路径、端口、时间戳）；
//      不归一化就无法统计「高频坑」，总结也就退化成一大段噪音。
//   ② 经验要进系统提示词，预算只有一两千字，只能放**归类后**的结论。
//   ③ 技能草稿需要「同类失败 + 同类修法」的配对作为素材。

import { clip, firstLine, kebab, oneLine, redact, shortHash } from './util.js'

/**
 * 失败类别表。键是内部稳定 id（写进文件，跨版本可读），
 * 值包含中文标签、判定用正则、以及该类失败的通用改法（教训的来源）。
 */
export const FAILURE_CLASSES = [
  {
    // 编辑工具自己的一类错误：必须先读数、必须唯一匹配、必须没被别人改过。
    // 这是 dsh 里最高频的失败（实测占了一半以上），却完全不是"环境问题"——
    // 它是**操作顺序问题**，所以教训必须是流程性的。
    id: 'edit-precondition',
    label: '编辑前置条件不满足',
    test: /FS_NOT_OBSERVED|FS_STALE_VERSION|FS_AMBIGUOUS_EDIT|file has not been read|file changed since it was read|matched \d+ times|replace_all to true|先读|重新读/i,
    lesson:
      'edit 有三个硬前置：① 先 read 过该文件；② 同一时刻只有你在改（改前重读）；③ old_string 唯一匹配（不够就带上下文或开 replace_all）。写入前先 read 一次是最省事的习惯。',
  },
  {
    id: 'sandbox-denied',
    label: '权限/沙箱拒绝',
    test: /sandbox|permission denied|access denied|EPERM|EACCES|拒绝访问|无权限|not authorized|unauthorized/i,
    lesson:
      '先确认操作路径是否落在当前工作区/沙箱允许范围内；越界写入会被直接拒绝，改走工作区内的相对路径，或先申请更宽的权限再重试。',
  },
  {
    id: 'not-found',
    label: '路径/对象不存在',
    test: /ENOENT|no such file|not found|does not exist|cannot find|找不到|不存在|未找到|command not found/i,
    lesson:
      '动手前先列举真实存在的路径与命令名（glob/列出目录/which），不要凭记忆拼路径；批量操作前先跑一次只读探测。',
  },
  {
    id: 'syntax-args',
    label: '语法/参数错误',
    test: /SyntaxError|unexpected token|invalid argument|invalid option|unrecognized|missing required|参数错误|语法错误|usage:/i,
    lesson:
      '命令或脚本参数写错时，先读工具自身的用法（--help / 函数签名），再一次性改对；连续两次同类报错就停下来重读接口而不是换写法硬试。',
  },
  {
    id: 'network',
    label: '网络/连接失败',
    test: /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|连接被拒绝|无法连接|network error|502|503|504/i,
    lesson:
      '连接类失败先区分「服务没起」和「地址写错」：探测端口与进程，再决定是重启服务还是改地址；不要用重试掩盖配置错误。',
  },
  {
    id: 'timeout',
    label: '超时',
    test: /timeout|timed out|ETIMEDOUT|超时|deadline exceeded/i,
    lesson:
      '长任务拆成可观测的小步，给每一步加超时并在超时后读取已有输出；一次跑几分钟的黑盒命令失败时无法定位，先缩小范围再重跑。',
  },
  {
    id: 'encoding',
    label: '编码/序列化',
    test: /UnicodeDecodeError|invalid utf-8|JSONDecodeError|Unexpected end of JSON|cannot parse|编码|乱码|mojibake/i,
    lesson:
      '读写文本统一 UTF-8 并在读取时显式声明编码；解析 JSON 前先确认文件完整（大小/尾部），别把截断当成格式错误。',
  },
  {
    id: 'dependency',
    label: '依赖/环境缺失',
    test: /MODULE_NOT_FOUND|Cannot find module|No module named|is not recognized as|不是内部或外部命令|command not found|missing dependency/i,
    lesson:
      '先确认运行环境（node/python 版本、包管理器、PATH）与本机是否真的装了该依赖；优先复用已装工具，确需新依赖时先装再跑并记录安装命令。',
  },
  {
    id: 'model-context',
    label: '模型/上下文限制',
    test: /context window|too many tokens|max_tokens|rate limit|quota|CONTEXT_WINDOW_EXCEEDED|RATE_LIMIT|上下文|额度/i,
    lesson:
      '上下文或额度耗尽时应压缩结论而不是继续堆材料：把中间产物落到文件，只把结论与关键行带回对话。',
  },
  {
    id: 'test-failed',
    label: '测试/校验失败',
    test: /AssertionError|expected .* to (be|equal)|tests? failed|failing|FAILED|断言失败|校验失败/i,
    lesson:
      '测试失败先读第一条失败断言与它的实际值，复现最小用例再改代码；不要在没复现的情况下批量改动让测试「看起来过了」。',
  },
  {
    id: 'guard-blocked',
    label: '策略/守卫拦截',
    test: /blocked by|guard|denied by|rejected tool|policy|refused|已拦截|已拒绝/i,
    lesson:
      '被守卫或策略拦下说明当前做法越过了既定边界，先改变做法（换目标、换范围、换工具），而不是重复同一调用等待不同结果。',
  },
]

const UNKNOWN_CLASS = {
  id: 'unknown',
  label: '未归类失败',
  lesson: '保留完整报错与最小复现命令；同一报错第二次出现时先归因再动手。',
}

/** 从一段错误文本判定失败类别。 */
export function classifyFailure(text) {
  const value = String(text ?? '')
  for (const entry of FAILURE_CLASSES) {
    if (entry.test.test(value)) return entry
  }
  return UNKNOWN_CLASS
}

/** 类别 id → 中文标签（展示用）。 */
export function classLabel(id) {
  const found = FAILURE_CLASSES.find((entry) => entry.id === id)
  return found ? found.label : UNKNOWN_CLASS.label
}

/** 类别 id → 教训文本。 */
export function classLesson(id) {
  const found = FAILURE_CLASSES.find((entry) => entry.id === id)
  return found ? found.lesson : UNKNOWN_CLASS.lesson
}

/**
 * 归一化签名：把「同类失败的个性部分」抹掉，只留可统计的骨架。
 * 去掉路径、端口、数字、UUID、引号内内容。
 */
export function signatureOf(tool, errorText) {
  const cls = classifyFailure(errorText)
  const skeleton = String(errorText ?? '')
    .replace(/[A-Za-z]:\\[^\s'"]+/g, '<path>')
    .replace(/\/[^\s'"]{4,}/g, '<path>')
    .replace(/\b\d{1,5}\b/g, '<n>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/['"`][^'"`]{0,80}['"`]/g, '<s>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
  return `${cls.id}|${tool ?? 'unknown'}|${shortHash(skeleton, 10)}`
}

/**
 * 生成一条失败经验记录。
 * @param {{ sessionId?: string, cwd?: string, tool?: string, errorText?: string, args?: unknown, turn?: number, step?: number, code?: string }} input
 * @param {{ maxErrorChars?: number, now?: string }} options
 */
export function makeFailureRecord(input, options = {}) {
  const errorText = redact(String(input.errorText ?? '').trim() || '(no error text)')
  const maxChars = Number.isFinite(options.maxErrorChars) ? options.maxErrorChars : 1400
  const cls = classifyFailure(errorText)
  const signature = signatureOf(input.tool, errorText)
  const argText = safeArgDigest(input.args)
  return {
    id: shortHash(`${signature}|${input.sessionId ?? ''}|${options.now ?? Date.now()}|${Math.random()}`),
    ts: options.now ?? new Date().toISOString(),
    signature,
    class: cls.id,
    classLabel: cls.label,
    tool: typeof input.tool === 'string' && input.tool !== '' ? input.tool : 'unknown',
    sessionId: typeof input.sessionId === 'string' ? input.sessionId : '',
    cwd: typeof input.cwd === 'string' ? input.cwd : '',
    turn: Number.isFinite(input.turn) ? input.turn : null,
    step: Number.isFinite(input.step) ? input.step : null,
    code: typeof input.code === 'string' ? input.code : '',
    message: oneLine(firstLine(errorText, 220), 220),
    detail: clip(errorText, maxChars),
    argsDigest: argText,
    lesson: cls.lesson,
  }
}

/** 参数摘要：只留形状，避免把长内容或密钥写进经验库。 */
function safeArgDigest(args) {
  if (args === undefined || args === null) return ''
  let raw
  try {
    raw = JSON.stringify(args)
  } catch {
    return '(unserializable)'
  }
  if (typeof raw !== 'string') return ''
  return clip(redact(raw), 240)
}

/**
 * 按签名聚合失败记录：同签名只保留最近一条作为代表，并记录命中次数。
 * @param {Array<object>} records
 * @returns {Array<{ signature: string, class: string, classLabel: string, tool: string, count: number, lastTs: string, message: string, lesson: string, detail: string, sessions: number }>}
 */
export function aggregateFailures(records) {
  const buckets = new Map()
  for (const record of records) {
    if (!record || typeof record.signature !== 'string') continue
    const existing = buckets.get(record.signature)
    if (existing === undefined) {
      buckets.set(record.signature, {
        signature: record.signature,
        class: record.class ?? 'unknown',
        classLabel: record.classLabel ?? classLabel(record.class ?? 'unknown'),
        tool: record.tool ?? 'unknown',
        count: 1,
        lastTs: record.ts ?? '',
        message: record.message ?? '',
        lesson: record.lesson ?? classLesson(record.class ?? 'unknown'),
        detail: record.detail ?? '',
        sessions: new Set(record.sessionId ? [record.sessionId] : []),
      })
      continue
    }
    existing.count += 1
    if (record.sessionId) existing.sessions.add(record.sessionId)
    if (String(record.ts ?? '') > String(existing.lastTs ?? '')) {
      existing.lastTs = record.ts ?? existing.lastTs
      existing.message = record.message ?? existing.message
      existing.detail = record.detail ?? existing.detail
    }
  }
  return [...buckets.values()]
    .map((bucket) => ({ ...bucket, sessions: bucket.sessions.size }))
    .sort((a, b) => b.count - a.count || String(b.lastTs).localeCompare(String(a.lastTs)))
}

/**
 * 工作流签名：一次 turn 内的工具序列（去掉连续重复）。
 *
 * 保留完整序列，用于给人看「这一轮具体做了什么」。
 * **不用于聚合**——真实任务动辄 8~29 步且每次顺序都不同，精确相等永远 count=1。
 * 聚合走 {@link flowSkeleton}。
 */
export function flowSignature(toolNames) {
  const names = Array.isArray(toolNames) ? toolNames.filter((name) => typeof name === 'string' && name !== '') : []
  const collapsed = []
  for (const name of names) {
    if (collapsed[collapsed.length - 1] === name) continue
    collapsed.push(name)
  }
  if (collapsed.length < 2) return null
  return collapsed.join('>')
}

/**
 * 流程骨架：把一条长序列压成「它属于哪类工作」的稳定指纹。
 *
 * 为什么不直接用完整序列做聚合键（实测教训）：
 *   真实会话里一轮有 8~29 步，同样的"读改测"任务每次顺序都不一样，
 *   精确相等导致每条流程 count 恒为 1，阈值 4 永远达不到 ⇒ 技能一个也长不出来。
 *
 * 为什么最终选了"工具集合"而不是"顺序骨架"：
 *   我试过按顺序折叠循环（read>edit>pwsh>edit>pwsh → read>edit>pwsh），
 *   结果同一类任务仍会分裂成多个签名——因为"读两次再改"和"改完再读一次"
 *   在顺序上是不同的，在**工作性质**上是同一件事。
 *   顺序是不可靠的信号；**用到哪些工具**才稳定。
 *
 * 因此骨架 = 排序后的**工具集合**（不带次数）：
 *   read×3, edit×2, pwsh×4  →  `edit>pwsh>read`（按工具名排序，天然稳定）
 *
 * 为什么不带次数：我试过加次数档位（edit1 / edit2 / edit4……），结果同一次改造
 * 在"改 2 次"和"改 4 次"时被拆成两个签名，又回到达不到阈值的老问题。
 * 次数是**规模**差异，不是**工作性质**差异；规模和性质分开看，性质才稳。
 *
 * 附着动作（present / write）不参与：它们是产物导出，不定义工作性质。
 */
export function flowSkeleton(toolNames) {
  const names = Array.isArray(toolNames) ? toolNames.filter((name) => typeof name === 'string' && name !== '') : []
  const ATTACHMENTS = new Set(['present', 'write'])

  const tools = new Set()
  for (const name of names) {
    if (ATTACHMENTS.has(name)) continue
    // 失败标记归到基础工具上：edit!err 与 edit 是同一个动作
    tools.add(name.endsWith('!err') ? name.slice(0, -4) : name)
  }

  // 只有一个工具时构不成"流程"（那只是重复调用）
  if (tools.size < 2) return null

  // 按工具名排序 → 与调用顺序、调用次数都无关，天然稳定
  return [...tools].sort((a, b) => a.localeCompare(b)).join('>')
}

/** 骨架转人类可读的形态（相等判断用骨架，展示仍给步骤名）。 */
export function skeletonSteps(skeleton) {
  const text = String(skeleton ?? '')
  if (text === '') return []
  return text.split('>').filter(Boolean)
}

/** 从工作流签名生成可读标题。 */
export function flowTitle(signature, hint) {
  const steps = String(signature ?? '').split('>')
  const hintText = typeof hint === 'string' && hint.trim() !== '' ? firstLine(hint, 60) : ''
  if (hintText !== '') return hintText
  const head = steps.slice(0, 3).join(' → ')
  return steps.length > 3 ? `${head} → …` : head
}

/** 技能名：kebab 且保证非空、带前缀。 */
export function skillNameFor(signature, hint) {
  const hintSlug = kebab(hint ?? '', 32)
  if (hintSlug !== '') return `flow-${hintSlug}`
  const sigSlug = kebab(String(signature ?? '').replace(/>/g, '-'), 32)
  return `flow-${sigSlug || shortHash(String(signature), 8)}`
}
