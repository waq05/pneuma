/**
 * 「哪些条目出座位」的纯判定（ui 层）。
 *
 * 来源：`scripts/ui-transcript-render-test.mjs` 第 [7]⑨ 段（2026-11-08 报障：组头下面
 * 一片白，才轮到通知行）。空盒子不占高度，但过程区是 `gap: 3px` 的 flex 列，空行照样吃
 * 一条缝——一轮改五个文件 = 十条 changes/turnDiff 就叠出 27px 的空白。判据在行渲染
 * 之前（`row-shows.ts`），不是靠 CSS 藏。
 *
 * 原探针里「render.tsx 两处都判 rowShows」的接线钉不迁（渲染体文本，归组件渲染批）。
 *
 * @module dsc-ui-transcript/ui/row-shows.spec
 */
import { expect, test } from 'vitest'
import type { TranscriptEntry } from '@dsc/ui'
import { rowShows } from './row-shows.js'

/** 造一条条目（只喂 rowShows 用得着的字段）。 */
let seq = 0
const entry = (kind: TranscriptEntry['kind'], extra: object = {}): TranscriptEntry =>
  ({ kind, id: (seq += 1), ...extra }) as TranscriptEntry

test('改动明细（changes / turnDiff）不出座位', () => {
  expect(rowShows(entry('changes', { file: {} }))).toBe(false)
  expect(rowShows(entry('turnDiff', { files: [] }))).toBe(false)
})

test('正常收尾的 turn-end 不出座位，中断 / 跑挂的照出', () => {
  expect(rowShows(entry('turn-end', { reason: 'completed' }))).toBe(false)
  expect(rowShows(entry('turn-end', { reason: 'aborted' }))).toBe(true)
  expect(rowShows(entry('turn-end', { reason: 'failed' }))).toBe(true)
})

test('空白正文不出座位，真正文照出', () => {
  expect(rowShows(entry('text', { text: ' \n ' }))).toBe(false)
  expect(rowShows(entry('text', { text: '有字' }))).toBe(true)
})

test('用户消息 / 工具 / 思考 / 通知一律照出', () => {
  for (const kind of ['user', 'tool', 'thinking', 'system', 'model-retry'] as const) {
    expect(rowShows(entry(kind, { text: 'x' }))).toBe(true)
  }
})
