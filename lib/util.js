// lib/util.js — 零依赖工具：摘要、脱敏、原子写、JSONL 读写
//
// 设计约束：本插件**只**依赖 node: 内置模块。
// 原因有两条：
//   ① 插件在半隔离环境里由宿主的 profile 解析器加载，少一个裸包依赖就少一个
//      "版本对不上导致整层不加载" 的失败面；
//   ② scripts/verify.mjs 要能在任意目录下 `import()` 本包做纯逻辑回归，
//      不预先铺 node_modules。

import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 稳定短哈希（签名用，前台可读）。 */
export function shortHash(text, length = 12) {
  return createHash('sha1').update(String(text), 'utf8').digest('hex').slice(0, length)
}

/** 压成单行并截断，避免把换行塞进标题/清单。 */
export function oneLine(text, max = 200) {
  const flat = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\s*\n\s*/g, ' ⏎ ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
  return flat.length > max ? `${flat.slice(0, Math.max(0, max - 1))}…` : flat
}

/** 首行（用于标题）。 */
export function firstLine(text, max = 160) {
  const line = String(text ?? '').split(/\r?\n/).find((part) => part.trim() !== '') ?? ''
  return oneLine(line, max)
}

/** 截断长文本，保留尾部（错误栈的价值通常在末尾）。 */
export function clip(text, max = 1500) {
  const value = String(text ?? '')
  if (value.length <= max) return value
  const head = Math.max(0, Math.floor(max * 0.25))
  const tail = Math.max(0, max - head - 24)
  return `${value.slice(0, head)}\n…[省略 ${value.length - head - tail} 字符]…\n${value.slice(-tail)}`
}

/**
 * 记忆落盘前脱敏：密钥、令牌、长 base64/十六进制块一律替换。
 * 失败经验会长期保存在磁盘上，并在提示词里回显，脱敏是必须项而不是可选项。
 */
export function redact(text) {
  let out = String(text ?? '')
  out = out.replace(/\b(sk|pk|rk|ghp|gho|xox[baprs])[-_][A-Za-z0-9_-]{12,}/g, '$1-***REDACTED***')
  out = out.replace(/\b(Authorization|authorization)\s*:\s*[^\n]{4,}/g, '$1: ***REDACTED***')
  out = out.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g, 'Bearer ***REDACTED***')
  out = out.replace(/\b[A-Za-z0-9+/]{60,}={0,2}\b/g, '***REDACTED***')
  out = out.replace(/\b[0-9a-fA-F]{48,}\b/g, '***REDACTED***')
  out = out.replace(
    /\b(password|passwd|pwd|secret|token|api[_-]?key)\b(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi,
    '$1$2***REDACTED***',
  )
  return out
}

/** 数值夹紧。 */
export function clamp(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** 保证是字符串数组（去空、去重、限量）。 */
export function stringList(value, max = 12) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  const out = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (trimmed === '' || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
    if (out.length >= max) break
  }
  return out
}

/** 目录确保存在。 */
export function ensureDir(path) {
  mkdirSync(path, { recursive: true })
  return path
}

/** 同目录临时文件 + rename：避免半截文件被下一轮读到。 */
export function atomicWrite(file, text) {
  ensureDir(dirname(file))
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, text, 'utf8')
  try {
    renameSync(tmp, file)
  } catch (error) {
    try {
      unlinkSync(tmp)
    } catch {
      /* 临时文件清理失败不影响主流程 */
    }
    throw error
  }
}

/** 追加一行 JSON（容错：单行失败不抛给宿主）。 */
export function appendJsonl(file, value) {
  ensureDir(dirname(file))
  appendFileSync(file, `${JSON.stringify(value)}\n`, 'utf8')
}

/** 读 JSONL，坏行跳过；超过 maxLines 只保留尾部。 */
export function readJsonl(file, maxLines = 5000) {
  if (!existsSync(file)) return []
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const lines = raw.split('\n').filter((line) => line.trim() !== '')
  const kept = lines.length > maxLines ? lines.slice(-maxLines) : lines
  const out = []
  for (const line of kept) {
    try {
      const parsed = JSON.parse(line)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) out.push(parsed)
    } catch {
      /* 坏行跳过：日志文件被外部编辑也能继续工作 */
    }
  }
  return out
}

/** 读 JSON 对象，缺失/损坏回落 fallback。 */
export function readJson(file, fallback) {
  if (!existsSync(file)) return fallback
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : fallback
  } catch {
    return fallback
  }
}

/** 按行裁剪 JSONL，保留尾部 keep 行。 */
export function trimJsonl(file, keep) {
  if (!existsSync(file) || !Number.isFinite(keep) || keep <= 0) return
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return
  }
  const lines = raw.split('\n').filter((line) => line.trim() !== '')
  if (lines.length <= keep) return
  atomicWrite(file, `${lines.slice(-keep).join('\n')}\n`)
}

/** 时间戳（本地可读 + 机器可读各一份，存 ISO）。 */
export function nowIso() {
  return new Date().toISOString()
}

/** 路径安全的 kebab-case（技能名必须是 ^[a-z0-9]+(-[a-z0-9]+)*$）。 */
export function kebab(text, max = 40) {
  const slug = String(text ?? '')
    .toLowerCase()
    .replace(/[`'"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
  const cut = slug.slice(0, max).replace(/-+$/g, '')
  return cut
}

// 便于测试/上层拼接
export function joinPath(...parts) {
  return join(...parts)
}
