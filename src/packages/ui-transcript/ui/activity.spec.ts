/**
 * 「这一轮现在在干什么」的推导（迁自 `scripts/ui-turn-status-test.mjs` 第 [1] 段）。
 *
 * 2026-11-08 改版：直播行一句话说清「此刻在干什么」；原来「有阶段组头就把直播行藏起来」
 * 的判据（`covered`）随禁令一起拆掉——dsh 是组头与直播行两行并存。
 *
 * 为什么是行为测试：`activity.ts` 是从 timing.ts 抽出来的纯推导（零依赖，只经 `@dsc/ui`
 * 的取词器拿一句文案），`liveActivity` 的真跑结果就是被测行为。
 *
 * 不迁的部分（原探针第 [2]–[5] 段，见交付报告缺口清单）：
 * 直播行 / 底部状态栏的渲染接线（foot.tsx、ui.tsx、statusbar 的取法文本）、样式
 * （.turn-status 分隔线与扫光、正文 480 保底、dockDragLimit）、契约与字典的负向钉
 * （turnStartedAt 已删——那两条死键由 ui-locale 的死键闸管）。全部归组件渲染批。
 *
 * @module dsc-ui-transcript/ui/activity.spec
 */
import { describe, expect, test } from 'vitest'
import type { TranscriptEntry } from '@dsc/ui'
import { liveActivity } from './activity.js'

/** 造一条条目：id 给负数 = 直播尾（还没定稿）。 */
let seq = 0
const entry = (kind: TranscriptEntry['kind'], extra: object = {}): TranscriptEntry =>
  ({ kind, id: (seq += 1), ...extra }) as TranscriptEntry
const live = (kind: TranscriptEntry['kind'], extra: object = {}): TranscriptEntry =>
  entry(kind, { ...extra, id: -(seq += 1) })

describe('liveActivity：一句话说清此刻在干什么', () => {
  test('工具在跑：文案只有一句「正在调用 bash」', () => {
    const running = [entry('user', { text: '看看', ts: 1 }), entry('tool', { call: { callId: 'c1', name: 'bash', argsText: '{}', status: 'running' } })]
    expect(liveActivity(running, 'working')?.text).toBe('正在调用 bash')
  })

  test('准备阶段说「正在准备 write」', () => {
    const preparing = [entry('tool', { call: { callId: 'c2', name: 'write', argsText: '{}', status: 'preparing' } })]
    expect(liveActivity(preparing, 'working')?.text).toBe('正在准备 write')
  })

  test('思考阶段一句话（直播尾的思考条）', () => {
    const thinking = [live('thinking', { text: '嗯' })]
    expect(liveActivity(thinking, 'thinking')?.text).toBe('正在分析请求')
  })

  test('空闲时没有直播行（返回 null）', () => {
    expect(liveActivity([], 'idle')).toBeNull()
  })

  test('等确认时说「等待你的确认」', () => {
    expect(liveActivity([], 'awaiting-approval')?.text).toBe('等待你的确认')
  })

  test('返回的是单行文本，不再是 stage/activity 两段，也不再有 covered 这一位', () => {
    const running = [entry('tool', { call: { callId: 'c3', name: 'bash', argsText: '{}', status: 'running' } })]
    const line = liveActivity(running, 'working')
    expect(line).not.toBeNull()
    expect(Object.keys(line ?? {})).toEqual(['text'])
  })
})
