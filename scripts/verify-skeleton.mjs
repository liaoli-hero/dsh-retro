// scripts/verify-skeleton.mjs — 流程骨架聚合的回归
//
// 这个文件存在的理由是一次真实故障：
//   早期用「完整工具序列」当聚合键，结果真实会话每轮 8~29 步、顺序各异，
//   精确相等导致每条流程 count 恒为 1，flowThreshold=4 永远达不到，
//   **技能一个也长不出来**。插件看起来在正常工作（流程列表有内容），
//   但核心产出是空的 —— 属于最难察觉的那类失效。
//
// 本文件锁两件事：
//   ① 同类任务必须收敛到同一骨架（否则永远达不到阈值）
//   ② 不同类任务必须区分开（否则会生成毫无针对性的"万能技能"）
//
// 用法：node scripts/verify-skeleton.mjs

import { flowSignature, flowSkeleton } from '../lib/experience.js'

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

console.log('== 骨架基本语义 ==')
check('单工具不构成流程', flowSkeleton(['read', 'read', 'read']) === null)
check('两个工具才成流程', flowSkeleton(['read', 'edit']) === 'edit>read')
check('空输入返回 null', flowSkeleton([]) === null)
check('非数组返回 null', flowSkeleton(undefined) === null)

console.log('\n== 与顺序无关（这是能收敛的关键）==')
{
  const a = flowSkeleton(['read', 'edit', 'pwsh'])
  const b = flowSkeleton(['pwsh', 'read', 'edit'])
  const c = flowSkeleton(['edit', 'pwsh', 'read'])
  check('三种顺序同一骨架', a === b && b === c, `${a} / ${b} / ${c}`)
}

console.log('\n== 与重复次数无关 ==')
{
  const short = flowSkeleton(['read', 'edit', 'pwsh'])
  const long = flowSkeleton(['read', 'edit', 'pwsh', 'edit', 'pwsh', 'read', 'edit', 'pwsh'])
  check('改 1 次与改 3 次同骨架', short === long, `${short} vs ${long}`)
}

console.log('\n== 附着动作不参与骨架 ==')
{
  const plain = flowSkeleton(['read', 'edit', 'pwsh'])
  const withWrite = flowSkeleton(['read', 'edit', 'pwsh', 'write', 'present'])
  check('write / present 被排除', plain === withWrite, `${plain} vs ${withWrite}`)
  check('只有附着动作不构成流程', flowSkeleton(['write', 'present', 'write']) === null)
}

console.log('\n== 失败标记归到基础工具 ==')
{
  const clean = flowSkeleton(['read', 'edit', 'pwsh'])
  const withErr = flowSkeleton(['read', 'edit!err', 'pwsh', 'edit'])
  check('edit!err 与 edit 同骨架', clean === withErr, `${clean} vs ${withErr}`)
}

console.log('\n== 真实会话样本：同类任务必须收敛 ==')
{
  // 这些是实际抓到的四轮任务序列（长度 4~29 步，顺序各异）
  const realRuns = [
    ['pwsh', 'read', 'edit', 'pwsh'],
    ['pwsh', 'read', 'write', 'pwsh', 'edit', 'pwsh', 'read', 'present'],
    ['pwsh', 'read', 'write', 'pwsh', 'edit', 'pwsh', 'read', 'write', 'edit', 'pwsh', 'edit!err'],
    ['read', 'edit', 'pwsh', 'edit', 'pwsh', 'read', 'write', 'pwsh', 'write', 'pwsh', 'read', 'edit', 'pwsh'],
  ]
  const skeletons = new Set(realRuns.map((run) => flowSkeleton(run)))
  check('四轮真实任务收敛到 1 个骨架', skeletons.size === 1, [...skeletons].join(' | '))
  const converged = [...skeletons][0]
  check('骨架是工具集合（不含次数）', /^[a-z]+(>[a-z]+)+$/.test(converged), converged)

  // 关键：收敛后 count 才能达到阈值
  const count = realRuns.length
  check(`收敛后 count=${count} 可达到默认阈值 4`, count >= 4, String(count))
}

console.log('\n== 不同类任务必须区分 ==')
{
  const cases = {
    纯调研: ['read', 'grep', 'read', 'grep'],
    改造: ['read', 'edit', 'pwsh'],
    调研加改: ['read', 'grep', 'edit', 'pwsh'],
    执行: ['pwsh', 'node'],
  }
  const skeletons = Object.entries(cases).map(([name, run]) => [name, flowSkeleton(run)])
  const distinct = new Set(skeletons.map(([, s]) => s))
  check('四类工作产生 4 个不同骨架', distinct.size === 4, skeletons.map(([n, s]) => `${n}=${s}`).join(' | '))
}

console.log('\n== 完整序列仍然保留给人看 ==')
{
  const run = ['read', 'edit', 'pwsh', 'edit', 'pwsh']
  const signature = flowSignature(run)
  const skeleton = flowSkeleton(run)
  check('signature 保留完整顺序', signature === 'read>edit>pwsh>edit>pwsh', signature)
  check('skeleton 是聚合键', skeleton === 'edit>pwsh>read', skeleton)
  check('两者不相等（分工明确）', signature !== skeleton)
}

console.log('\n== 稳定性：同一输入反复计算结果一致 ==')
{
  const run = ['read', 'edit', 'pwsh', 'grep', 'edit']
  const first = flowSkeleton(run)
  const again = flowSkeleton(run.map((x) => x))
  check('同输入同结果', first === again, `${first} vs ${again}`)
  const shuffled = ['grep', 'pwsh', 'edit', 'read', 'edit']
  check('乱序同结果', flowSkeleton(shuffled) === first, `${flowSkeleton(shuffled)} vs ${first}`)
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
