/**
 * 转录折叠的两处「按 callId / 名字缝回去」（迁自 `scripts/batch3-test.mjs` 的转录段）。
 *
 * 这两条性质都属于「同一份事实不该长两张卡」：
 *   1. 队友卡片按**名字**原位刷新——不然队友每报一次进度就多一张卡，一次任务收尾时
 *      屏幕上躺着十几张同名卡，轮数还各说各的；
 *   2. 文件改动按 **callId** 缝回工具卡（`call.change`），同时保留一条独立的 `changes`
 *      条目——工具卡只拿得到自己那条 entry，「这一刀改了什么」必须挂在它身上。
 *
 * ## 与 `transcript-usage.int.spec.ts` 的分工
 *
 * 那份钉的是「用量记账」（usage / changes 独立条目的形状）；这里钉的是**引用关系**：
 * 卡与卡之间靠什么键对上。`transcript-usage.int.spec.ts:275` 只断言 `changes` 条目
 * 存在，`call.change` 那条缝没有断言——本文件补的正是它。
 *
 * @module dsc/adapter/transcript-seams.int.spec
 */
import { expect, test } from 'vitest'
import { Transcript } from './transcript.js'

test('subagent 事件同名原位更新：id 稳定、不叠卡', () => {
  const transcript = new Transcript()
  transcript.reduce({
    type: 'subagent',
    row: { name: 'writer-1', role: 'writer', task: '写文档', state: 'working', rounds: 1, toolCalls: 2 },
  })
  transcript.reduce({
    type: 'subagent',
    row: { name: 'writer-1', role: 'writer', task: '写文档', state: 'working', rounds: 2, toolCalls: 3, tokens: 500 },
  })
  transcript.reduce({
    type: 'subagent',
    row: { name: 'writer-2', role: 'writer', task: '另一件', state: 'working', rounds: 0, toolCalls: 0 },
  })

  const cards = transcript.entries.filter((entry) => entry.kind === 'subagent')
  // 同名两次只留一张卡；换名字才是第二张。
  expect(cards).toHaveLength(2)
  const first = cards.find((entry) => entry.sub.name === 'writer-1')
  // id 是 React key：换了它，卡片会整张重建，折叠态与动画都跟着丢。
  expect(first?.id).toBe(1)
  // 数字取最新那一拍，不是第一次那一拍。
  expect(first?.sub.rounds).toBe(2)
  expect(first?.sub.tokens).toBe(500)
})

test('tool/changes 按 callId 缝回工具卡（call.change），且仍留独立条目', () => {
  const transcript = new Transcript()
  transcript.reduce({ type: 'tool/call', callId: 'c1', name: 'edit', args: '{"path":"a.ts","old":"x","new":"y"}' })
  transcript.reduce({ type: 'tool/result', callId: 'c1', text: '已编辑 a.ts' })
  const change = { path: '/w/a.ts', added: 1, removed: 1, hunks: [], status: 'modified' as const }
  transcript.reduce({ type: 'tool/changes', callId: 'c1', change })

  const tool = transcript.entries.find((entry) => entry.kind === 'tool')
  expect(tool?.kind === 'tool' ? tool.call.change?.path : undefined).toBe('/w/a.ts')
  // 独立条目照旧：轮尾那张改动卡读的是它，不能因为缝过一次就省掉。
  expect(transcript.entries.filter((entry) => entry.kind === 'changes')).toHaveLength(1)
})

test('重放历史时同样缝回：fileChanges 旁路 → call.change', () => {
  const transcript = new Transcript()
  // 一次调用可能改多个文件（PTC 的一段脚本改好几个），所以 fileChanges 的值是数组。
  const fileChanges = new Map([
    ['c2', [{ path: '/w/b.ts', added: 2, removed: 0, hunks: [], status: 'added' as const }]],
  ])
  transcript.replayHistory(
    [
      {
        role: 'assistant' as const,
        content: '',
        tool_calls: [
          { id: 'c2', type: 'function' as const, function: { name: 'write', arguments: '{"path":"b.ts","content":"a\\nb"}' } },
        ],
        ts: 1,
      },
      { role: 'tool' as const, content: '已写入 b.ts', tool_call_id: 'c2', ts: 2 },
    ],
    undefined,
    fileChanges,
  )
  const tool = transcript.entries.find((entry) => entry.kind === 'tool')
  // 重开旧会话时这一刀必须也缝回去：不然昨晚的工具卡点开是空的。
  expect(tool?.kind === 'tool' ? tool.call.change?.path : undefined).toBe('/w/b.ts')
})
