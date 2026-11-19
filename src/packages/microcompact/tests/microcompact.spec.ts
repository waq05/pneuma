/**
 * @pneuma/microcompact 的包级测试：钉 6 条不变量。
 * 为什么只钉这些：这个包只改请求体、不动会话日志，清谁不清谁是纯函数，钉住它才能保证旧结果被清而新结果与输入不被误伤。
 *
 * 迁移说明：原文件从 `lib/packages/microcompact/*.js` 取模块，现在直接 import 源码入口与 `microcompact.ts`。
 *
 * @module @pneuma/microcompact/tests
 */
import type { ChatMessage } from '@pneuma/runtime/core/llm.js'
import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { microcompactPlugin } from '../index.js'
import {
  advanceMicrocompactPlan,
  applyMicrocompactPlan,
  AUTO_APPENDED_NOTICE,
  CLEARED_TOOL_RESULT_PREFIX,
  DEFAULT_ADVANCE_CHARS,
  DEFAULT_KEEP_RECENT_TOOL_RESULTS,
  DEFAULT_MIN_SAVE_TOKENS,
  isSyntheticUserMessage,
  microcompact,
  planMicrocompact,
  roundKeyOf,
} from '../microcompact.js'

/** 按相对本文件的路径读文本。 */
const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

/** 消息正文的文本视图（这条用例里只放字符串正文）。 */
const textOf = (message: ChatMessage | undefined): string =>
  message !== undefined && typeof message.content === 'string' ? message.content : ''

// 装配行：id 或 name 写歪了，这个包就永远关不掉、也永远认不对，所以逐字比对。
test('cordis.patch.yml 的装配行认的是 @pneuma/microcompact', () => {
  const patch = read('../cordis.patch.yml')
  expect(patch).toMatch(/^\s*-\s*id: microcompact\s*$/m)
  expect(patch).toContain("name: '@pneuma/microcompact'")
})

// 包形态：ESM + 两个导出入口 + 装配指向本目录的 cordis.patch.yml。
test('package.json 是 ESM 功能包，装配指向 cordis.patch.yml', () => {
  const pkg = JSON.parse(read('../package.json')) as {
    name: string
    type: string
    exports: Record<string, { default?: string }>
    pneuma: { bundle: { patch: string }; library?: boolean }
  }
  expect(pkg.name).toBe('@pneuma/microcompact')
  expect(pkg.type).toBe('module')
  expect(pkg.exports['.']?.default).toBeTruthy()
  expect(pkg.exports['./package.json']).toBeTruthy()
  expect(pkg.pneuma.bundle.patch).toBe('./cordis.patch.yml')
  expect(pkg.pneuma.library).not.toBe(true)
})

// 入口真能加载：直接 import 源码入口并检查插件对象的三件事。
test('入口能加载，插件名与 apply 对得上', () => {
  expect(typeof microcompactPlugin).toBe('object')
  expect(typeof microcompactPlugin.name).toBe('string')
  // 插件名 = 包名去掉 @pneuma/ 前缀 = 装配行的 id；三者不一致说明装配时认错了包。
  expect(microcompactPlugin.name).toBe('microcompact')
  expect(typeof microcompactPlugin.apply).toBe('function')
})

// 文档面：这两段是给模型和给维护者的固定入口，删掉就没人知道边界在哪。
test('README 的 Model Experience 与 Known Limitations 两段都在', () => {
  const readme = read('../README.md')
  expect(readme).toContain('## Model Experience')
  expect(readme).toContain('## Known Limitations')
})

test('只清旧的工具结果，最近几条原样留着，输入不被就地改', () => {
  const long = 'x'.repeat(4000)
  const messages: ChatMessage[] = [
    { role: 'user', content: 'hi' },
    { role: 'tool', tool_call_id: 'c1', content: long },
    { role: 'tool', tool_call_id: 'c2', content: long },
  ]
  const out = microcompact(messages, { keepRecent: 1 })
  // 旧的该被换成新对象
  expect(out[1]).not.toBe(messages[1])
  expect(textOf(out[1]).startsWith(CLEARED_TOOL_RESULT_PREFIX)).toBe(true)
  // 最近一条要原样保留
  expect(out[2]).toBe(messages[2])
  // 输入数组不能被就地改
  expect(textOf(messages[1])).toBe(long)
})

test('清理计划按 callId 给出占位符，缺省阈值是常量', () => {
  const messages: ChatMessage[] = [{ role: 'tool', tool_call_id: 'c9', content: 'y'.repeat(4000) }]
  const plan = planMicrocompact(messages, { keepRecent: 0 })
  expect([...plan.keys()]).toEqual(['c9'])
  expect(DEFAULT_KEEP_RECENT_TOOL_RESULTS).toBe(5)
  expect(DEFAULT_MIN_SAVE_TOKENS).toBe(256)
  expect(DEFAULT_ADVANCE_CHARS).toBe(8192)
})

/** 一份 n 条工具往返的历史（每条结果 4000 字符，单条能省约 3990 字符）。 */
function historyOf(count: number): ChatMessage[] {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: '开跑' },
  ]
  for (let index = 1; index <= count; index += 1) {
    messages.push({
      role: 'assistant',
      content: '',
      tool_calls: [{ id: `b${String(index)}`, type: 'function', function: { name: 'bash', arguments: '{}' } }],
    })
    messages.push({ role: 'tool', tool_call_id: `b${String(index)}`, content: 'x'.repeat(4000) })
  }
  return messages
}

/** 一份消息里被清掉的工具结果条数。 */
const clearedCount = (list: readonly ChatMessage[]): number =>
  list.filter((message) => typeof message.content === 'string' && message.content.startsWith(CLEARED_TOOL_RESULT_PREFIX)).length

test('budget 推进：6 轮里只攒够 8192 字符的那一轮推进一次，其余轮沿用旧计划', () => {
  // 每次滑出 1 条：轮 1/2/3 累计分别 0、1、2 条（约 7980 字符，差 212 没到 8192）；
  // 轮 4 累计 3 条（约 1.2 万字符）推进一次；轮 5、6 各新增 1、2 条，仍不够，不再推进。
  let active: ReadonlyMap<string, string> = new Map()
  const advancedAt: number[] = []
  const applied: number[] = []
  for (let round = 1; round <= 6; round += 1) {
    const messages = historyOf(round)
    const candidate = planMicrocompact(messages, { keepRecent: 1 })
    const step = advanceMicrocompactPlan(messages, active, candidate, { minFreePercent: 25 })
    if (step.advanced) advancedAt.push(round)
    active = step.plan
    applied.push(clearedCount(applyMicrocompactPlan(messages, active)))
  }
  expect(advancedAt).toEqual([4])
  expect(applied).toEqual([0, 0, 0, 3, 3, 3])
  expect(active.size).toBe(3)
})

test('连续两轮不推进时，投影输出的旧前缀逐字节相同', () => {
  // 先在第 4 轮推进一次，再取第 5、6 轮（都不推进）比较：前 5 轮那一段必须一个字节不差。
  const history4 = historyOf(4)
  const step4 = advanceMicrocompactPlan(history4, new Map(), planMicrocompact(history4, { keepRecent: 1 }), { minFreePercent: 25 })
  expect(step4.advanced).toBe(true)
  const history5 = historyOf(5)
  const step5 = advanceMicrocompactPlan(history5, step4.plan, planMicrocompact(history5, { keepRecent: 1 }), { minFreePercent: 25 })
  expect(step5.advanced).toBe(false)
  const history6 = historyOf(6)
  const step6 = advanceMicrocompactPlan(history6, step5.plan, planMicrocompact(history6, { keepRecent: 1 }), { minFreePercent: 25 })
  expect(step6.advanced).toBe(false)
  // 不推进时直接沿用同一份计划（引用都没换）：清理点没动。
  expect(step5.plan).toBe(step4.plan)
  expect(step6.plan).toBe(step4.plan)
  const out5 = applyMicrocompactPlan(history5, step5.plan)
  const out6 = applyMicrocompactPlan(history6, step6.plan)
  expect(JSON.stringify(out6.slice(0, history5.length))).toBe(JSON.stringify(out5))
})

test('清理点只前进不后退：历史被压缩、candidate 变少时已清理的条目仍换占位符', () => {
  // 先在第 4 轮推进，active 里记下 b1..b3。
  const history4 = historyOf(4)
  const advanced = advanceMicrocompactPlan(history4, new Map(), planMicrocompact(history4, { keepRecent: 1 }), { minFreePercent: 25 })
  expect(advanced.plan.size).toBe(3)
  // 压缩后只剩 b3、b4 两条结果（都在保住窗口里），candidate 为空：
  // 若按 candidate 应用，b3 会从占位符变回原文——前缀倒退；正确做法是继续应用 active。
  const compressed = [
    history4[0]!,
    history4[1]!,
    ...history4.slice(6, 8), // b3 的 assistant + tool
    ...history4.slice(8, 10), // b4 的 assistant + tool
  ]
  expect(planMicrocompact(compressed, {}).size).toBe(0)
  const step = advanceMicrocompactPlan(compressed, advanced.plan, planMicrocompact(compressed, {}), { minFreePercent: 25 })
  expect(step.advanced).toBe(false)
  const out = applyMicrocompactPlan(compressed, step.plan)
  const b3 = out.find((message) => message.tool_call_id === 'b3')
  expect(typeof b3?.content).toBe('string')
  expect(String(b3?.content).startsWith(CLEARED_TOOL_RESULT_PREFIX)).toBe(true)
})

test('末尾带「不是用户发言」声明的 user 消息算合成，且只认末尾', () => {
  // 这句文案必须与 P0 三个包的 TAIL_NOTE 逐字一致，改文案要两边一起改。
  const literal = '（本条是程序自动附上的，不是用户发言）'
  expect(AUTO_APPENDED_NOTICE).toBe(literal)
  expect(isSyntheticUserMessage({ role: 'user', content: `有 3 个待办\n${literal}` } as ChatMessage)).toBe(true)
  const synthetic = { role: 'user', content: `有 3 个待办\n${AUTO_APPENDED_NOTICE}` } as ChatMessage
  expect(isSyntheticUserMessage(synthetic)).toBe(true)
  expect(roundKeyOf([{ role: 'user', content: '开跑' }, synthetic])).toBe(1)
  // 只认「末尾」：这句话后面还有正文就不算，避免把用户真说的话吞掉。
  expect(isSyntheticUserMessage({ role: 'user', content: `${literal}\n后面还有正文` } as ChatMessage)).toBe(false)
  // 老判据一条不动。
  expect(isSyntheticUserMessage({ role: 'user', content: '（提醒：任务清单有未完成项，做完一步就把状态改掉）' } as ChatMessage)).toBe(true)
  expect(isSyntheticUserMessage({ role: 'user', content: '<teammate-report id="s">干完了</teammate-report>' } as ChatMessage)).toBe(true)
  expect(isSyntheticUserMessage({ role: 'assistant', content: literal } as ChatMessage)).toBe(false)
  expect(isSyntheticUserMessage({ role: 'user', content: '继续' } as ChatMessage)).toBe(false)
})
