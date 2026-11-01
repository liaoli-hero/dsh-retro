// index.js — dsh-retro 宿主入口
//
// 三件事，彼此解耦：
//   ① **沉淀**：订阅每个会话的 turn/step 事件与工具结果，把失败压成结构化经验
//      （fails.jsonl），把一轮内的工具序列聚合成「固定流程」（flows.jsonl）。
//   ② **自我总结**：把经验与流程统计渲染成人读的 summary.md，并抽出一段受限
//      字数的摘要注入系统提示词——下一轮动手前就带着上次的教训。
//   ③ **技能化**：反复出现的固定流程渲染成 SKILL.md（先草稿，达阈值才晋升），
//      经自持 skill provider 出现在模型技能目录里。
//
// 依赖策略：本包**只** import node: 内置模块与自身 lib/*。
//   · 工具定义用裸对象注册（registry 只校验 output.render 与 schema 子集）
//   · 技能走 ctx.skills.registerProvider
//   · 命令走 ctx.commands.register
//   · 提示词走 ctx.systemPrompt.section
//   · 模型调用直接消费 ctx.llm.stream 的 text-delta 分片
// 少一个裸包依赖就少一个版本漂移导致整层不加载的失败面。
//
// @module dsh-retro

import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

import { DEFAULT_CONFIG, FAILS_MAX_LINES, normalizeConfig, paths } from './lib/store.js'
import { aggregateFailures, classLesson, makeFailureRecord, skillNameFor } from './lib/experience.js'
import { parseFrontmatter, renderSkill, worthPromoting } from './lib/skillgen.js'
import { buildReviewPrompt, classHistogram, pickLessons, recentLessons, renderPromptDigest, renderSummaryMarkdown } from './lib/summary.js'
import { closeWindow, listSkills, markPromoted, markPromotedBy, mergeFlow, openWindow, pruneAutoSkills, readFlows, recordStep, setHint } from './lib/flows.js'
import { bindInvalidate, notifySkillsChanged } from './lib/invalidate.js'
import {
  BOOLEAN_KEYS,
  NUMBER_RANGES,
  RUNTIME_KEYS,
  clearSettings,
  mergeSettings,
  readSettings,
  sanitizeSettings,
  settingsPath,
  writeSettings,
} from './lib/settings.js'
import { appendJsonl, atomicWrite, clip, ensureDir, firstLine, nowIso, oneLine, readJson, readJsonl, redact, trimJsonl } from './lib/util.js'

/** Cordis 插件名。 */
export const name = 'dsh-retro'

/** 硬依赖：没有 tools 服务就无法注册复盘工具；其余服务用可选注入。 */
export const inject = ['tools']

/** 本次进程内的运行态（不落盘；重启后由文件重新计算）。 */
const runtime = {
  config: { ...DEFAULT_CONFIG },
  /** 部署层配置（来自 cordis.patch.yml 的 config），只读；改它需要重启 */
  baseConfig: { ...DEFAULT_CONFIG },
  /** 运行期设置（settings.json），覆盖 baseConfig；改它立即生效 */
  settings: {},
  /**
   * 可选服务：`agentDefaultModel`（当前对话的 provider/model）与 `llm`（发起请求）。
   * 只在「模型复盘」用得到，所以走 ctx.inject 动态注入而不是静态 inject ——
   * 缺它们时插件其余功能照常工作，只是模型复盘不可用并给出明确原因。
   */
  agentDefaultModel: null,
  llm: null,
  paths: null,
  /** 会话 → { turn, step } */
  cursor: new Map(),
  /** 已计算的注入摘要 */
  digest: '',
  /** 变更序号，仅用于日志 */
  revision: 0,
  refreshTimer: null,
  lastSummaryAt: '',
}

// ==================== 配置与路径 ====================

function applyConfig(ctx, config) {
  // 两层：baseConfig 来自部署配置（改它要重启），settings 来自运行期文件（立即生效）。
  // runtime.config 永远是**合并后**的生效值，功能代码只读它，不关心来源。
  runtime.baseConfig = normalizeConfig(config)
  runtime.paths = paths(runtime.baseConfig)
  ensureDir(runtime.paths.root)
  ensureDir(runtime.paths.skillsDir)
  ensureDir(runtime.paths.draftsDir)
  runtime.settings = readSettings(runtime.paths.root)
  runtime.config = mergeSettings(runtime.baseConfig, runtime.settings)
  ctx.logger?.info?.(
    `[dsh-retro] root=${runtime.paths.root} capture=${runtime.config.autoCapture} draft=${runtime.config.autoDraft} promote=${runtime.config.autoPromote}` +
      (Object.keys(runtime.settings).length > 0 ? `（运行期覆盖 ${Object.keys(runtime.settings).join(',')}）` : ''),
  )
}

/**
 * 改运行期设置并立即生效。
 * @param {object} patch 要改的键
 * @returns {{ ok: boolean, rejected: Array, config: object }}
 */
function updateSettings(patch) {
  const result = writeSettings(runtime.paths.root, runtime.baseConfig, patch)
  runtime.settings = result.settings
  runtime.config = result.config
  refreshDigest()
  return { ok: result.rejected.length === 0, rejected: result.rejected, config: result.config }
}

function loadState() {
  const state = readJson(runtime.paths.state, {})
  runtime.lastSummaryAt = typeof state.lastSummaryAt === 'string' ? state.lastSummaryAt : ''
  return state
}

function saveState(patch) {
  const merged = { ...loadState(), ...patch }
  atomicWrite(runtime.paths.state, `${JSON.stringify(merged, null, 2)}\n`)
  return merged
}

// ==================== 原始数据与聚合 ====================

function readFailures() {
  return readJsonl(runtime.paths.fails, FAILS_MAX_LINES)
}

function writeFailures(records) {
  atomicWrite(
    runtime.paths.fails,
    records.map((record) => JSON.stringify(record)).join('\n') + (records.length > 0 ? '\n' : ''),
  )
}

function writeFlows(records) {
  atomicWrite(
    runtime.paths.flows,
    records.map((record) => JSON.stringify(record)).join('\n') + (records.length > 0 ? '\n' : ''),
  )
}

function aggregateNow() {
  const failures = readFailures()
  const flows = readFlows(runtime.paths.flows)
  const skills = listSkills(runtime.paths.skillsDir)
  return { failures, flows, skills, aggregated: aggregateFailures(failures) }
}

/** 重新计算注入摘要（同步：systemPrompt 的 text provider 必须是同步的）。 */
function refreshDigest() {
  if (!runtime.paths) return ''
  const config = runtime.config
  if (!config.enabled || config.promptBudget <= 0) {
    runtime.digest = ''
    return ''
  }
  try {
    const { flows, skills, aggregated } = aggregateNow()
    const lessons = pickLessons(aggregated, { repeatThreshold: config.repeatThreshold, topN: config.summaryTopN })
    const promoted = new Set(skills.map((skill) => skill.name))
    const flowList = flows
      .filter((flow) => (flow.count ?? 0) >= config.flowThreshold)
      .sort((a, b) => (b.count ?? 0) - (a.count ?? 0))
      .slice(0, 6)
      .map((flow) => ({
        title: flow.title ?? flow.signature,
        count: flow.count ?? 0,
        skillName: promoted.has(flow.skillName) ? flow.skillName : '',
      }))
    runtime.digest = renderPromptDigest({
      lessons,
      flows: flowList,
      skills,
      generatedAt: (runtime.lastSummaryAt || new Date().toISOString()).slice(0, 10),
      budget: config.promptBudget,
    })
  } catch (error) {
    runtime.digest = ''
    console.warn(`[dsh-retro] 生成注入摘要失败：${String(error?.message ?? error)}`)
  }
  return runtime.digest
}

/** 合并刷新：一轮里可能写很多条，合并成一次重算。 */
function scheduleRefresh(ctx) {
  runtime.revision += 1
  if (runtime.refreshTimer !== null) return
  runtime.refreshTimer = setTimeout(() => {
    runtime.refreshTimer = null
    refreshDigest()
    ctx?.logger?.debug?.(`[dsh-retro] digest refreshed (rev ${runtime.revision}, ${runtime.digest.length} chars)`)
  }, 400)
  runtime.refreshTimer.unref?.()
}

// ==================== ① 失败经验的沉淀 ====================

function recordFailure(ctx, input) {
  const record = makeFailureRecord(input, {
    maxErrorChars: runtime.config.maxErrorChars,
    now: nowIso(),
  })
  appendJsonl(runtime.paths.fails, record)
  trimJsonl(runtime.paths.fails, FAILS_MAX_LINES)
  scheduleRefresh(ctx)
  return record
}

function onToolResult(ctx, exec, result) {
  if (!runtime.config.enabled) return
  const sessionId = sessionIdOf(exec)
  const toolName = typeof exec?.name === 'string' && exec.name !== '' ? exec.name : 'unknown'
  const failed = result?.isError === true

  // ① 流程窗口：成功与失败都进序列。失败标记 !err，之后修好的过程本身就是流程的一部分。
  if (sessionId !== '') recordStep(sessionId, failed ? `${toolName}!err` : toolName)

  // ② 失败经验：只有开启自动沉淀且确实是失败时才写盘
  if (!failed || !runtime.config.autoCapture) return

  const cursor = runtime.cursor.get(sessionId) ?? { turn: null, step: null }
  const info = result.error?.info ?? {}
  const message =
    typeof result.error?.message === 'string' && result.error.message !== ''
      ? result.error.message
      : contentText(result.content)
  try {
    const record = recordFailure(ctx, {
      sessionId,
      cwd: sessionCwd(exec),
      tool: toolName,
      errorText: message,
      args: exec?.arguments,
      turn: cursor.turn,
      step: cursor.step,
      code: typeof info.code === 'string' ? info.code : '',
    })
    ctx?.logger?.debug?.(`[dsh-retro] captured ${record.class}/${record.tool} ${record.id}`)
  } catch (error) {
    ctx?.logger?.warn?.(`[dsh-retro] 记录失败经验出错：${String(error?.message ?? error)}`)
  }
}

function contentText(content) {
  if (!Array.isArray(content)) return '(tool failed without message)'
  const parts = []
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim() || '(tool failed without message)'
}

function sessionIdOf(exec) {
  const id = exec?.agent?.session?.id
  return typeof id === 'string' ? id : ''
}

function sessionCwd(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  return typeof cwd === 'string' ? cwd : ''
}

// ==================== ② 会话事件：轮次边界与流程窗口 ====================

function onSessionEvent(ctx, session, event) {
  if (!runtime.config.enabled) return
  const sessionId = typeof session?.id === 'string' ? session.id : ''
  if (sessionId === '' || !event || typeof event.type !== 'string') return

  switch (event.type) {
    case 'turn/start': {
      const turn = Number(event.data?.turn)
      runtime.cursor.set(sessionId, { turn: Number.isFinite(turn) ? turn : null, step: null })
      openWindow(sessionId, Number.isFinite(turn) ? turn : 0, '')
      return
    }
    case 'step/start': {
      const cursor = runtime.cursor.get(sessionId) ?? { turn: null, step: null }
      const step = Number(event.data?.step)
      runtime.cursor.set(sessionId, { turn: cursor.turn, step: Number.isFinite(step) ? step : null })
      return
    }
    case 'user/message': {
      const source = event.data?.source
      if (source && typeof source === 'object' && source.kind !== 'user') return
      const text = messageText(event.data)
      if (text !== '') setHint(sessionId, text)
      return
    }
    case 'turn/end': {
      runtime.cursor.delete(sessionId)
      finishTurn(ctx, sessionId)
      return
    }
    default:
      return
  }
}

function finishTurn(ctx, sessionId) {
  const observation = closeWindow(sessionId)
  // 轮末是天然的同步边界：下一轮的第一步马上就要读摘要，这里必须已经算好，
  // 不能只依赖节流刷新（否则"刚总结完就忘"）。
  if (observation !== null) {
    try {
      const { entry, count, created } = mergeFlow(runtime.paths.flows, observation, {
        maxFlows: runtime.config.maxFlows,
        sessionId,
        now: nowIso(),
      })
      ctx?.logger?.debug?.(`[dsh-retro] flow ${created ? 'new' : 'hit'} ${entry.signature} x${count}`)
      // 幂等保护：同一条流程只在**首次**达阈值时落草稿/晋升。
      // 否则热门流程每轮都会重写技能文件并触发 registry 失效——技能目录每次变化
      // 都会让请求前缀缓存失效，代价远大于收益。
      //
      // 两个开关是**正交**的，任一打开都要有产出：
      //   autoDraft   → 生成 drafts/ 草稿（人工看过再晋升）
      //   autoPromote → 直接写进 skills/（草稿顺带留一份，无害）
      // 早期版本把晋升写在 autoDraft 分支里面，导致「只开 autoPromote」什么都不发生——
      // 配置看起来生效了、日志也没报错，但技能永远不出现，是最难查的一类。
      const wantsDraft = runtime.config.autoDraft
      const wantsPromote = runtime.config.autoPromote
      if (!entry.promoted && count >= runtime.config.flowThreshold && (wantsDraft || wantsPromote)) {
        const draft = writeDraft(entry, ctx)
        if (wantsPromote) promoteSkill(entry, draft, ctx)
      }
    } catch (error) {
      ctx?.logger?.warn?.(`[dsh-retro] 聚合流程出错：${String(error?.message ?? error)}`)
    }
  }
  // 失败记录可能在本轮任何时刻写入，统一在这里重算一次
  refreshDigest()
}

function messageText(message) {
  const content = message?.content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return firstLine(parts.join(' '), 120)
}

// ==================== ③ 技能草稿与晋升 ====================

/**
 * 技能正文的步骤：用**骨架**而不是完整序列。
 *
 * 实测教训：直接拿完整序列（40 步，反复 edit/pwsh）生成技能，产出是一份
 * 流水账 —— 模型读了得不到"该怎么做"，只会看到"上次敲了 40 次工具"。
 * 骨架是工具集合，转成"按顺序覆盖这几类动作"的指引才有复用价值。
 *
 * 完整序列不丢，放到正文末尾作为「上次实际执行」的样本。
 */
function stepsOf(entry) {
  const skeleton = typeof entry.skeleton === 'string' && entry.skeleton !== '' ? entry.skeleton : null
  const source = skeleton ?? (Array.isArray(entry.steps) && entry.steps.length > 0 ? entry.steps : String(entry.signature ?? '').split('>'))
  const names = skeleton !== null ? skeleton.split('>') : source

  return names.filter(Boolean).map((name) => {
    const base = String(name).replace(/!err$/, '')
    return {
      name: base,
      note: toolIntentNote(base),
    }
  })
}

/** 工具 → 该步骤的意图说明（让技能读起来是"做事"而不是"调函数"）。 */
function toolIntentNote(tool) {
  const NOTES = {
    read: '先看清现有内容，不要凭印象改',
    edit: '小步改动，每次改完确认落点正确',
    write: '新建文件前确认路径与命名，避免覆盖已有内容',
    pwsh: '跑一次可观测的验证（命令回显 / 测试结果），别只看"没报错"',
    bash: '跑一次可观测的验证（命令回显 / 测试结果）',
    grep: '先定位再动手，避免全库盲改',
    glob: '先确认文件真实存在与命名',
    task: '复杂步骤交给子任务，自己保留主线索',
    present: '把产物正式交付给用户',
    web_fetch: '抓取前确认目标地址与内容形态',
    web_search: '先搜再下结论，避免凭记忆作答',
    read_image: '看图前确认文件确实是图片且可读',
    todo_write: '把多步工作显式列出来，避免漏项',
    ask_user_question: '关键分叉先问，别替用户做决定',
  }
  return NOTES[tool] ?? ''
}

/** 与该流程相关的高频坑：取骨架里出现过的工具所对应的经验。 */
function pitfallsFor(entry, aggregated) {
  const key = typeof entry.skeleton === 'string' && entry.skeleton !== '' ? entry.skeleton : (entry.signature ?? '')
  const tools = new Set(String(key).split('>').map((step) => step.replace(/!err$/, '')))
  const seen = new Set()
  const out = []
  for (const item of aggregated) {
    if (!tools.has(item.tool) || item.count < 2) continue
    // 同一类失败可能有多条签名，教训文本相同 —— 去重，别在同一段里重复三遍
    const dedupeKey = `${item.class}:${item.tool}`
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)
    out.push({ classLabel: item.classLabel, tool: item.tool, count: item.count, lesson: item.lesson })
    if (out.length >= 4) break
  }
  return out
}

/** 流程标题：优先用用户当时的意图，但过滤掉没有信息量的短句。 */
function flowTitleSafe(entry) {
  const raw = oneLine(entry.title ?? '', 60)
  // "继续" "好" "可以" 这类回复不描述任务，拿来当技能标题是噪音
  const NOISE = /^(继续|好的?|可以|行|嗯+|ok|okay|yes|go|继续吧|接着|下一步|你说|你觉得|怎么办|啥意思)$/i
  if (raw !== '' && !NOISE.test(raw.trim()) && raw.trim().length >= 4) return raw
  const skeleton = typeof entry.skeleton === 'string' ? entry.skeleton : (entry.signature ?? '')
  const steps = skeleton.split('>').filter(Boolean)
  return steps.length > 0 ? `${steps.join(' → ')} 流程` : '固定流程'
}

function renderForFlow(entry) {
  const { aggregated } = aggregateNow()
  const steps = stepsOf(entry)
  const skeleton = typeof entry.skeleton === 'string' && entry.skeleton !== '' ? entry.skeleton : (entry.signature ?? '')
  const skillName = entry.skillName || skillNameFor(skeleton, entry.title)
  const title = flowTitleSafe(entry)
  const toolList = steps.map((step) => step.name).join(' → ')
  const rawSample = Array.isArray(entry.steps) ? entry.steps.slice(0, 40).join(' → ') : ''

  const text = renderSkill({
    name: skillName,
    title,
    description: `覆盖 ${steps.length} 类动作的流程：${toolList}。由 dsh-retro 从 ${entry.count ?? 1} 次同类执行中沉淀（骨架 ${skeleton}）。`,
    whenToUse: `当任务属于「${title}」这一类时，按下面的动作顺序推进，避免遗漏环节或反复试错。`,
    signature: skeleton,
    steps,
    samples: entry.count ?? 1,
    pitfalls: pitfallsFor(entry, aggregated),
    notes: [
      '步骤是**动作类型**而不是历史里的每一次调用；同一步可以重复多次，按需要循环。',
      '工具名是历史中的实际调用；当前环境缺同名工具时用等价能力替代，保留语义顺序。',
      ...(rawSample !== '' ? [`上次实际执行序列（仅供对照，不必照抄）：${clip(rawSample, 400)}`] : []),
    ],
  })
  return { skillName, text, steps }
}

function writeDraft(entry, ctx) {
  const { skillName, text } = renderForFlow(entry)
  const file = join(runtime.paths.draftsDir, `${skillName}.md`)
  // 内容未变不重写：草稿也会被后续晋升读取，反复覆写只增加磁盘抖动
  if (!existsSync(file) || readFileSync(file, 'utf8') !== text) {
    atomicWrite(file, text)
    ctx?.logger?.info?.(`[dsh-retro] draft ${skillName} → ${file}`)
  }
  return file
}

function promoteSkill(entry, draftPath, ctx, origin = 'auto') {
  const skillName = entry.skillName || skillNameFor(entry.signature, entry.title)
  const source = draftPath ?? join(runtime.paths.draftsDir, `${skillName}.md`)
  const text = existsSync(source) ? readFileSync(source, 'utf8') : renderForFlow(entry).text
  const target = join(runtime.paths.skillsDir, `${skillName}.md`)

  // 内容未变就不重写、不失效：技能目录的任何变化都会让下一轮请求的前缀缓存失效，
  // 重复晋升同一流程不该有这个代价。
  const unchanged = existsSync(target) && readFileSync(target, 'utf8') === text
  if (!unchanged) {
    atomicWrite(target, text)
    if (runtime.config.mirrorToUserSkills) {
      try {
        const userSkills = join(process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh'), 'skills')
        ensureDir(userSkills)
        atomicWrite(join(userSkills, `${skillName}.md`), text)
      } catch (error) {
        ctx?.logger?.warn?.(`[dsh-retro] 镜像到用户技能目录失败：${String(error?.message ?? error)}`)
      }
    }
    // 关键：registry 没有 TTL，写完必须主动失效，否则模型侧目录停在旧快照
    notifySkillsChanged()
    ctx?.logger?.info?.(`[dsh-retro] promoted ${skillName} → ${target}`)
  }
  if (entry.promoted !== true) {
    markPromoted(runtime.paths.flows, entry.signature, skillName, runtime.config.maxFlows)
    // 记录这次晋升是自动还是人工：自动沉淀的技能才参与数量淘汰，
    // 人手动点过的技能由人自己管理，不该被机器删掉。
    markPromotedBy(runtime.paths.flows, entry.signature, origin, runtime.config.maxFlows)
  }
  // 全自动模式下技能会持续增加：超过上限就按「最久未命中」淘汰，
  // 否则技能目录无限膨胀，反而把有用的技能挤出模型视野。
  if (origin === 'auto' && runtime.config.maxAutoSkills > 0) {
    const pruned = pruneAutoSkills(runtime.paths.flows, runtime.paths.skillsDir, runtime.config.maxAutoSkills, {
      keepSignature: entry.signature,
    })
    if (pruned.removed.length > 0) {
      notifySkillsChanged()
      ctx?.logger?.info?.(`[dsh-retro] pruned ${pruned.removed.length} stale auto skill(s): ${pruned.removed.join(', ')}`)
    }
  }
  scheduleRefresh(ctx)
  return { skillName, target, unchanged }
}

// ==================== ④ 自我总结 ====================

function buildSummaryInput() {
  const { failures, flows, skills, aggregated } = aggregateNow()
  const config = runtime.config
  const lessons = pickLessons(aggregated, { repeatThreshold: config.repeatThreshold, topN: config.summaryTopN })
  const promoted = new Set(skills.map((skill) => skill.name))
  const state = loadState()
  return {
    generatedAt: nowIso(),
    totals: {
      turns: Number(state.turns ?? 0),
      tools: Number(state.tools ?? 0),
      failures: failures.length,
      distinct: aggregated.length,
      flows: flows.length,
      skills: skills.length,
    },
    histogram: classHistogram(aggregated),
    lessons,
    recent: recentLessons(aggregated, { topN: 5 }),
    flows: flows.map((flow) => ({ ...flow, promoted: promoted.has(flow.skillName) })),
    skills,
  }
}

/** 规则式总结：始终可用，不依赖模型。 */
function summarizeRules() {
  const input = buildSummaryInput()
  const text = renderSummaryMarkdown(input)
  writeSummary(text, input.generatedAt)
  return { text, input }
}

function writeSummary(text, generatedAt) {
  atomicWrite(runtime.paths.summary, text)
  runtime.lastSummaryAt = generatedAt
  saveState({ lastSummaryAt: generatedAt })
  refreshDigest()
}

/** 模型式复盘：用当前对话的模型把统计讲成人话；失败则回落规则式。 */
async function summarizeWithModel(ctx, input) {
  const selection = currentSelection()
  if (selection === null) {
    // 明确区分「服务没挂上」和「挂上了但没选模型」——这两件事的修法完全不同
    return {
      ok: false,
      reason: runtime.agentDefaultModel === null
        ? 'agentDefaultModel 服务未挂载（该 profile 未启用模型选择服务）'
        : '当前会话未选择 provider/model（在输入框上方选一个模型后重试）',
    }
  }
  const llm = runtime.llm
  if (!llm || typeof llm.stream !== 'function') {
    return { ok: false, reason: 'llm 服务未挂载（无法发起模型请求）' }
  }

  const prompt = buildReviewPrompt({ lessons: input.lessons, flows: input.flows.slice(0, 8) })
  const parts = []
  let failure = ''
  try {
    for await (const chunk of llm.stream({
      provider: selection.provider,
      model: selection.model,
      sessionId: 'dsh-retro-summary',
      system: '你是严谨的运行复盘助手，只依据给定事实作答。',
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }], source: { kind: 'dsh-retro' } }],
      temperature: 1,
      signal: AbortSignal.timeout(runtime.config.llmTimeoutMs),
    })) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') parts.push(chunk.text)
      if (chunk?.type === 'finish') {
        const reason = chunk.reason
        if (reason && (reason.kind === 'error' || reason.kind === 'aborted')) {
          failure = String(reason.failure?.message ?? reason.failure?.code ?? reason.kind)
        }
      }
    }
  } catch (error) {
    failure = String(error?.message ?? error)
  }
  const text = parts.join('').trim()
  if (text === '') return { ok: false, reason: failure || '模型未返回文本' }
  return { ok: true, text }
}

/**
 * 当前对话的模型。读的是**注入进来的**服务引用，不是 ctx 上的属性 ——
 * 宿主只给声明过的服务挂属性，没走 ctx.inject 就永远取不到。
 */
function currentSelection() {
  const service = runtime.agentDefaultModel
  if (service === null) return null
  try {
    const sel = service.currentSelection?.()
    if (sel && typeof sel.provider === 'string' && sel.provider !== '' && typeof sel.model === 'string' && sel.model !== '') {
      return { provider: sel.provider, model: sel.model }
    }
  } catch {
    /* 服务存在但读取失败：按"未选择"处理 */
  }
  return null
}

// ==================== ⑤ 对外工具 ====================

const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
}

function registerTools(ctx) {
  const disposers = []

  disposers.push(
    ctx.tools.register({
      name: 'retro_capture',
      description:
        '手动沉淀一条经验（失败教训或可复用套路）。工具自动捕获的失败往往只有报错，没有结论；用它把「踩了什么坑 + 正确的做法」写成可检索的长期记忆。',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: '一句话结论（必填）' },
          lesson: { type: 'string', description: '下次应该怎么做，动词开头的可执行动作' },
          tool: { type: 'string', description: '相关工具名，缺省 manual' },
          kind: { type: 'string', enum: ['failure', 'success'], description: 'failure=教训，success=可复用套路' },
        },
        required: ['summary'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: { id: { type: 'string' }, class: { type: 'string' }, stored: { type: 'string' } },
          required: ['id', 'class', 'stored'],
          additionalProperties: false,
        },
        render: (_args, value) => [{ type: 'text', text: `已记录 ${value.id}（${value.class}）→ ${value.stored}` }],
      },
      async execute(args) {
        const summary = redact(String(args.summary ?? '')).trim()
        if (summary === '') throw new Error('summary 不能为空')
        const lesson = redact(String(args.lesson ?? '')).trim()
        const record = makeFailureRecord(
          {
            tool: typeof args.tool === 'string' && args.tool !== '' ? args.tool : 'manual',
            errorText: lesson === '' ? summary : `${summary}\n→ ${lesson}`,
            sessionId: '',
            turn: null,
            step: null,
          },
          { maxErrorChars: runtime.config.maxErrorChars, now: nowIso() },
        )
        record.manual = true
        record.kind = args.kind === 'success' ? 'success' : 'failure'
        if (lesson !== '') record.lesson = lesson
        else record.lesson = classLesson(record.class)
        appendJsonl(runtime.paths.fails, record)
        trimJsonl(runtime.paths.fails, FAILS_MAX_LINES)
        scheduleRefresh(ctx)
        return { id: record.id, class: record.classLabel, stored: runtime.paths.fails }
      },
    }),
  )

  disposers.push(
    ctx.tools.register({
      name: 'retro_summary',
      description:
        '生成或读取运行复盘：失败分布、该记住的坑、已识别的固定流程、已沉淀技能。mode=refresh 重新生成并落盘；useModel=true 时额外用当前对话模型写一段人话复盘。',
      parameters: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['read', 'refresh'], description: 'read=读最近一次，refresh=重新生成' },
          useModel: { type: 'boolean', description: '是否额外调用当前模型写复盘段落' },
        },
        additionalProperties: false,
      },
      output: TEXT_OUTPUT,
      async execute(args) {
        if (args.mode === 'refresh' || args.useModel === true) {
          const { input } = summarizeRules()
          if (args.useModel === true) {
            const review = await summarizeWithModel(ctx, input)
            if (review.ok) {
              const merged = renderSummaryMarkdown({ ...input, llmText: review.text })
              writeSummary(merged, input.generatedAt)
              return clip(merged, 6000)
            }
            return clip(`（模型复盘不可用：${review.reason}）\n\n${readFileSafe(runtime.paths.summary)}`, 6000)
          }
          return clip(readFileSafe(runtime.paths.summary), 6000)
        }
        if (!existsSync(runtime.paths.summary)) {
          const { text } = summarizeRules()
          return clip(text, 6000)
        }
        return clip(readFileSafe(runtime.paths.summary), 6000) || '（还没有复盘数据）'
      },
    }),
  )

  disposers.push(
    ctx.tools.register({
      name: 'retro_skills',
      description:
        '列出已沉淀技能与固定流程；action=promote 时把指定流程晋升成正式技能（之后会出现在技能目录里）。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'promote'], description: 'list=查看，promote=晋升' },
          signature: { type: 'string', description: 'promote 时的流程签名（从 list 结果里复制）' },
        },
        additionalProperties: false,
      },
      output: TEXT_OUTPUT,
      async execute(args) {
        const { flows, skills } = aggregateNow()
        if (args.action === 'promote') {
          const signature = String(args.signature ?? '').trim()
          if (signature === '') throw new Error('promote 需要 signature；先 action=list 查看可选流程')
          const entry = findFlow(flows, signature)
          if (entry === undefined) throw new Error(`找不到流程签名 ${signature}`)
          const verdict = worthPromoting({
            samples: entry.count ?? 0,
            steps: stepsOf(entry),
            threshold: runtime.config.flowThreshold,
          })
          if (!verdict.ok) ctx?.logger?.info?.(`[dsh-retro] 人工晋升 ${signature}：${verdict.reason}`)
          const draft = writeDraft(entry, ctx)
          // 工具是被明确要求晋升的 → manual，不参与自动淘汰
          const { skillName, target } = promoteSkill(entry, draft, ctx, 'manual')
          return `已晋升 ${skillName} → ${target}\n（样本 ${entry.count ?? 0} 次，签名 ${signature}）`
        }
        const lines = ['## 已沉淀技能']
        if (skills.length === 0) lines.push('（无）')
        for (const skill of skills) lines.push(`- ${skill.name} — ${oneLine(skill.description, 120)}`)
        lines.push('', '## 固定流程')
        if (flows.length === 0) lines.push('（无）')
        for (const flow of flows) {
          lines.push(`- [${flow.promoted ? '已沉淀' : '草稿'}] ${oneLine(flow.title ?? flow.signature, 60)} ×${flow.count ?? 0} — ${flow.signature}`)
        }
        return clip(lines.join('\n'), 6000)
      },
    }),
  )

  disposers.push(
    ctx.tools.register({
      name: 'retro_forget',
      description:
        '删除一条记忆（失败经验与流程记录按签名同时删除）。用于清掉已经过时的经验，避免它继续污染提示词。',
      parameters: {
        type: 'object',
        properties: {
          signature: { type: 'string', description: '失败签名或流程签名' },
        },
        required: ['signature'],
        additionalProperties: false,
      },
      output: TEXT_OUTPUT,
      async execute(args) {
        const signature = String(args.signature ?? '').trim()
        if (signature === '') throw new Error('signature 不能为空')
        const failures = readFailures()
        const keptFailures = failures.filter((record) => record.signature !== signature)
        writeFailures(keptFailures)
        const flows = readFlows(runtime.paths.flows)
        const keptFlows = flows.filter((flow) => flow.signature !== signature)
        writeFlows(keptFlows)
        // 忘记一条流程时，它沉淀出的技能也一并下线（否则提示词不再提它，技能目录还在）
        let removedSkill = ''
        for (const flow of flows) {
          if (flow.signature !== signature || typeof flow.skillName !== 'string') continue
          const file = join(runtime.paths.skillsDir, `${flow.skillName}.md`)
          if (!existsSync(file)) continue
          try {
            unlinkSync(file)
            removedSkill = flow.skillName
          } catch {
            /* 删不掉就留着，不影响主流程 */
          }
        }
        if (removedSkill !== '') notifySkillsChanged()
        refreshDigest()
        return `已删除签名 ${signature}：失败记录 ${failures.length - keptFailures.length} 条，流程 ${flows.length - keptFlows.length} 条${removedSkill ? `，技能 ${removedSkill}` : ''}`
      },
    }),
  )

  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* 卸载期的 disposer 失败不阻塞其它清理 */
      }
    }
  }
}

function readFileSafe(file) {
  try {
    return existsSync(file) ? readFileSync(file, 'utf8') : ''
  } catch {
    return ''
  }
}

// ==================== ⑥ 技能 provider ====================

function registerSkillProvider(ctx) {
  return ctx.skills.registerProvider((control) => {
    // 记下本次注册作用域的失效能力：写盘路径（晋升/删除/镜像）统一经它刷新目录
    bindInvalidate(control?.invalidate)
    return {
      name: 'dsh-retro',
      async list() {
        const candidates = listSkills(runtime.paths.skillsDir).map((skill) => ({
          name: skill.name,
          description: skill.description || `dsh-retro 沉淀的技能 ${skill.name}`,
          ...(skill.whenToUse ? { whenToUse: skill.whenToUse } : {}),
          invocation: { modelInvocable: true, userInvocable: true },
          source: 'dsh-retro',
          provider: 'dsh-retro',
          rank: runtime.config.skillRank,
          path: skill.path,
          locator: skill.path,
        }))
        return { candidates, complete: true }
      },
      async get(candidate) {
        const path = typeof candidate?.locator === 'string' ? candidate.locator : candidate?.path
        if (typeof path !== 'string' || !existsSync(path)) throw new Error(`skill file missing: ${String(path)}`)
        const { data, body } = parseFrontmatter(readFileSync(path, 'utf8'))
        return {
          name: typeof data.name === 'string' && data.name !== '' ? data.name : String(candidate?.name ?? ''),
          description:
            typeof data.description === 'string' && data.description !== '' ? data.description : 'dsh-retro 沉淀的技能',
          ...(typeof data.whenToUse === 'string' ? { whenToUse: data.whenToUse } : {}),
          invocation: { modelInvocable: true, userInvocable: true },
          source: 'dsh-retro',
          provider: 'dsh-retro',
          path,
          content: body,
        }
      },
    }
  })
}

// ==================== ⑦ 系统提示词注入 ====================

function registerPromptSection(ctx) {
  return ctx.systemPrompt.section({
    name: 'retro:history',
    order: 60,
    // 关闭宿主插值：历史文本里可能出现 {{...}}，插值失败会让整轮装配抛错
    interpolate: false,
    text: () => runtime.digest,
  })
}

// ==================== ⑦.5 HTTP API（Web 面板的数据源） ====================
//
// 面板是浏览器半侧，拿不到宿主内存；它经这些路由读复盘数据、做晋升/遗忘。
// 路由全部挂在 /api/retro 下，与其它插件（/api/soul 等）同一套命名约定。

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(text)
}

/** 读请求体（上限 1MB：面板只发小 JSON，超限直接拒绝而不是无限缓冲）。 */
function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 1_000_000) {
        resolve({ ok: false, status: 413, error: '请求体过大' })
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) return resolve({ ok: true, body: {} })
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return resolve({ ok: false, status: 400, error: '请求体必须是 JSON 对象' })
        }
        resolve({ ok: true, body: parsed })
      } catch {
        resolve({ ok: false, status: 400, error: '请求体不是合法 JSON' })
      }
    })
    req.on('error', () => resolve({ ok: false, status: 400, error: '读取请求体失败' }))
  })
}

/** 面板用的完整快照：统计、直方图、坑、流程、技能、配置。 */
function panelSnapshot() {
  // 路由可能在 apply() 之外的时机被调用（组件早于插件装配、或独立导入做自检）。
  // 与其抛错给用户看一个 500，不如返回一份空快照 + 明确原因：面板因此能
  // 显示「尚未初始化」而不是白屏。
  if (runtime.paths === null) {
    return {
      ready: false,
      reason: '插件尚未初始化',
      root: '',
      config: {},
      totals: { turns: 0, failures: 0, distinct: 0, flows: 0, skills: 0, digestChars: 0 },
      histogram: [],
      lessons: [],
      recent: [],
      flows: [],
      skills: [],
      digest: '',
      lastSummaryAt: '',
    }
  }
  const { failures, flows, skills, aggregated } = aggregateNow()
  const config = runtime.config
  const promoted = new Set(skills.map((skill) => skill.name))
  const state = loadState()
  return {
    ready: true,
    root: runtime.paths.root,
    settingsPath: settingsPath(runtime.paths.root),
    config: {
      autoCapture: config.autoCapture,
      autoDraft: config.autoDraft,
      autoPromote: config.autoPromote,
      flowThreshold: config.flowThreshold,
      repeatThreshold: config.repeatThreshold,
      promptBudget: config.promptBudget,
      mirrorToUserSkills: config.mirrorToUserSkills,
      summaryTopN: config.summaryTopN,
      maxErrorChars: config.maxErrorChars,
      maxAutoSkills: config.maxAutoSkills,
    },
    // 哪些键当前被运行期设置覆盖（面板据此标「已改」），以及可改键的元信息
    overridden: Object.keys(runtime.settings),
    editable: RUNTIME_KEYS,
    booleanKeys: BOOLEAN_KEYS,
    numberRanges: NUMBER_RANGES,
    totals: {
      turns: Number(state.turns ?? 0),
      failures: failures.length,
      distinct: aggregated.length,
      flows: flows.length,
      skills: skills.length,
      digestChars: runtime.digest.length,
    },
    histogram: classHistogram(aggregated),
    lessons: pickLessons(aggregated, { repeatThreshold: config.repeatThreshold, topN: config.summaryTopN }),
    recent: recentLessons(aggregated, { topN: 8 }),
    flows: flows
      .slice()
      .sort((a, b) => (b.count ?? 0) - (a.count ?? 0))
      .map((flow) => ({
        // signature = 完整序列（人读），skeleton = 聚合键（跨轮稳定）
        signature: flow.signature,
        skeleton: typeof flow.skeleton === 'string' ? flow.skeleton : (flow.signature ?? ''),
        title: flow.title ?? flow.signature,
        count: flow.count ?? 0,
        skillName: flow.skillName ?? '',
        promoted: promoted.has(flow.skillName) || flow.promoted === true,
        promotedBy: flow.promotedBy ?? '',
        lastTs: flow.lastTs ?? '',
        steps: Array.isArray(flow.steps) ? flow.steps.slice(0, 20) : [],
      })),
    skills: skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      whenToUse: skill.whenToUse,
      path: skill.path,
    })),
    digest: runtime.digest,
    lastSummaryAt: runtime.lastSummaryAt,
  }
}

function registerRoutes(wsCtx) {
  const disposers = []
  // 路由里要用 ctx 做日志/技能失效通知；用传入的已注入上下文，避免闭包抓不到外层 ctx。
  const ctx = wsCtx
    disposers.push(
      wsCtx.webServer.register({
        kind: 'exact',
        path: '/api/retro/snapshot',
        handler: async (req, res) => {
          if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: '只支持 GET' })
          try {
            sendJson(res, 200, { ok: true, ...panelSnapshot() })
          } catch (error) {
            sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
          }
        },
      }),
    )

    disposers.push(
      wsCtx.webServer.register({
        kind: 'exact',
        path: '/api/retro/settings',
        handler: async (req, res) => {
          if (runtime.paths === null) return sendJson(res, 503, { ok: false, error: '插件尚未初始化' })

          if (req.method === 'GET') {
            return sendJson(res, 200, {
              ok: true,
              config: runtime.config,
              settings: runtime.settings,
              baseConfig: runtime.baseConfig,
              overridden: Object.keys(runtime.settings),
              editable: RUNTIME_KEYS,
              booleanKeys: BOOLEAN_KEYS,
              numberRanges: NUMBER_RANGES,
              path: settingsPath(runtime.paths.root),
            })
          }

          if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只支持 GET/POST' })
          const parsed = await readJsonBody(req)
          if (!parsed.ok) return sendJson(res, parsed.status, { ok: false, error: parsed.error })

          // action=reset 清空运行期设置，回落到部署配置
          if (parsed.body.action === 'reset') {
            const removed = clearSettings(runtime.paths.root)
            runtime.settings = {}
            runtime.config = mergeSettings(runtime.baseConfig, {})
            refreshDigest()
            return sendJson(res, 200, { ok: true, cleared: removed, config: runtime.config, settings: {}, overridden: [] })
          }

          const patch = parsed.body.settings ?? parsed.body
          const result = updateSettings(patch)
          if (!result.ok) {
            return sendJson(res, 400, {
              ok: false,
              error: `这些设置没被采纳：${result.rejected.map((item) => `${item.key}（${item.reason}）`).join('；')}`,
              rejected: result.rejected,
              config: result.config,
            })
          }
          sendJson(res, 200, {
            ok: true,
            config: runtime.config,
            settings: runtime.settings,
            overridden: Object.keys(runtime.settings),
            path: settingsPath(runtime.paths.root),
          })
        },
      }),
    )

    disposers.push(
      wsCtx.webServer.register({
        kind: 'exact',
        path: '/api/retro/promote',
        handler: async (req, res) => {
          if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只支持 POST' })
          const parsed = await readJsonBody(req)
          if (!parsed.ok) return sendJson(res, parsed.status, { ok: false, error: parsed.error })
          const signature = typeof parsed.body.signature === 'string' ? parsed.body.signature.trim() : ''
          if (signature === '') return sendJson(res, 400, { ok: false, error: 'signature 不能为空' })
          if (runtime.paths === null) return sendJson(res, 503, { ok: false, error: '插件尚未初始化' })
          try {
            const entry = findFlow(readFlows(runtime.paths.flows), signature)
            if (entry === undefined) return sendJson(res, 404, { ok: false, error: `找不到流程签名 ${signature}` })
            const draft = writeDraft(entry, ctx)
            // 面板上点击「沉淀为技能」→ manual，不参与自动淘汰
            const result = promoteSkill(entry, draft, ctx, 'manual')
            sendJson(res, 200, { ok: true, ...result })
          } catch (error) {
            sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
          }
        },
      }),
    )

    disposers.push(
      wsCtx.webServer.register({
        kind: 'exact',
        path: '/api/retro/forget',
        handler: async (req, res) => {
          if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只支持 POST' })
          const parsed = await readJsonBody(req)
          if (!parsed.ok) return sendJson(res, parsed.status, { ok: false, error: parsed.error })
          const signature = typeof parsed.body.signature === 'string' ? parsed.body.signature.trim() : ''
          if (signature === '') return sendJson(res, 400, { ok: false, error: 'signature 不能为空' })
          if (runtime.paths === null) return sendJson(res, 503, { ok: false, error: '插件尚未初始化' })
          try {
            const before = readFailures()
            const keptFailures = before.filter((record) => record.signature !== signature)
            writeFailures(keptFailures)
            const beforeFlows = readFlows(runtime.paths.flows)
            const keptFlows = beforeFlows.filter((flow) => flow.signature !== signature)
            writeFlows(keptFlows)
            let removedSkill = ''
            for (const flow of beforeFlows) {
              if (flow.signature !== signature || !flow.skillName) continue
              const file = join(runtime.paths.skillsDir, `${flow.skillName}.md`)
              if (!existsSync(file)) continue
              try {
                unlinkSync(file)
                removedSkill = flow.skillName
              } catch {
                /* 删不掉不影响主流程 */
              }
            }
            if (removedSkill !== '') notifySkillsChanged()
            refreshDigest()
            sendJson(res, 200, {
              ok: true,
              removedFailures: before.length - keptFailures.length,
              removedFlows: beforeFlows.length - keptFlows.length,
              removedSkill,
            })
          } catch (error) {
            sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
          }
        },
      }),
    )

    disposers.push(
      wsCtx.webServer.register({
        kind: 'exact',
        path: '/api/retro/summary',
        handler: async (req, res) => {
          if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只支持 POST' })
          const parsed = await readJsonBody(req)
          if (!parsed.ok) return sendJson(res, parsed.status, { ok: false, error: parsed.error })
          if (runtime.paths === null) return sendJson(res, 503, { ok: false, error: '插件尚未初始化' })
          const useModel = parsed.body.useModel === true
          try {
            const { text, input } = summarizeRules()
            if (!useModel) return sendJson(res, 200, { ok: true, text, generatedAt: input.generatedAt })
            const review = await summarizeWithModel(ctx, input)
            if (!review.ok) {
              return sendJson(res, 200, { ok: true, text, generatedAt: input.generatedAt, modelError: review.reason })
            }
            const merged = renderSummaryMarkdown({ ...input, llmText: review.text })
            writeSummary(merged, input.generatedAt)
            sendJson(res, 200, { ok: true, text: merged, generatedAt: input.generatedAt })
          } catch (error) {
            sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
          }
        },
      }),
    )

    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* 忽略 */
        }
      }
    }
}

/** 按标识找流程：兼容「骨架」与「完整序列」两种写法，也兼容旧数据（无 skeleton 字段）。 */
function findFlow(flows, id) {
  const key = String(id ?? '').trim()
  if (key === '') return undefined
  return flows.find((flow) => (flow.skeleton ?? flow.signature) === key || flow.signature === key)
}

/** 供工具/命令/路由共用的删除逻辑。 */
function forgetBySignature(signature) {
  const failures = readFailures()
  const keptFailures = failures.filter((record) => record.signature !== signature)
  writeFailures(keptFailures)
  const beforeFlows = readFlows(runtime.paths.flows)
  const keptFlows = beforeFlows.filter((flow) => (flow.skeleton ?? flow.signature) !== signature && flow.signature !== signature)
  writeFlows(keptFlows)
  return { removedFailures: failures.length - keptFailures.length, removedFlows: beforeFlows.length - keptFlows.length, beforeFlows }
}

function registerCommand(ctx) {
  return ctx.commands.register({
    name: 'retro',
    description: '运行复盘与技能沉淀。用法：/retro [show|summary|skills|promote <签名>|forget <签名>|config]',
    input: { hint: '[show|summary|skills|promote <签名>|forget <签名>|config]' },
    async handler(invocation) {
      const raw = String(invocation?.rawInput ?? '').trim()
      const spaceAt = raw.search(/\s/)
      const verb = (spaceAt < 0 ? raw : raw.slice(0, spaceAt)).toLowerCase()
      const rest = spaceAt < 0 ? '' : raw.slice(spaceAt + 1).trim()
      try {
        if (verb === '' || verb === 'show') {
          const { failures, flows, skills, aggregated } = aggregateNow()
          return {
            kind: 'success',
            text: [
              '运行复盘状态',
              `- 根目录：${runtime.paths.root}`,
              `- 失败记录：${failures.length} 条 / ${aggregated.length} 个签名`,
              `- 固定流程：${flows.length} 条（阈值 ${runtime.config.flowThreshold} 次）`,
              `- 已沉淀技能：${skills.length} 个`,
              `- 注入摘要：${runtime.digest.length} 字符（预算 ${runtime.config.promptBudget}）`,
              `- 自动沉淀：失败 ${runtime.config.autoCapture ? '开' : '关'} / 草稿 ${runtime.config.autoDraft ? '开' : '关'} / 自动晋升 ${runtime.config.autoPromote ? '开' : '关'}`,
              '',
              '子命令：summary | skills | promote <签名> | forget <签名> | config | set <key>=<value> | reset',
            ].join('\n'),
          }
        }
        if (verb === 'summary') {
          const { text } = summarizeRules()
          return { kind: 'success', text: clip(text, 5000) }
        }
        if (verb === 'skills') {
          const { flows, skills } = aggregateNow()
          const lines = ['已沉淀技能：']
          if (skills.length === 0) lines.push('（无）')
          for (const skill of skills) lines.push(`- ${skill.name}`)
          lines.push('', '固定流程（骨架 × 次数）：')
          if (flows.length === 0) lines.push('（无）')
          for (const flow of flows.slice(0, 12)) {
            const mark = flow.promoted ? '已沉淀' : '待沉淀'
            const skeleton = flow.skeleton ?? flow.signature
            lines.push(`- [${mark}] ${oneLine(flow.title ?? '', 36)} ×${flow.count ?? 0}  ${skeleton}`)
          }
          if (flows.length > 0) lines.push('', '（最后一列是骨架，可直接用于 /retro promote <骨架>）')
          return { kind: 'success', text: lines.join('\n') }
        }
        if (verb === 'promote') {
          if (rest === '') return { kind: 'error', text: '用法：/retro promote <骨架>（用 /retro skills 查看）' }
          const entry = findFlow(aggregateNow().flows, rest)
          if (entry === undefined) return { kind: 'error', text: `找不到流程 ${rest}` }
          const draft = writeDraft(entry, ctx)
          // /retro promote 是人明确要求的 → manual，不参与自动淘汰
          const { skillName, target } = promoteSkill(entry, draft, ctx, 'manual')
          return { kind: 'success', text: `已晋升 ${skillName} → ${target}` }
        }
        if (verb === 'forget') {
          if (rest === '') return { kind: 'error', text: '用法：/retro forget <骨架或失败签名>' }
          const { removedFailures, removedFlows } = forgetBySignature(rest)
          refreshDigest()
          return { kind: 'success', text: `已清除 ${rest}：失败记录 ${removedFailures} 条、流程 ${removedFlows} 条` }
        }
        if (verb === 'config' || verb === 'set') {
          // /retro set autoPromote=true flowThreshold=5  —— 改完立即生效，不用重启
          if (verb === 'set' && rest !== '') {
            const patch = {}
            const bad = []
            for (const token of rest.split(/\s+/).filter(Boolean)) {
              const eq = token.indexOf('=')
              if (eq <= 0) {
                bad.push(token)
                continue
              }
              const key = token.slice(0, eq)
              const value = token.slice(eq + 1)
              if (value === 'true' || value === 'false') patch[key] = value === 'true'
              else if (/^-?\d+$/.test(value)) patch[key] = Number(value)
              else patch[key] = value
            }
            if (bad.length > 0) {
              return { kind: 'error', text: `这些参数不是 key=value 形式：${bad.join(' ')}` }
            }
            const result = updateSettings(patch)
            if (!result.ok) {
              return {
                kind: 'error',
                text: `没被采纳：${result.rejected.map((item) => `${item.key}（${item.reason}）`).join('；')}`,
              }
            }
            const lines = ['设置已更新（立即生效，无需重启）：']
            for (const key of Object.keys(result.config)) {
              if (!RUNTIME_KEYS.includes(key)) continue
              const mark = Object.hasOwn(runtime.settings, key) ? ' *' : ''
              lines.push(`- ${key} = ${JSON.stringify(result.config[key])}${mark}`)
            }
            lines.push('', `（* = 运行期覆盖，存在 ${settingsPath(runtime.paths.root)}；/retro reset 可回落部署配置）`)
            return { kind: 'success', text: lines.join('\n') }
          }

          const lines = ['当前生效配置（运行期设置覆盖部署配置）：']
          for (const key of RUNTIME_KEYS) {
            const overridden = Object.hasOwn(runtime.settings, key)
            lines.push(`- ${key} = ${JSON.stringify(runtime.config[key])}${overridden ? ' *' : ''}`)
          }
          lines.push(
            '',
            `- 部署配置：${JSON.stringify(runtime.baseConfig.autoPromote)} 等（改 cordis.patch.yml 需要重启）`,
            `- 运行期设置：${settingsPath(runtime.paths.root)}${Object.keys(runtime.settings).length > 0 ? `（${Object.keys(runtime.settings).join(', ')}）` : '（空）'}`,
            '',
            '改法：/retro set autoPromote=true flowThreshold=5   然后立即生效',
            '      /retro reset   清空运行期设置，回落到部署配置',
          )
          return { kind: 'success', text: lines.join('\n') }
        }
        if (verb === 'reset') {
          const removed = clearSettings(runtime.paths.root)
          runtime.settings = {}
          runtime.config = mergeSettings(runtime.baseConfig, {})
          refreshDigest()
          return {
            kind: 'success',
            text: removed ? '已清空运行期设置，回落到部署配置' : '本来就没有运行期设置',
          }
        }
        return {
          kind: 'error',
          text: '未知子命令。可用：show | summary | skills | promote <签名> | forget <签名> | config | set <key>=<value> | reset',
        }
      } catch (error) {
        return { kind: 'error', text: `复盘命令失败：${String(error?.message ?? error)}` }
      }
    },
  })
}

// ==================== ⑨ 主入口 ====================

export async function apply(ctx, config) {
  applyConfig(ctx, config ?? {})
  loadState()
  refreshDigest()

  if (!runtime.config.enabled) {
    ctx.logger?.info?.('[dsh-retro] disabled by config; no listeners registered')
    return
  }

  const disposers = []
  disposers.push(ctx.on('tools/result', (exec, result) => onToolResult(ctx, exec, result)))
  disposers.push(ctx.on('session/event', (session, event) => onSessionEvent(ctx, session, event), { global: true }))
  disposers.push(
    ctx.on(
      'session/event',
      (session, event) => {
        if (event?.type !== 'turn/end') return
        const state = loadState()
        saveState({ turns: Number(state.turns ?? 0) + 1 })
      },
      { global: true },
    ),
  )

  disposers.push(registerTools(ctx))

  // 模型复盘要用的两个服务：agentDefaultModel（当前对话的 provider/model）与 llm（发起请求）。
  //
  // 关键：**不能**写进静态 inject 数组。静态 inject 少一个服务整块插件就不激活——
  // 而这俩服务只是「模型复盘」这一增强项的前提，缺了它插件其余部分照常该跑。
  // 早期只在代码里读 ctx.agentDefaultModel 却没走 ctx.inject，结果是永远 undefined，
  // 模型复盘恒报「当前会话没有可用的 provider/model」——静默失效。
  ctx.inject(['agentDefaultModel'], (modelCtx) => {
    runtime.agentDefaultModel = modelCtx.agentDefaultModel
    modelCtx.effect(() => () => {
      if (runtime.agentDefaultModel === modelCtx.agentDefaultModel) runtime.agentDefaultModel = null
    }, 'dsh-retro: agentDefaultModel')
  })

  ctx.inject(['llm'], (llmCtx) => {
    runtime.llm = llmCtx.llm
    llmCtx.effect(() => () => {
      if (runtime.llm === llmCtx.llm) runtime.llm = null
    }, 'dsh-retro: llm')
  })

  ctx.inject(['skills'], (skillsCtx) => {
    try {
      disposers.push(registerSkillProvider(skillsCtx))
    } catch (error) {
      ctx.logger?.warn?.(`[dsh-retro] 注册技能 provider 失败：${String(error?.message ?? error)}`)
    }
  })

  ctx.inject(['systemPrompt'], (spCtx) => {
    try {
      disposers.push(registerPromptSection(spCtx))
    } catch (error) {
      ctx.logger?.warn?.(`[dsh-retro] 注册提示词 section 失败：${String(error?.message ?? error)}`)
    }
  })

  ctx.inject(['commands'], (cmdCtx) => {
    try {
      disposers.push(registerCommand(cmdCtx))
    } catch (error) {
      ctx.logger?.warn?.(`[dsh-retro] 注册 /retro 命令失败：${String(error?.message ?? error)}`)
    }
  })

  // Web 面板的数据源。没有 webServer（headless / tui）时整块跳过，
  // 其余功能照常工作 —— 面板是增强，不是前提。
  ctx.inject(['webServer'], (wsCtx) => {
    try {
      disposers.push(registerRoutes(wsCtx))
    } catch (error) {
      ctx.logger?.warn?.(`[dsh-retro] 注册 HTTP 路由失败：${String(error?.message ?? error)}`)
    }
  })

  ctx.effect(() => () => {
    if (runtime.refreshTimer !== null) {
      clearTimeout(runtime.refreshTimer)
      runtime.refreshTimer = null
    }
    runtime.cursor.clear()
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* 忽略 */
      }
    }
  }, 'dsh-retro: teardown')
}

export default { name, inject, apply }

/** 供 scripts/verify.mjs 做纯逻辑回归（不参与宿主体内调用）。 */
export const __internal = { refreshDigest, buildSummaryInput, summarizeRules, renderForFlow, stepsOf, pitfallsFor, registerRoutes, panelSnapshot }
