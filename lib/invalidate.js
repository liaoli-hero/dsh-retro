// lib/invalidate.js — 技能目录的失效通知（把「晋升后模型看不见」这个坑单独收口）
//
// 背景：@deepseek-ai/dsh-skill 的 registry **没有 TTL**，provider 的 list() 结果
// 会按 cwd/scope/revision 缓存。provider 如果只改磁盘、不调 registration 作用域的
// invalidate()，模型侧的技能目录就永远停在旧快照上——表现为「技能文件明明写出来了，
// skill 工具却看不到」，而且只在重启后才出现，最难排查。
//
// 所以：任何一次写 skills/ 的操作（晋升、删除、镜像）都必须伴随一次 invalidate()。
// 这里用一个极小的持有对象把「当前生效的 provider 注册」存起来，写盘路径统一问它：
// 注册还没发生（skills 服务未挂载）时是 no-op，不会因为顺序问题抛错。

const state = { invalidate: null }

/** 由 registerProvider 的工厂回调调用：记下本次注册的失效能力。 */
export function bindInvalidate(invalidate) {
  if (typeof invalidate === 'function') state.invalidate = invalidate
  return () => {
    if (state.invalidate === invalidate) state.invalidate = null
  }
}

/** 写盘后通知 registry 重新发现；未挂载 skills 服务时静默跳过。 */
export function notifySkillsChanged() {
  const invalidate = state.invalidate
  if (typeof invalidate !== 'function') return false
  try {
    invalidate()
    return true
  } catch {
    return false
  }
}

/** 供测试/诊断。 */
export function hasInvalidate() {
  return typeof state.invalidate === 'function'
}
