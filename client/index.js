// client/index.mjs — dsh-retro 浏览器半侧
//
// 一个面板，两个槽位共用同一个 id：
//   · sidebar.panellist —— 侧栏「更多」区里的图标行（与「插件」「自动化任务」同级）
//   · main              —— 点开图标后主区域渲染的面板内容
// 两个 id 必须一致：宿主用 panellist 的 id 去 main 的 keyed 槽位找落地面，
// 找不到会抛错并保持当前选择（点了没反应）。
//
// 数据全部来自宿主路由 /api/retro/*（见 index.js ⑦.5）。面板不猜测宿主内部状态，
// 拉不到就显示错误而不是空白 —— 「点开是白屏」是最难排查的一种坏体验。
//
// 纯 JS + react/jsx-runtime 手写（不依赖 JSX 构建），与 dsh-soul 客户端同一写法：
// children 必须放 props.children，不能当第三参数传（第三参数是 key）。

window.__ModuleLoader__.load({
  id: 'dsh-retro',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const { jsx: h, jsxs: hs, Fragment } = require('react/jsx-runtime')
    const React = require('react')

    // 与 dsh-soul 相同的包装：把多余参数收集成 children
    const e = (type, props, ...children) => {
      const p = props || {}
      if (children.length === 0) return h(type, p)
      if (children.length === 1) return h(type, { ...p, children: children[0] })
      return hs(type, { ...p, children })
    }

    const NS = 'retro'
    const PANEL_ID = 'retro-review'

    // -------------------------------------------------------------------------
    // 样式（data-plugin-css 注入，避免与宿主样式冲突）
    // -------------------------------------------------------------------------

    const css = [
      '.retro-page{box-sizing:border-box;height:100%;overflow:auto;padding:24px 28px 40px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.6}',
      '.retro-head{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:4px}',
      '.retro-title{margin:0;font-size:18px;font-weight:600}',
      '.retro-root{font-size:11px;color:var(--dsw-alias-label-tertiary);font-family:var(--dsw-font-mono,monospace);word-break:break-all}',
      '.retro-toolbar{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0 18px}',
      '.retro-btn{box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 12px;border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-settings-card-fill);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer;transition:background-color .15s ease,color .15s ease}',
      '.retro-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.retro-btn:disabled{cursor:default;opacity:.45}',
      '.retro-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.retro-btn-primary{border-color:transparent;background:var(--dsw-alias-brand-primary);color:#fff}',
      '.retro-btn-primary:hover:not(:disabled){background:var(--dsw-alias-brand-primary-hover,var(--dsw-alias-brand-primary))}',
      '.retro-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin-bottom:20px}',
      '.retro-card{border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-settings-card-fill);padding:10px 12px}',
      '.retro-card-num{font-size:20px;font-weight:600;line-height:1.2}',
      '.retro-card-label{font-size:11px;color:var(--dsw-alias-label-tertiary);margin-top:2px}',
      '.retro-section{margin-bottom:24px}',
      '.retro-section h3{margin:0 0 8px;font-size:13px;font-weight:600}',
      '.retro-hint{font-size:11px;color:var(--dsw-alias-label-tertiary);margin:-2px 0 10px}',
      '.retro-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}',
      '.retro-row{display:flex;align-items:flex-start;gap:10px;padding:8px 10px;border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-settings-card-fill)}',
      '.retro-row-main{min-width:0;flex:1}',
      '.retro-row-title{font-size:12px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.retro-row-sub{font-size:11px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.retro-badge{flex:0 0 auto;font-size:10px;padding:1px 6px;border-radius:99px;border:.5px solid var(--dsw-alias-settings-card-stroke);color:var(--dsw-alias-label-secondary)}',
      '.retro-badge-on{border-color:transparent;background:var(--dsw-alias-brand-primary);color:#fff}',
      '.retro-mono{font-family:var(--dsw-font-mono,monospace);font-size:11px}',
      '.retro-empty{padding:28px;text-align:center;color:var(--dsw-alias-label-tertiary);border:.5px dashed var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-md)}',
      '.retro-error{padding:12px 14px;border-radius:var(--dsw-radius-md);background:rgba(220,38,38,.08);color:#dc2626;font-size:12px}',
      '.retro-digest{margin:0;padding:12px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-settings-card-fill);border:.5px solid var(--dsw-alias-settings-card-stroke);white-space:pre-wrap;font-family:var(--dsw-font-mono,monospace);font-size:11px;line-height:1.55;max-height:280px;overflow:auto}',
      '.retro-icon{display:block}',
      '.retro-bar{height:6px;border-radius:99px;background:var(--dsw-alias-interactive-bg-hover);overflow:hidden;margin-top:4px}',
      '.retro-bar-fill{height:100%;border-radius:99px;background:var(--dsw-alias-brand-primary)}',
      '.retro-toggle-row{display:flex;align-items:flex-start;gap:10px;padding:8px 10px;border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-settings-card-fill);cursor:pointer}',
      '.retro-toggle-row:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.retro-toggle-input{margin:2px 0 0;flex:0 0 auto;width:14px;height:14px;cursor:pointer;accent-color:var(--dsw-alias-brand-primary)}',
      '.retro-number-input{flex:0 0 auto;width:72px;height:24px;padding:0 6px;border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-settings-card-fill);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;font-family:var(--dsw-font-mono,monospace)}',
      '.retro-toggle-text{min-width:0;flex:1;display:flex;flex-direction:column;gap:1px}',
      '.retro-toggle-label{display:flex;align-items:center;gap:6px;font-size:12px;font-weight:500}',
      '.retro-toggle-hint{font-size:11px;color:var(--dsw-alias-label-tertiary);line-height:1.45}',
      '.retro-settings-grid{display:flex;flex-direction:column;gap:6px}',
      '@media (prefers-reduced-motion:reduce){.retro-btn{transition:none}}',
    ].join('')

    const tagId = 'dsh-retro/styles.css'
    let styleTagMissing = false
    if (typeof document !== 'undefined') {
      try {
        styleTagMissing = document.querySelector(`style[data-plugin-css="${tagId}"]`) === null
      } catch {
        styleTagMissing = true
      }
    }
    if (styleTagMissing) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-retro'
      tag.dataset.pluginCss = tagId
      tag.textContent = css
      document.head.appendChild(tag)
    }

    // -------------------------------------------------------------------------
    // 文案词典（键集中英完全对齐；渲染器按槽位 locale 注入 t）
    // -------------------------------------------------------------------------

    const zh = {
      'panel.label': '复盘沉淀',
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
      'common.failed': '加载失败',
      'common.cancel': '取消',
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
      'settings.autoDraftHint': '流程达阈值时在 drafts/ 留一份，模型看不到，等你人工晋升。',
      'settings.autoPromote': '自动晋升为技能',
      'settings.autoPromoteHint': '流程达阈值时直接写进 skills/，模型立即可用。这是全自动模式。',
      'settings.flowThreshold': '流程阈值',
      'settings.flowThresholdHint': '同一工具序列出现几次才算固定流程（2–10）。调高可减少误判。',
      'settings.repeatThreshold': '高频坑阈值',
      'settings.repeatThresholdHint': '同一失败出现几次才注入提示词（1–20）。',
      'settings.promptBudget': '提示词预算',
      'settings.promptBudgetHint': '注入系统提示词的字符上限（0–8000）；0 = 完全不注入。',
      'settings.summaryTopN': '总结条数',
      'settings.summaryTopNHint': '总结与注入里最多列几条（1–20）。',
      'settings.maxAutoSkills': '技能数量上限',
      'settings.maxAutoSkillsHint': '自动沉淀的技能最多保留几个（0 = 不限）。超出后按「最久没被再次命中」淘汰；手动晋升的不受影响。',
      'settings.reset': '重置为部署配置',
      'settings.resetDone': '已重置为部署配置',
      'settings.saved': '设置已生效',
      'settings.overriddenNote': '当前有 {n} 项运行期覆盖',
      'settings.deployNote': '部署配置在 cordis.patch.yml，改它需要重启；这里的改动会覆盖它。',
      'badge.promoted': '已沉淀',
      'badge.draft': '草稿',
      'badge.times': '{n} 次',
      'flow.steps': '步骤：{steps}',
      'skill.when': '何时用：{text}',
      'empty.flows': '还没有重复出现的工作流。多做几轮同类任务再看。',
      'empty.skills': '还没有沉淀的技能。在固定流程一栏点「沉淀为技能」。',
      'empty.lessons': '还没有重复出现的失败。',
      'empty.recent': '还没有失败记录。',
      'empty.digest': '当前没有注入内容（预算为 0，或数据还不够）。',
      'error.load': '读取复盘数据失败：{reason}',
      'error.action': '操作失败：{reason}',
      'error.notReady': '插件尚未初始化：{reason}',
      'ok.forgotten': '已清除该签名',
      'ok.promoted': '已沉淀为技能 {name}',
      'notice.modelFallback': '模型复盘不可用，已生成规则式总结：{reason}',
    }

    const en = {
      'panel.label': 'Retrospective',
      'page.title': 'Run retrospective',
      'page.subtitle': 'Failures, recurring flows, and distilled skills',
      'action.refresh': 'Refresh',
      'action.summary': 'Generate summary',
      'action.summaryModel': 'Review with model',
      'action.promote': 'Distill to skill',
      'action.forget': 'Forget',
      'action.confirmForget': 'Confirm?',
      'common.loading': 'Loading…',
      'common.empty': 'Nothing yet',
      'common.failed': 'Failed to load',
      'common.cancel': 'Cancel',
      'totals.turns': 'Turns',
      'totals.failures': 'Failures',
      'totals.distinct': 'Distinct signatures',
      'totals.flows': 'Recurring flows',
      'totals.skills': 'Distilled skills',
      'totals.digest': 'Injected chars',
      'section.histogram': 'Failure distribution',
      'section.histogramHint': 'Hits per class; only repeated classes reach the prompt.',
      'section.lessons': 'Frequent pitfalls',
      'section.lessonsHint': 'Failures at or above the threshold are injected before the next action.',
      'section.recent': 'Recent pitfalls',
      'section.recentHint': 'Seen once so far; listed here only, not injected yet.',
      'section.flows': 'Recurring flows',
      'section.flowsHint': 'The same tool sequence repeatedly seen; distill once it hits the threshold.',
      'section.skills': 'Distilled skills',
      'section.skillsHint': 'These are already in the skill catalog; load them with the skill tool.',
      'section.digest': 'Currently injected',
      'section.digestHint': 'The exact text written into the system prompt, within budget.',
      'section.settings': 'Automation settings',
      'section.settingsHint': 'Changes apply immediately — no restart. Rows marked “overridden” are runtime overrides; Reset falls back to the deployed config.',
      'settings.autoCapture': 'Record failures automatically',
      'settings.autoCaptureHint': 'Classify, dedupe, and redact tool errors to disk.',
      'settings.autoDraft': 'Draft skills automatically',
      'settings.autoDraftHint': 'Write a draft under drafts/ once a flow hits the threshold; the model cannot see it until promoted.',
      'settings.autoPromote': 'Promote to skills automatically',
      'settings.autoPromoteHint': 'Write straight into skills/ once a flow hits the threshold. This is full auto.',
      'settings.flowThreshold': 'Flow threshold',
      'settings.flowThresholdHint': 'How many times the same tool sequence must recur (2–10). Raise it to reduce false positives.',
      'settings.repeatThreshold': 'Pitfall threshold',
      'settings.repeatThresholdHint': 'How often a failure must recur before it reaches the prompt (1–20).',
      'settings.promptBudget': 'Prompt budget',
      'settings.promptBudgetHint': 'Character cap for the injected prompt (0–8000); 0 disables injection.',
      'settings.summaryTopN': 'Summary rows',
      'settings.summaryTopNHint': 'How many rows the summary and digest show (1–20).',
      'settings.maxAutoSkills': 'Skill cap',
      'settings.maxAutoSkillsHint': 'How many auto-distilled skills to keep (0 = unlimited). Oldest-unused ones are pruned first; manual promotions are never pruned.',
      'settings.reset': 'Reset to deployed config',
      'settings.resetDone': 'Reset to the deployed config',
      'settings.saved': 'Settings applied',
      'settings.overriddenNote': '{n} runtime override(s) active',
      'settings.deployNote': 'The deployed config lives in cordis.patch.yml and needs a restart; changes here override it.',
      'badge.promoted': 'distilled',
      'badge.draft': 'draft',
      'badge.times': '{n}×',
      'flow.steps': 'Steps: {steps}',
      'skill.when': 'When to use: {text}',
      'empty.flows': 'No recurring flow yet. Come back after a few similar tasks.',
      'empty.skills': 'No distilled skill yet. Use “Distill to skill” on a recurring flow.',
      'empty.lessons': 'No repeated failure yet.',
      'empty.recent': 'No failure recorded yet.',
      'empty.digest': 'Nothing injected (budget is 0, or not enough data).',
      'error.load': 'Failed to read retrospective data: {reason}',
      'error.action': 'Action failed: {reason}',
      'error.notReady': 'Plugin not initialized yet: {reason}',
      'ok.forgotten': 'Signature cleared',
      'ok.promoted': 'Distilled into skill {name}',
      'notice.modelFallback': 'Model review unavailable; generated a rule-based summary instead: {reason}',
    }

    /** 兜底翻译：locale 服务不可用时用中文，绝不因缺 t 而崩。 */
    const FALLBACK_DICT = zh
    function makeFallbackT() {
      return (key, params) => {
        const template = FALLBACK_DICT[key] ?? key
        if (!params) return template
        return template.replace(/\{(\w+)\}/g, (match, name) => (params[name] === undefined ? match : String(params[name])))
      }
    }

    // -------------------------------------------------------------------------
    // 数据获取
    // -------------------------------------------------------------------------

    /** 统一请求：非 2xx 与 ok:false 都转成可读错误。 */
    async function callApi(path, init) {
      let response
      try {
        response = await fetch(path, init)
      } catch (error) {
        throw new Error(String(error?.message ?? error))
      }
      let payload
      try {
        payload = await response.json()
      } catch {
        throw new Error(`HTTP ${response.status}`)
      }
      if (!response.ok || payload?.ok === false) {
        throw new Error(String(payload?.error ?? `HTTP ${response.status}`))
      }
      return payload
    }

    function loadSnapshot() {
      return callApi('/api/retro/snapshot', { method: 'GET' })
    }

    function promoteFlow(signature) {
      return callApi('/api/retro/promote', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ signature }),
      })
    }

    function forgetSignature(signature) {
      return callApi('/api/retro/forget', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ signature }),
      })
    }

    function generateSummary(useModel) {
      return callApi('/api/retro/summary', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ useModel }),
      })
    }

    /** 改运行期设置：立即生效，不需要重启。 */
    function saveSettings(settings) {
      return callApi('/api/retro/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ settings }),
      })
    }

    /** 清空运行期设置，回落到部署配置。 */
    function resetSettings() {
      return callApi('/api/retro/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'reset' }),
      })
    }

    // -------------------------------------------------------------------------
    // 小组件
    // -------------------------------------------------------------------------

    function StatCard({ label, value }) {
      return e(
        'div',
        { className: 'retro-card' },
        e('div', { className: 'retro-card-num' }, String(value)),
        e('div', { className: 'retro-card-label' }, label),
      )
    }

    function Empty({ text }) {
      return e('div', { className: 'retro-empty' }, text)
    }

    /** 单个开关行：标签 + 说明 + 原生 checkbox（宿主样式已覆盖 accent-color）。 */
    function ToggleRow({ label, hint, checked, overridden, disabled, onChange }) {
      return e(
        'label',
        { className: 'retro-toggle-row' },
        e('input', {
          type: 'checkbox',
          className: 'retro-toggle-input',
          checked: checked === true,
          disabled: disabled === true,
          onChange: (event) => onChange(event.target.checked),
        }),
        e(
          'span',
          { className: 'retro-toggle-text' },
          e(
            'span',
            { className: 'retro-toggle-label' },
            label,
            overridden ? e('span', { className: 'retro-badge retro-badge-on' }, '已改') : null,
          ),
          hint ? e('span', { className: 'retro-toggle-hint' }, hint) : null,
        ),
      )
    }

    /** 数值行：标签 + 说明 + 数字输入；失焦或回车时提交。 */
    function NumberRow({ label, hint, value, min, max, overridden, disabled, onCommit }) {
      const [draft, setDraft] = React.useState(String(value ?? ''))
      React.useEffect(() => {
        setDraft(String(value ?? ''))
      }, [value])
      const commit = () => {
        const num = Number(draft)
        if (Number.isFinite(num) && num >= min && num <= max) onCommit(num)
        else setDraft(String(value ?? ''))
      }
      return e(
        'label',
        { className: 'retro-toggle-row' },
        e('input', {
          type: 'number',
          className: 'retro-number-input',
          value: draft,
          min,
          max,
          disabled: disabled === true,
          onChange: (event) => setDraft(event.target.value),
          onBlur: commit,
          onKeyDown: (event) => {
            if (event.key === 'Enter') commit()
          },
        }),
        e(
          'span',
          { className: 'retro-toggle-text' },
          e(
            'span',
            { className: 'retro-toggle-label' },
            label,
            overridden ? e('span', { className: 'retro-badge retro-badge-on' }, '已改') : null,
          ),
          hint ? e('span', { className: 'retro-toggle-hint' }, hint) : null,
        ),
      )
    }

    function Section({ title, hint, children, actions }) {
      return e(
        'section',
        { className: 'retro-section' },
        e(
          'div',
          { style: { display: 'flex', alignItems: 'baseline', gap: '12px', flexWrap: 'wrap' } },
          e('h3', null, title),
          actions ?? null,
        ),
        hint ? e('p', { className: 'retro-hint' }, hint) : null,
        children,
      )
    }

    /** 复盘面板主体。 */
    function RetroPage(props) {
      const t = typeof props.t === 'function' ? props.t : makeFallbackT()
      const [state, setState] = React.useState({ status: 'loading', data: null, error: null })
      const [busy, setBusy] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      const [confirming, setConfirming] = React.useState(null)
      const alive = React.useRef(true)

      React.useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
        }
      }, [])

      const refresh = React.useCallback(async () => {
        setState((prev) => ({ ...prev, status: prev.data === null ? 'loading' : 'ready', error: null }))
        try {
          const data = await loadSnapshot()
          if (!alive.current) return
          setState({ status: 'ready', data, error: null })
        } catch (error) {
          if (!alive.current) return
          setState((prev) => ({ ...prev, status: 'error', error: String(error?.message ?? error) }))
        }
      }, [])

      React.useEffect(() => {
        void refresh()
      }, [refresh])

      // 面板打开时随宿主数据变化自动刷新一次：复盘数据是本地文件，没有推送通道，
      // 轮询间隔刻意放宽（15s）—— 它不属于实时视图，没必要和界面抢资源。
      React.useEffect(() => {
        const timer = setInterval(() => {
          if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
          void refresh()
        }, 15000)
        return () => clearInterval(timer)
      }, [refresh])

      const run = async (key, fn) => {
        setBusy(key)
        setNotice(null)
        try {
          const result = await fn()
          if (alive.current) setNotice({ kind: 'ok', text: result })
          await refresh()
        } catch (error) {
          if (alive.current) setNotice({ kind: 'error', text: t('error.action', { reason: String(error?.message ?? error) }) })
        } finally {
          if (alive.current) setBusy(null)
        }
      }

      const data = state.data

      /** 改一项设置：立刻 POST，成功后重拉快照让界面跟上。 */
      const onSetting = (key, value) =>
        run(`setting:${key}`, async () => {
          await saveSettings({ [key]: value })
          return t('settings.saved')
        })

      const onResetSettings = () =>
        run('settings-reset', async () => {
          await resetSettings()
          return t('settings.resetDone')
        })

      const onSummary = () =>
        run('summary', async () => {
          const result = await generateSummary(false)
          if (typeof result.modelError === 'string' && result.modelError !== '') {
            return t('notice.modelFallback', { reason: result.modelError })
          }
          return t('action.summary') + ' ✓'
        })

      const onSummaryModel = () =>
        run('summary-model', async () => {
          const result = await generateSummary(true)
          if (typeof result.modelError === 'string' && result.modelError !== '') {
            return t('notice.modelFallback', { reason: result.modelError })
          }
          return t('action.summaryModel') + ' ✓'
        })

      const onPromote = (signature) =>
        run(`promote:${signature}`, async () => {
          const result = await promoteFlow(signature)
          return t('ok.promoted', { name: result.skillName ?? '' })
        })

      const onForget = (signature) => {
        if (confirming !== signature) {
          setConfirming(signature)
          return
        }
        setConfirming(null)
        void run(`forget:${signature}`, async () => {
          await forgetSignature(signature)
          return t('ok.forgotten')
        })
      }

      const header = e(
        'div',
        { className: 'retro-head' },
        e('h2', { className: 'retro-title' }, t('page.title')),
        data?.root ? e('span', { className: 'retro-root' }, data.root) : null,
      )

      const toolbar = e(
        'div',
        { className: 'retro-toolbar' },
        e(
          'button',
          { className: 'retro-btn', onClick: () => void refresh(), disabled: busy !== null },
          t('action.refresh'),
        ),
        e(
          'button',
          { className: 'retro-btn', onClick: () => void onSummary(), disabled: busy !== null },
          busy === 'summary' ? t('common.loading') : t('action.summary'),
        ),
        e(
          'button',
          { className: 'retro-btn retro-btn-primary', onClick: () => void onSummaryModel(), disabled: busy !== null },
          busy === 'summary-model' ? t('common.loading') : t('action.summaryModel'),
        ),
      )

      if (state.status === 'loading' && data === null) {
        return e('div', { className: 'retro-page' }, header, e(Empty, { text: t('common.loading') }))
      }

      if (state.status === 'error' && data === null) {
        return e(
          'div',
          { className: 'retro-page' },
          header,
          e('div', { className: 'retro-error' }, t('error.load', { reason: state.error ?? '' })),
          toolbar,
        )
      }

      // 宿主路由在插件装配完成前就可能被面板问到：这时快照是 ready:false。
      // 显示明确原因而不是当成「没数据」—— 后者会让人以为复盘记录丢了。
      if (data && data.ready === false) {
        return e(
          'div',
          { className: 'retro-page' },
          header,
          e('div', { className: 'retro-error' }, t('error.notReady', { reason: data.reason ?? '' })),
          toolbar,
        )
      }

      const totals = data?.totals ?? {}
      const config = data?.config ?? {}
      const overridden = Array.isArray(data?.overridden) ? data.overridden : []
      const histogram = Array.isArray(data?.histogram) ? data.histogram : []
      const lessons = Array.isArray(data?.lessons) ? data.lessons : []
      const recent = Array.isArray(data?.recent) ? data.recent : []
      const flows = Array.isArray(data?.flows) ? data.flows : []
      const skills = Array.isArray(data?.skills) ? data.skills : []
      const maxHits = histogram.reduce((max, row) => Math.max(max, row.hits ?? 0), 0)

      return e(
        'div',
        { className: 'retro-page' },
        header,
        e('p', { className: 'retro-hint' }, t('page.subtitle')),
        toolbar,
        notice
          ? e(
              'div',
              { className: notice.kind === 'error' ? 'retro-error' : 'retro-hint', style: { marginBottom: '14px' } },
              notice.text,
            )
          : null,
        e(
          'div',
          { className: 'retro-cards' },
          e(StatCard, { label: t('totals.turns'), value: totals.turns ?? 0 }),
          e(StatCard, { label: t('totals.failures'), value: totals.failures ?? 0 }),
          e(StatCard, { label: t('totals.distinct'), value: totals.distinct ?? 0 }),
          e(StatCard, { label: t('totals.flows'), value: totals.flows ?? 0 }),
          e(StatCard, { label: t('totals.skills'), value: totals.skills ?? 0 }),
          e(StatCard, { label: t('totals.digest'), value: totals.digestChars ?? 0 }),
        ),

        e(
          Section,
          { title: t('section.histogram'), hint: t('section.histogramHint') },
          histogram.length === 0
            ? e(Empty, { text: t('empty.recent') })
            : e(
                'ul',
                { className: 'retro-list' },
                ...histogram.map((row) =>
                  e(
                    'li',
                    { className: 'retro-row', key: row.class },
                    e(
                      'div',
                      { className: 'retro-row-main' },
                      e(
                        'div',
                        { className: 'retro-row-title' },
                        `${row.classLabel ?? row.class} · ${row.hits}`,
                        ` (${
                          row.signatures
                        })`,
                      ),
                      e(
                        'div',
                        { className: 'retro-bar' },
                        e('div', {
                          className: 'retro-bar-fill',
                          style: { width: `${maxHits > 0 ? Math.round(((row.hits ?? 0) / maxHits) * 100) : 0}%` },
                        }),
                      ),
                    ),
                  ),
                ),
              ),
        ),

        e(
          Section,
          { title: t('section.lessons'), hint: t('section.lessonsHint') },
          lessons.length === 0
            ? e(Empty, { text: t('empty.lessons') })
            : e(
                'ul',
                { className: 'retro-list' },
                ...lessons.map((entry) =>
                  e(
                    'li',
                    { className: 'retro-row', key: entry.signature },
                    e(
                      'div',
                      { className: 'retro-row-main' },
                      e('div', { className: 'retro-row-title' }, `${entry.classLabel} · ${entry.tool}`),
                      e('div', { className: 'retro-row-sub' }, entry.lesson ?? ''),
                    ),
                    e('span', { className: 'retro-badge' }, t('badge.times', { n: entry.count ?? 0 })),
                    e(
                      'button',
                      {
                        className: 'retro-btn',
                        onClick: () => onForget(entry.signature),
                        disabled: busy !== null,
                        title: entry.signature,
                      },
                      confirming === entry.signature ? t('action.confirmForget') : t('action.forget'),
                    ),
                  ),
                ),
              ),
        ),

        recent.length === 0
          ? null
          : e(
              Section,
              { title: t('section.recent'), hint: t('section.recentHint') },
              e(
                'ul',
                { className: 'retro-list' },
                ...recent.map((entry) =>
                  e(
                    'li',
                    { className: 'retro-row', key: entry.signature },
                    e(
                      'div',
                      { className: 'retro-row-main' },
                      e('div', { className: 'retro-row-title' }, `${entry.classLabel} · ${entry.tool}`),
                      e('div', { className: 'retro-row-sub retro-mono' }, entry.message ?? ''),
                    ),
                  ),
                ),
              ),
            ),

        e(
          Section,
          { title: t('section.flows'), hint: t('section.flowsHint') },
          flows.length === 0
            ? e(Empty, { text: t('empty.flows') })
            : e(
                'ul',
                { className: 'retro-list' },
                ...flows.map((flow) => {
                  // 骨架 = 聚合键（同类的稳定标识），完整序列只作副标题参考
                  const skeleton = flow.skeleton ?? flow.signature ?? ''
                  return e(
                    'li',
                    { className: 'retro-row', key: skeleton },
                    e(
                      'div',
                      { className: 'retro-row-main' },
                      e('div', { className: 'retro-row-title' }, flow.title ?? skeleton),
                      e('div', { className: 'retro-row-sub retro-mono' }, skeleton),
                    ),
                    e(
                      'span',
                      { className: flow.promoted ? 'retro-badge retro-badge-on' : 'retro-badge' },
                      flow.promoted ? t('badge.promoted') : t('badge.draft'),
                    ),
                    e('span', { className: 'retro-badge' }, t('badge.times', { n: flow.count ?? 0 })),
                    e(
                      'button',
                      {
                        className: 'retro-btn',
                        onClick: () => void onPromote(skeleton),
                        disabled: busy !== null,
                      },
                      busy === `promote:${skeleton}` ? t('common.loading') : t('action.promote'),
                    ),
                  )
                }),
              ),
        ),

        e(
          Section,
          { title: t('section.skills'), hint: t('section.skillsHint') },
          skills.length === 0
            ? e(Empty, { text: t('empty.skills') })
            : e(
                'ul',
                { className: 'retro-list' },
                ...skills.map((skill) =>
                  e(
                    'li',
                    { className: 'retro-row', key: skill.name },
                    e(
                      'div',
                      { className: 'retro-row-main' },
                      e('div', { className: 'retro-row-title retro-mono' }, skill.name),
                      e('div', { className: 'retro-row-sub' }, skill.description ?? ''),
                      skill.whenToUse ? e('div', { className: 'retro-row-sub' }, t('skill.when', { text: skill.whenToUse })) : null,
                    ),
                  ),
                ),
              ),
        ),

        e(
          Section,
          { title: t('section.digest'), hint: t('section.digestHint') },
          data?.digest ? e('pre', { className: 'retro-digest' }, data.digest) : e(Empty, { text: t('empty.digest') }),
        ),

        e(
          Section,
          {
            title: t('section.settings'),
            hint: t('section.settingsHint'),
            actions: e(
              'button',
              {
                className: 'retro-btn',
                onClick: () => void onResetSettings(),
                disabled: busy !== null || overridden.length === 0,
              },
              t('settings.reset'),
            ),
          },
          e('p', { className: 'retro-hint' }, t('settings.deployNote')),
          e(
            'div',
            { className: 'retro-settings-grid' },
            e(ToggleRow, {
              label: t('settings.autoCapture'),
              hint: t('settings.autoCaptureHint'),
              checked: config.autoCapture,
              overridden: overridden.includes('autoCapture'),
              disabled: busy !== null,
              onChange: (next) => void onSetting('autoCapture', next),
            }),
            e(ToggleRow, {
              label: t('settings.autoDraft'),
              hint: t('settings.autoDraftHint'),
              checked: config.autoDraft,
              overridden: overridden.includes('autoDraft'),
              disabled: busy !== null,
              onChange: (next) => void onSetting('autoDraft', next),
            }),
            e(ToggleRow, {
              label: t('settings.autoPromote'),
              hint: t('settings.autoPromoteHint'),
              checked: config.autoPromote,
              overridden: overridden.includes('autoPromote'),
              disabled: busy !== null,
              onChange: (next) => void onSetting('autoPromote', next),
            }),
            e(NumberRow, {
              label: t('settings.flowThreshold'),
              hint: t('settings.flowThresholdHint'),
              value: config.flowThreshold,
              min: 2,
              max: 10,
              overridden: overridden.includes('flowThreshold'),
              disabled: busy !== null,
              onCommit: (next) => void onSetting('flowThreshold', next),
            }),
            e(NumberRow, {
              label: t('settings.repeatThreshold'),
              hint: t('settings.repeatThresholdHint'),
              value: config.repeatThreshold,
              min: 1,
              max: 20,
              overridden: overridden.includes('repeatThreshold'),
              disabled: busy !== null,
              onCommit: (next) => void onSetting('repeatThreshold', next),
            }),
            e(NumberRow, {
              label: t('settings.promptBudget'),
              hint: t('settings.promptBudgetHint'),
              value: config.promptBudget,
              min: 0,
              max: 8000,
              overridden: overridden.includes('promptBudget'),
              disabled: busy !== null,
              onCommit: (next) => void onSetting('promptBudget', next),
            }),
            e(NumberRow, {
              label: t('settings.summaryTopN'),
              hint: t('settings.summaryTopNHint'),
              value: config.summaryTopN,
              min: 1,
              max: 20,
              overridden: overridden.includes('summaryTopN'),
              disabled: busy !== null,
              onCommit: (next) => void onSetting('summaryTopN', next),
            }),
            e(NumberRow, {
              label: t('settings.maxAutoSkills'),
              hint: t('settings.maxAutoSkillsHint'),
              value: config.maxAutoSkills,
              min: 0,
              max: 500,
              overridden: overridden.includes('maxAutoSkills'),
              disabled: busy !== null,
              onCommit: (next) => void onSetting('maxAutoSkills', next),
            }),
          ),
          overridden.length > 0
            ? e('p', { className: 'retro-hint', style: { marginTop: '8px' } }, t('settings.overriddenNote', { n: overridden.length }))
            : null,
        ),
      )
    }

    // -------------------------------------------------------------------------
    // 侧栏图标（复用同一套线条风格：圆圈 + 回旋箭头 = 「回顾」）
    // -------------------------------------------------------------------------

    function RetroPanelIcon({ size }) {
      const edge = typeof size === 'number' && size > 0 ? size : 16
      return e(
        'svg',
        {
          className: 'retro-icon',
          width: edge,
          height: edge,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        e('path', { d: 'M2.6 8a5.4 5.4 0 1 0 1.9-4.1' }),
        e('path', { d: 'M2.2 2.4v3h3' }),
        e('path', { d: 'M8 5.4V8l1.9 1.2' }),
      )
    }

    // -------------------------------------------------------------------------
    // 装配
    // -------------------------------------------------------------------------

    const inject = ['slots']

    function apply(ctx) {
      // 词典与导航标签：locale 服务**可选**。写进静态 inject 会让缺 locale 的
      // 组合（headless/精简 web）整块不激活 —— 面板连图标都不出现。
      ctx.inject(['locale'], (localeCtx) => {
        localeCtx.effect(() => localeCtx.locale.register(NS, { zh, en }), 'dsh-retro: dictionaries')
      })

      const navT = (key) => {
        try {
          const locale = ctx.get?.('locale')
          if (locale && typeof locale.bind === 'function') {
            const text = locale.bind(NS)(key)
            if (typeof text === 'string' && text !== '' && text !== key) return text
          }
        } catch {
          /* 回落 */
        }
        return FALLBACK_DICT[key] ?? key
      }

      // 主面板：key 必须与下面的 panellist id 完全一致，否则点击会「没有反应」
      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
        locale: NS,
      }, RetroPage))

      // 侧栏图标行
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 30,
        locale: NS,
        label: () => navT('panel.label'),
      }, RetroPanelIcon))
    }

    exports.apply = apply
    exports.inject = inject
    exports.NS = NS
    exports.PANEL_ID = PANEL_ID
    return module.exports
  },
})
