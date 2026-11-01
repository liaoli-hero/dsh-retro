// scripts/verify-render.mjs — 在最小 React 运行时下真跑一遍面板组件
//
// 为什么不用真 React：磁盘上没有 react 包（它被打进前端 bundle 了），
// 而这里要验的不是 React 语义，是**我们自己的组件逻辑**：
//   · 空数据 / 有数据 / 加载失败 三种状态下都渲染得出来、不抛错
//   · t() 的每个键都命中词典（缺键会露出裸 key）
//   · fetch 真的打到 /api/retro/snapshot，错误被转成可读文案
//
// 用一个 ~100 行的最小 hooks 运行时跑真实组件函数，比静态检查强得多：
// 它能抓到「某条数据缺字段导致 map 里炸」这类只有跑起来才暴露的问题。
//
// 用法：node scripts/verify-render.mjs

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = join(here, '..')

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

// ---------------------------------------------------------------- 最小 React

const Fragment = Symbol('Fragment')

function makeElement(type, props) {
  return { $$typeof: 'element', type, props: props ?? {} }
}

/** jsx / jsxs / createElement 统一到同一棵树。 */
function jsx(type, props) {
  return makeElement(type, props)
}

class Hooks {
  constructor() {
    this.states = []
    this.cursor = 0
    this.effects = []
    this.rendered = 0
  }
  reset() {
    this.cursor = 0
    this.effects = []
  }
}

const hooks = new Hooks()

/**
 * 每个组件实例一份 hook 状态。真实 React 按组件（按树中位置）隔离状态；
 * 早期版本所有组件共用 hooks.states，于是子组件（NumberRow 的 useState）
 * 会覆盖父组件的状态槽 —— 表现为主组件数据"消失"，其实只是被挤掉了。
 * 这里用 组件函数 + 渲染路径 作为实例键。
 */
const instanceStates = new Map()
let renderPath = 'root'

/** 本轮渲染收集到的 effect（渲染结束后由 renderWith 统一跑一遍）。 */
const pendingEffects = []

const React = {
  Fragment,
  createElement: jsx,
  useState(initial) {
    const index = hooks.cursor
    hooks.cursor += 1
    if (hooks.states[index] === undefined) hooks.states[index] = { value: initial }
    const slot = hooks.states[index]
    const set = (next) => {
      slot.value = typeof next === 'function' ? next(slot.value) : next
    }
    return [slot.value, set]
  },  useRef(initial) {
    const index = hooks.cursor
    hooks.cursor += 1
    if (hooks.states[index] === undefined) hooks.states[index] = { value: { current: initial } }
    return hooks.states[index].value
  },
  useCallback(fn) {
    // 忠实模拟 React：按 hook 位置缓存，依赖不变则返回同一引用。
    // （否则每次渲染都产生新函数 ⇒ 依赖 [refresh] 的 effect 每次重跑 ⇒ fetch 死循环）
    const index = hooks.cursor
    hooks.cursor += 1
    if (hooks.states[index] === undefined) hooks.states[index] = { value: fn }
    return hooks.states[index].value
  },
  useEffect(fn) {
    hooks.cursor += 1
    hooks.effects.push(fn)
    return undefined
  },  useMemo(fn) {
    hooks.cursor += 1
    return fn()
  },
}

// ---------------------------------------------------------------- 加载 bundle

let registered = null
globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      registered = entry
    },
  },
}
globalThis.document = {
  head: { appendChild() {} },
  querySelector() {
    return null
  },
  createElement() {
    return { dataset: {}, textContent: '' }
  },
  visibilityState: 'visible',
}
globalThis.setInterval = () => 0
globalThis.clearInterval = () => {}
globalThis.clearTimeout = () => {}

const source = readFileSync(join(pkgRoot, 'client/index.js'), 'utf8')
// 以函数形式执行，模拟浏览器把 bundle 当脚本跑
new Function('window', 'document', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', source)(
  globalThis.window,
  globalThis.document,
  globalThis.setInterval,
  globalThis.clearInterval,
  () => 0,
  globalThis.clearTimeout,
)

check('bundle 注册了模块', registered !== null && registered.id === 'dsh-retro', JSON.stringify(registered?.id))

const required = []
const client = registered.factory((name) => {
  required.push(name)
  if (name === 'react') return React
  if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment, jsxDEV: jsx }
  throw new Error(`unexpected require: ${name}`)
})

check('导出 apply', typeof client.apply === 'function')
check('导出 PANEL_ID', typeof client.PANEL_ID === 'string' && client.PANEL_ID.length > 0, String(client.PANEL_ID))

// ---------------------------------------------------------------- 收集槽位

const slots = []
const ctx = {
  slots: {
    inject(name, fn) {
      fn()
    },
    register(definition, component) {
      slots.push({ definition, component })
      return () => {}
    },
  },
  inject() {},
  effect() {
    return () => {}
  },
  get() {
    return undefined
  },
  locale: {
    register() {
      return () => {}
    },
  },
}
client.apply(ctx)

check('注册了 2 个槽位', slots.length === 2, String(slots.length))
const mainSlot = slots.find((slot) => slot.definition.name === 'main')
const panelSlot = slots.find((slot) => slot.definition.name === 'sidebar.panellist')
check('main 槽位的 key 与 panellist 的 id 一致',
  mainSlot?.definition.key === panelSlot?.definition.id,
  `${mainSlot?.definition.key} vs ${panelSlot?.definition.id}`)
check('panellist 提供 label 函数', typeof panelSlot?.definition.label === 'function')
check('label 解析为中文', panelSlot.definition.label() === '复盘沉淀', panelSlot.definition.label())

// ---------------------------------------------------------------- 渲染助手

/** 递归渲染，收集 { tag, className, text } 与所有字符串文本。 */
function render(element, out = { nodes: [], text: [] }) {
  if (element === null || element === undefined || element === false) return out
  if (typeof element === 'string' || typeof element === 'number') {
    out.text.push(String(element))
    return out
  }
  if (Array.isArray(element)) {
    element.forEach((child, index) => {
      const previous = renderPath
      renderPath = `${previous}/${index}`
      render(child, out)
      renderPath = previous
    })
    return out
  }
  if (typeof element !== 'object' || element.$$typeof !== 'element') return out

  const { type, props } = element
  if (type === Fragment) {
    render(props.children, out)
    return out
  }
  if (typeof type === 'function') {
    // 每个组件实例一份状态（键 = 组件函数 + 渲染路径），与 React 的按位置隔离一致
    const key = `${type.name || 'anon'}@${renderPath}`
    const previousStates = hooks.states
    const previousEffects = hooks.effects
    hooks.states = instanceStates.get(key) ?? []
    instanceStates.set(key, hooks.states)
    hooks.effects = []
    hooks.reset()

    const rendered = type({ ...props })

    pendingEffects.push(...hooks.effects)
    hooks.states = previousStates
    hooks.effects = previousEffects
    render(rendered, out)
    return out
  }
  // 宿主元素
  out.nodes.push({ tag: type, className: props.className ?? '', props })
  render(props.children, out)
  return out
}

/** 用 mock fetch 跑一次完整渲染（含 effect 执行与重渲染循环）。 */
async function renderWith(snapshotResponse) {
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    if (snapshotResponse instanceof Error) throw snapshotResponse
    return {
      ok: true,
      status: 200,
      json: async () => snapshotResponse,
    }
  }
  // 一次挂载 = 一份全新的组件实例状态
  instanceStates.clear()
  renderPath = 'root'
  hooks.states = []

  const t = (key, params) => {
    const dict = {
      'page.title': '运行复盘',
      'page.subtitle': '失败经验、固定流程与技能沉淀',
      'action.refresh': '刷新',
      'action.summary': '生成总结',
      'action.summaryModel': '用模型复盘',
      'action.promote': '沉淀为技能',
      'action.forget': '忘记',
      'action.confirmForget': '确认忘记？',
      'common.loading': '加载中…',
      'common.empty': '还没有数据',
      'totals.turns': '会话轮次',
      'totals.failures': '失败记录',
      'totals.distinct': '不同签名',
      'totals.flows': '固定流程',
      'totals.skills': '已沉淀技能',
      'totals.digest': '注入字符',
      'section.histogram': '失败分布',
      'section.histogramHint': '按类别统计命中次数；重复出现的类别才会被写进提示词。',
      'section.lessons': '高频坑',
      'section.lessonsHint': '命中次数达到阈值的失败，会在下一轮动手前注入提示词。',
      'section.recent': '最近踩过的坑',
      'section.recentHint': '尚未重复，只在这里可见，暂不注入提示词。',
      'section.flows': '固定流程',
      'section.flowsHint': '同一工具序列反复出现即视为固定流程；达到阈值可沉淀为技能。',
      'section.skills': '已沉淀技能',
      'section.skillsHint': '这些技能已进入模型技能目录，用 skill 工具加载。',
      'section.digest': '当前注入内容',
      'section.digestHint': '实际写进系统提示词的文本（受预算限制）。',
      'section.settings': '自动化设置',
      'section.settingsHint': '改完立即生效，不需要重启。带「已改」标记的是运行期覆盖，重置后回落到部署配置。',
      'settings.autoCapture': '自动记录失败',
      'settings.autoCaptureHint': '工具报错时归类、去重、脱敏后落盘。',
      'settings.autoDraft': '自动生成技能草稿',
      'settings.autoDraftHint': '流程达阈值时在 drafts/ 留一份。',
      'settings.autoPromote': '自动晋升为技能',
      'settings.autoPromoteHint': '流程达阈值时直接写进 skills/。',
      'settings.flowThreshold': '流程阈值',
      'settings.flowThresholdHint': '同一工具序列出现几次才算固定流程。',
      'settings.repeatThreshold': '高频坑阈值',
      'settings.repeatThresholdHint': '同一失败出现几次才注入提示词。',
      'settings.promptBudget': '提示词预算',
      'settings.promptBudgetHint': '注入系统提示词的字符上限。',
      'settings.summaryTopN': '总结条数',
      'settings.summaryTopNHint': '总结与注入里最多列几条。',
      'settings.maxAutoSkills': '技能数量上限',
      'settings.maxAutoSkillsHint': '自动沉淀的技能最多保留几个。',
      'settings.reset': '重置为部署配置',
      'settings.resetDone': '已重置为部署配置',
      'settings.saved': '设置已生效',
      'settings.overriddenNote': '当前有 {n} 项运行期覆盖',
      'settings.deployNote': '部署配置在 cordis.patch.yml，改它需要重启。',
      'badge.promoted': '已沉淀',
      'badge.draft': '草稿',
      'badge.times': '{n} 次',
      'flow.steps': '步骤：{steps}',
      'skill.when': '何时用：{text}',
      'empty.flows': '还没有重复出现的工作流。',
      'empty.skills': '还没有沉淀的技能。',
      'empty.lessons': '还没有重复出现的失败。',
      'empty.recent': '还没有失败记录。',
      'empty.digest': '当前没有注入内容。',
      'error.load': '读取复盘数据失败：{reason}',
      'error.action': '操作失败：{reason}',
      'ok.forgotten': '已清除该签名',
      'ok.promoted': '已沉淀为技能 {name}',
      'notice.modelFallback': '模型复盘不可用：{reason}',
    }
    let text = dict[key] ?? `<<MISSING:${key}>>`
    if (params) text = text.replace(/\{(\w+)\}/g, (m, name) => (params[name] === undefined ? m : String(params[name])))
    return text
  }

  // 首帧
  let out = render(makeElement(mainSlot.component, { t }))
  const firstFrame = out

  // 跑 effect → 等 microtask → 重渲染，最多 5 轮直到稳定。
  // 这是最小版「挂载循环」：真实 React 用调度器做同一件事。
  for (let round = 0; round < 5; round += 1) {
    const pending = pendingEffects.splice(0)
    if (pending.length === 0) break
    for (const effect of pending) {
      try {
        await effect()
      } catch {
        /* 组件 effect 内部的错误由它自己 catch，这里只防止测试骨架崩 */
      }
    }
    await Promise.resolve()
    await Promise.resolve()
    out = render(makeElement(mainSlot.component, { t }))
  }

  return { out, calls, firstFrame }
}

// ---------------------------------------------------------------- 场景 1：空数据

console.log('\n== 场景 1：空数据 ==')
{
  const { out, calls } = await renderWith({
    ok: true,
    root: 'C:/Users/WC/.dsh/dsh-retro',
    config: {},
    totals: { turns: 0, failures: 0, distinct: 0, flows: 0, skills: 0, digestChars: 0 },
    histogram: [],
    lessons: [],
    recent: [],
    flows: [],
    skills: [],
    digest: '',
  })
  check('发起了 snapshot 请求', calls.length >= 1 && calls[0].url === '/api/retro/snapshot', JSON.stringify([...new Set(calls.map((c) => c.url))]))
  check('渲染出页面容器', out.nodes.some((n) => n.className === 'retro-page'))
  check('标题出现', out.text.includes('运行复盘'))
  check('根目录出现', out.text.includes('C:/Users/WC/.dsh/dsh-retro'))
  check('空态文案出现（流程）', out.text.some((t) => t.includes('还没有重复出现的工作流')))
  check('空态文案出现（技能）', out.text.some((t) => t.includes('还没有沉淀的技能')))
  check('空态文案出现（注入）', out.text.some((t) => t.includes('当前没有注入内容')))
  check('没有裸露的缺键标记', !out.text.some((t) => t.includes('<<MISSING:')))
}

// ---------------------------------------------------------------- 场景 2：有数据

console.log('\n== 场景 2：有数据 ==')
{
  const { out } = await renderWith({
    ok: true,
    root: 'C:/root',
    config: {
      autoCapture: true,
      autoDraft: true,
      autoPromote: true,
      flowThreshold: 3,
      repeatThreshold: 2,
      promptBudget: 1200,
      mirrorToUserSkills: false,
      summaryTopN: 6,
      maxAutoSkills: 40,
    },
    overridden: ['autoPromote'],
    editable: ['autoCapture', 'autoDraft', 'autoPromote', 'flowThreshold', 'repeatThreshold', 'promptBudget', 'summaryTopN'],
    booleanKeys: ['autoCapture', 'autoDraft', 'autoPromote'],
    numberRanges: { flowThreshold: [2, 10], repeatThreshold: [1, 20], promptBudget: [0, 8000], summaryTopN: [1, 20] },
    totals: { turns: 12, failures: 7, distinct: 3, flows: 2, skills: 1, digestChars: 480 },
    histogram: [
      { class: 'sandbox-denied', classLabel: '权限/沙箱拒绝', hits: 5, signatures: 2 },
      { class: 'not-found', classLabel: '路径/对象不存在', hits: 2, signatures: 1 },
    ],
    lessons: [
      { signature: 'sandbox-denied|write|a1', classLabel: '权限/沙箱拒绝', tool: 'write', count: 4, lesson: '先确认路径在工作区内', message: 'sandbox: access denied' },
    ],
    recent: [
      { signature: 'network|curl|b2', classLabel: '网络/连接失败', tool: 'curl', count: 1, message: 'ECONNREFUSED 127.0.0.1:8080' },
    ],
    flows: [
      { signature: 'read>edit>pwsh', skeleton: 'edit>pwsh>read', title: '给项目加冒烟测试', count: 3, skillName: 'flow-add-smoke-test', promoted: true, steps: ['read', 'edit', 'pwsh'], lastTs: '2026-10-31T01:00:00.000Z' },
      { signature: 'read>grep', title: '定位实现位置', count: 2, skillName: 'flow-locate', promoted: false, steps: ['read', 'grep'], lastTs: '2026-10-31T00:30:00.000Z' },
    ],
    skills: [
      { name: 'flow-add-smoke-test', description: '读 → 改 → 验证 三步流程', whenToUse: '需要改动既有代码并验证时', path: 'C:/root/skills/flow-add-smoke-test.md' },
    ],
    digest: '## 历史复盘（dsh-retro 自动沉淀）\n\n已知高频坑：\n- 权限/沙箱拒绝／write（4 次）',
  })

  check('统计数字渲染正确', out.text.includes('12') && out.text.includes('7'))
  check('直方图显示类别标签', out.text.some((t) => t.includes('权限/沙箱拒绝 · 5')))
  check('直方图有进度条', out.nodes.some((n) => n.className === 'retro-bar-fill'))
  check('高频坑显示教训', out.text.some((t) => t.includes('先确认路径在工作区内')))
  check('高频坑有「忘记」按钮', out.text.includes('忘记'))
  check('近期坑显示原始错误', out.text.some((t) => t.includes('ECONNREFUSED')))
  check('流程标题出现', out.text.includes('给项目加冒烟测试'))
  // 面板展示骨架（聚合键）作为副标题，而不是拼完整步骤序列
  check('流程骨架渲染为副标题', out.text.includes('edit>pwsh>read'), out.text.filter((t) => t.includes('>')).join(' | '))
  check('不再渲染冗长的完整序列', !out.text.some((t) => t.includes('read → edit → pwsh')))
  check('已沉淀流程显示对应角标', out.text.includes('已沉淀'))
  check('草稿流程显示草稿角标', out.text.includes('草稿'))
  check('技能名出现', out.text.includes('flow-add-smoke-test'))
  check('技能 whenToUse 出现', out.text.some((t) => t.includes('何时用：需要改动既有代码并验证时')))
  check('注入内容原文出现', out.text.some((t) => t.includes('已知高频坑')))
  check('没有裸露的缺键标记', !out.text.some((t) => t.includes('<<MISSING:')))

  // 设置区
  check('设置区标题出现', out.text.includes('自动化设置'))
  check('自动晋升开关出现', out.text.some((t) => t === '自动晋升为技能'))
  check('三个开关都渲染（checkbox）', out.nodes.filter((n) => n.tag === 'input' && n.props?.type === 'checkbox').length === 3,
    String(out.nodes.filter((n) => n.tag === 'input' && n.props?.type === 'checkbox').length))
  check('五个数值项都渲染（number）', out.nodes.filter((n) => n.tag === 'input' && n.props?.type === 'number').length === 5,
    String(out.nodes.filter((n) => n.tag === 'input' && n.props?.type === 'number').length))
  check('数值输入带 min/max', out.nodes.filter((n) => n.props?.type === 'number').every((n) => typeof n.props.min === 'number' && typeof n.props.max === 'number'))
  check('已覆盖项显示「已改」标记', out.text.includes('已改'))
  check('阈值输入框回填当前值', out.nodes.some((n) => n.props?.type === 'number' && n.props?.value === '3'))
}

// ---------------------------------------------------------------- 场景 3：加载失败

console.log('\n== 场景 3：加载失败 ==')
{
  // 首帧（数据未到）：应显示加载中，而不是错误或白屏
  {
    globalThis.fetch = async () => {
      throw new Error('boom')
    }
    hooks.states = []
    instanceStates.clear()
    renderPath = 'root'
    pendingEffects.length = 0
    const firstFrame = render(makeElement(mainSlot.component, { t: (key) => key }))
    check('首帧渲染出页面容器（不白屏）', firstFrame.nodes.some((n) => n.className === 'retro-page'))
    check('首帧显示加载中', firstFrame.text.some((t) => t.includes('common.loading')))
  }

  // 请求失败且跑完 effect 后：应显示错误文案 + 保留标题 + 保留重试按钮
  const { out } = await renderWith(new Error('boom'))
  check('失败后仍渲染页面容器', out.nodes.some((n) => n.className === 'retro-page'))
  check('失败后显示错误段落', out.nodes.some((n) => n.className === 'retro-error'))
  check('失败后错误里带原因', out.text.some((t) => t.includes('boom')))
  check('失败后仍可点刷新', out.nodes.some((n) => n.props?.className === 'retro-btn' && n.props?.onClick))
}

// ---------------------------------------------------------------- 场景 4：脏数据韧性

console.log('\n== 场景 4：脏数据 ==')
{
  const { out } = await renderWith({
    ok: true,
    root: null,
    totals: null,
    histogram: null,
    lessons: [{ signature: 'x', classLabel: null, tool: null, count: null, lesson: null }],
    flows: [{ signature: 'a>b', title: null, count: null, steps: null, promoted: null }],
    skills: [{ name: 'k', description: null }],
    digest: null,
  })
  check('totals=null 不崩', out.nodes.some((n) => n.className === 'retro-page'))
  check('null 字段不产出 undefined 字样', !out.text.some((t) => t.includes('undefined')))
  check('null 字段不产出 null 字样', !out.text.some((t) => t === 'null'))
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
