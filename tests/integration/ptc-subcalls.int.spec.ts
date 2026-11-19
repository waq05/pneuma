/**
 * PTC（从脚本里调工具）的卡内调用收纳（迁自 `scripts/ui-step-group-live-test.mjs` 第 [8]
 * 段前半）。
 *
 * 「run_code 脚本里 sdk.grep() / sdk.bash() 的每次调用」不该各自成为顶层行：适配器在
 * `tool/call` 带 `parentCallId` 时把它收进父卡的 `subCalls`，`tool/result` 按子调用
 * callId 改父卡里那一格；父卡自己的状态照常结算，找不到父卡时退回一条普通工具行
 * （不吞调用），同一步的正文仍被标成过程正文。
 *
 * 落位：被测主体 `src/adapter/transcript.ts` 是宿主适配器，跨 adapter / contract /
 * ui-transcript 三层（组头计数那条已在 `ui-transcript/ui/process-groups.spec.ts`），
 * 按 D23 放 `tests/integration/`。不起内核：Transcript 是纯事件折叠器，import 的是
 * `src` 源码，不走 lib 混合平面，也就不需要 build。
 *
 * 组头按子调用类别计数、实时详情取正在跑的子调用这两条在
 * `src/packages/ui-transcript/ui/process-groups.spec.ts`（消费侧纯函数）。
 *
 * @module dsc/tests/integration/ptc-subcalls
 */
import { describe, expect, test } from 'vitest'
import { Transcript } from '@pneuma/runtime/adapter/transcript.js'

/** 按探针的事件序列造一份 transcript：一步 run_code 里夹两次子调用 + 一条孤儿调用。 */
const transcriptOf = (): Transcript => {
  const t = new Transcript()
  t.reduce({ type: 'user', text: '跑一下' })
  t.reduce({
    type: 'message',
    text: '先跑一段脚本：',
    reasoning: '想一下',
    toolCalls: [{ id: 'root', name: 'run_code', arguments: '{}' }],
  })
  t.reduce({ type: 'tool/call', callId: 'root', name: 'run_code', args: '{"code":"..."}' })
  t.reduce({ type: 'tool/call', callId: 'c1', name: 'grep', args: '{"pattern":"x"}', parentCallId: 'root' })
  t.reduce({ type: 'tool/call', callId: 'c2', name: 'bash', args: '{"command":"ls"}', parentCallId: 'root' })
  t.reduce({ type: 'tool/result', callId: 'c1', text: 'ok' })
  t.reduce({ type: 'tool/call', callId: 'orphan', name: 'read', args: '{"path":"a"}', parentCallId: 'nope' })
  t.reduce({ type: 'tool/result', callId: 'root', text: 'done' })
  return t
}

describe('PTC 子调用收进父卡', () => {
  const t = transcriptOf()
  const roots = t.entries.filter((item) => item.kind === 'tool')
  const root = roots.find((item) => item.kind === 'tool' && item.call.callId === 'root')

  test('子调用不各自成为顶层行（父卡之外只有那条父卡与孤儿）', () => {
    expect(roots.map((item) => (item.kind === 'tool' ? item.call.name : ''))).toEqual(['run_code', 'read'])
  })

  test('父卡里收着两次子调用', () => {
    expect(root?.kind === 'tool' && root.call.subCalls?.map((sub) => sub.name)).toEqual(['grep', 'bash'])
  })

  test('子调用的结果改的是父卡里那一格', () => {
    const first = root?.kind === 'tool' ? root.call.subCalls?.[0] : undefined
    expect(first?.status).toBe('done')
    expect(first?.resultText).toBe('ok')
  })

  test('父卡自己的状态照常结算', () => {
    expect(root?.kind === 'tool' && root.call.status).toBe('done')
  })

  test('父卡找不到时退回一条普通工具行（不吞调用）', () => {
    const orphan = roots.find((item) => item.kind === 'tool' && item.call.callId === 'orphan')
    expect(orphan).toBeDefined()
  })

  test('同一步的正文仍被标成过程正文', () => {
    expect(t.entries.some((item) => item.kind === 'text' && item.process === true)).toBe(true)
  })
})
