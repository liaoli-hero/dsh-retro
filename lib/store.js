// lib/store.js — 落盘布局与配置归一化（零依赖）
//
// 目录布局（$DSH_HOME/dsh-retro/）：
//   fails.jsonl      失败经验（append-only，逐条）
//   flows.jsonl      工作流序列聚合（整体重写，规模小）
//   skills/          已晋升的技能（扁平 <name>.md，被内置 provider 暴露给模型）
//   drafts/          自动生成的技能草稿（不在 catalog 里，需晋升）
//   summary.md       最近的自我总结（规则式或模型式）
//   state.json       计数器与开关运行态
//
// 为什么不塞进 session 日志：Session 是模型可见事实的 append-only 账本，
// 复盘数据是**跨会话**的长期记忆，塞进去会让每一轮请求都携带无关历史。

import { homedir } from 'node:os'
import { join } from 'node:path'
import { clamp } from './util.js'

/** 最近若干条经验的写入上限，超过按行裁剪（append-only 也需要上界）。 */
export const FAILS_MAX_LINES = 4000
/** 单条经验里错误文本的上限字符数。 */
export const FAIL_TEXT_MAX = 1400

export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return join(homedir(), '.dsh')
}

export function retroRoot(config) {
  const configured = config?.rootDir
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  return join(dshHome(), 'dsh-retro')
}

export function paths(config) {
  const root = retroRoot(config)
  return {
    root,
    fails: join(root, 'fails.jsonl'),
    flows: join(root, 'flows.jsonl'),
    state: join(root, 'state.json'),
    summary: join(root, 'summary.md'),
    skillsDir: join(root, 'skills'),
    draftsDir: join(root, 'drafts'),
  }
}

/**
 * 所有可配置项的默认值 —— 也就是**装完即用的最佳配置**。
 *
 * 设计原则：新用户不该先读文档调参数。默认值必须满足三件事：
 *   ① 装完就有完整价值（经验记录、总结、技能沉淀全都在跑）
 *   ② 不产生噪音（阈值不过低，避免把偶然重复当固定流程）
 *   ③ 任何自动行为都留得下痕迹（晋升同时留草稿，可回溯来源）
 *
 * 想改就改，但「不改也能用好」是这套默认值的存在理由。
 */
export const DEFAULT_CONFIG = {
  /** false 时插件整体停摆（不记录、不注入、不注册工具） */
  enabled: true,
  /** 经验/技能存储根；空 = $DSH_HOME/dsh-retro */
  rootDir: '',
  /** 是否自动记录失败经验 */
  autoCapture: true,
  /** 达阈值时生成技能草稿（drafts/，模型看不到，可回看来源） */
  autoDraft: true,
  /** 达阈值时直接晋升进 catalog（skills/，模型立即可用）= 全自动 */
  autoPromote: true,
  /**
   * 同一工作流出现多少次才视为「固定流程」。
   * 4 而不是 3：3 次里很容易有两次是同一次排查的连续重试，
   * 4 次才更像"这是个会重复的任务类型"。
   */
  flowThreshold: 4,
  /** 同一失败签名重复多少次才在总结里被标为「高频」 */
  repeatThreshold: 2,
  /** 注入系统提示词的字符预算（0 = 不注入） */
  promptBudget: 1200,
  /** 总结里最多列多少条 */
  summaryTopN: 6,
  /** 技能 provider 在 catalog 里的优先级（数值小者优） */
  skillRank: 250,
  /** 额外把晋升的技能镜像一份到 $DSH_HOME/skills（供 filesystem provider 发现） */
  mirrorToUserSkills: false,
  /**
   * 复盘模型调用超时（毫秒）。
   *
   * "用不用模型写复盘" 不是配置项而是**调用时参数**（`retro_summary useModel=true`
   * 或面板上的「用模型复盘」按钮）——它的成本随时可变，绑进配置文件反而别扭。
   */
  llmTimeoutMs: 45000,
  /** 记录单条失败时最多存多少字符 */
  maxErrorChars: FAIL_TEXT_MAX,
  /** 保留的工作流条目上限 */
  maxFlows: 300,
  /**
   * 自动晋升的质量上限：skills/ 里最多保留多少个自动沉淀的技能。
   * 超过后按「最久没被再次命中」淘汰 —— 防止长期使用后技能目录无限膨胀，
   * 那会挤占模型技能目录的篇幅、也让真正有用的技能被淹没。
   * 0 = 不限制。
   */
  maxAutoSkills: 40,
}

/** 归一化任意来源的配置：未知键丢弃，类型错误回落默认值。 */
export function normalizeConfig(raw) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const bool = (key) => (typeof input[key] === 'boolean' ? input[key] : DEFAULT_CONFIG[key])
  const str = (key) => (typeof input[key] === 'string' ? input[key] : DEFAULT_CONFIG[key])
  return {
    enabled: bool('enabled'),
    rootDir: str('rootDir'),
    autoCapture: bool('autoCapture'),
    autoDraft: bool('autoDraft'),
    autoPromote: bool('autoPromote'),
    flowThreshold: clamp(input.flowThreshold, 2, 10, DEFAULT_CONFIG.flowThreshold),
    repeatThreshold: clamp(input.repeatThreshold, 1, 20, DEFAULT_CONFIG.repeatThreshold),
    promptBudget: clamp(input.promptBudget, 0, 8000, DEFAULT_CONFIG.promptBudget),
    summaryTopN: clamp(input.summaryTopN, 1, 20, DEFAULT_CONFIG.summaryTopN),
    skillRank: clamp(input.skillRank, 1, 999, DEFAULT_CONFIG.skillRank),
    mirrorToUserSkills: bool('mirrorToUserSkills'),
    llmTimeoutMs: clamp(input.llmTimeoutMs, 5000, 300000, DEFAULT_CONFIG.llmTimeoutMs),
    maxErrorChars: clamp(input.maxErrorChars, 200, 8000, DEFAULT_CONFIG.maxErrorChars),
    maxFlows: clamp(input.maxFlows, 20, 2000, DEFAULT_CONFIG.maxFlows),
    maxAutoSkills: clamp(input.maxAutoSkills, 0, 500, DEFAULT_CONFIG.maxAutoSkills),
  }
}
