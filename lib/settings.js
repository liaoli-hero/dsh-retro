// lib/settings.js — 运行期设置的持久化与合并（零依赖）
//
// 为什么需要这一层：
//   插件 config（cordis.patch.yml 里的那段）只在**装配时**读一次，改完必须重启。
//   而「自动晋升开不开」「阈值调几」这类事是**使用中反复调的**，让它跟重启绑定
//   就是设计问题。所以拆成两层：
//
//     config（部署层）  — 默认值 + 初始值，改它要重启，适合定长期基线
//     settings（运行层）— 面板/命令直接改，写 $DSH_HOME/dsh-retro/settings.json，
//                         改完立即生效，无需重启
//
//   合并规则：**settings 覆盖 config**，但只覆盖它显式写过的键。
//   这样「配置里写 autoPromote: true，面板上临时关掉」是可表达的，
//   且删掉 settings.json 就回落到 config —— 没有隐式状态。

import { existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { normalizeConfig } from './store.js'
import { atomicWrite, readJson } from './util.js'

/** settings 文件名（与其它落盘物同目录）。 */
export const SETTINGS_FILE = 'settings.json'

/** 允许在运行期修改的键。其余键（如 rootDir）改了会牵动路径，必须走 config。 */
export const RUNTIME_KEYS = [
  'enabled',
  'autoCapture',
  'autoDraft',
  'autoPromote',
  'flowThreshold',
  'repeatThreshold',
  'promptBudget',
  'summaryTopN',
  'mirrorToUserSkills',
  'maxErrorChars',
  'maxAutoSkills',
]

/** 布尔类键，面板上渲染成开关。 */
export const BOOLEAN_KEYS = ['enabled', 'autoCapture', 'autoDraft', 'autoPromote', 'mirrorToUserSkills']

/** 数值类键与其合法范围（与 normalizeConfig 的 clamp 保持一致）。 */
export const NUMBER_RANGES = {
  flowThreshold: [2, 10],
  repeatThreshold: [1, 20],
  promptBudget: [0, 8000],
  summaryTopN: [1, 20],
  maxErrorChars: [200, 8000],
  maxAutoSkills: [0, 500],
}

export function settingsPath(root) {
  return join(root, SETTINGS_FILE)
}

/**
 * 读 settings 文件。缺失/损坏都回落空对象 —— 设置丢失是可恢复的，
 * 不该让插件起不来。
 * @param {string} root
 * @returns {object}
 */
export function readSettings(root) {
  const raw = readJson(settingsPath(root), {})
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out = {}
  for (const key of RUNTIME_KEYS) {
    if (!Object.hasOwn(raw, key)) continue
    out[key] = raw[key]
  }
  return out
}

/**
 * 只保留合法键与合法值；返回 { accepted, rejected }。
 * 类型不对/超范围的**整项丢弃**而不是静默夹紧：调用方（面板/命令）需要
 * 知道"你填的 999 没被采纳"，否则用户以为设置生效了。
 * @param {object} patch
 */
export function sanitizeSettings(patch) {
  const accepted = {}
  const rejected = []
  const input = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {}

  for (const [key, value] of Object.entries(input)) {
    if (!RUNTIME_KEYS.includes(key)) {
      rejected.push({ key, reason: `不允许在运行期修改（keys: ${RUNTIME_KEYS.join(', ')}）` })
      continue
    }
    if (BOOLEAN_KEYS.includes(key)) {
      if (typeof value !== 'boolean') {
        rejected.push({ key, reason: '必须是布尔值' })
        continue
      }
      accepted[key] = value
      continue
    }
    if (Object.hasOwn(NUMBER_RANGES, key)) {
      const [min, max] = NUMBER_RANGES[key]
      const num = Number(value)
      if (!Number.isFinite(num) || !Number.isInteger(num) || num < min || num > max) {
        rejected.push({ key, reason: `必须是 ${min}–${max} 之间的整数` })
        continue
      }
      accepted[key] = num
      continue
    }
    rejected.push({ key, reason: '未知设置项' })
  }
  return { accepted, rejected }
}

/**
 * 合并 settings 到 config 之上，得到**当前生效**的配置。
 * @param {object} config 插件 config（已 normalize）
 * @param {object} settings 运行期设置（可能为空）
 */
export function mergeSettings(config, settings) {
  const { accepted } = sanitizeSettings(settings ?? {})
  return normalizeConfig({ ...config, ...accepted })
}

/**
 * 写入 settings 并返回合并后的生效配置。
 * @param {string} root
 * @param {object} config 插件 config
 * @param {object} patch 要改的键
 * @returns {{ settings: object, config: object, rejected: Array }}
 */
export function writeSettings(root, config, patch) {
  const { accepted, rejected } = sanitizeSettings(patch)
  if (Object.keys(accepted).length === 0) {
    return { settings: readSettings(root), config: mergeSettings(config, readSettings(root)), rejected }
  }
  const merged = { ...readSettings(root), ...accepted }
  atomicWrite(settingsPath(root), `${JSON.stringify(merged, null, 2)}\n`)
  return { settings: merged, config: mergeSettings(config, merged), rejected }
}

/** 清空运行期设置，回落到 config 的值。 */
export function clearSettings(root) {
  const file = settingsPath(root)
  if (!existsSync(file)) return false
  try {
    unlinkSync(file)
    return true
  } catch {
    return false
  }
}
