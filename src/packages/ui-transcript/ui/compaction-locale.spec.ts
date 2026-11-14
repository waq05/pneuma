/**
 * 压缩标记的文案字典（ui 层）。
 *
 * 来源：`scripts/ui-compaction-row-test.mjs` 第 [4] 段（差距清单 S8 的第一块：历史被压缩
 * 的落点画进会话流）。两张卡（`.entry-compaction` 分隔行与气泡上方的小标）的次数与说明
 * 都取自本包字典的 `transcript.compaction.mark` / `transcript.compaction.tip` 两键。
 *
 * 为什么是数据断言而不是文本钉：locale JSON 是运行时读的数据（不是源码），断言它的键、
 * 占位符与译本形态是「走公开数据面」——键名写错会静默显示键名，占位符 `{count}` 丢失会
 * 显示原文占位，这些只能对着字典本身查。
 *
 * 原探针第 [1][2][3][5] 段（组件 JSX、render 接线、CSS、反向钉）不迁：组件与样式要真
 * 渲染才有行为接缝，归组件渲染批。
 *
 * @module dsc-ui-transcript/ui/compaction-locale.spec
 */
import { expect, test } from 'vitest'
import en from '../locale/ui.en.json'
import zh from '../locale/ui.zh.json'

/** 汉字（与 ui-locale-test 同一条范围）。 */
const CJK = /[\u4e00-\u9fff]/
const KEYS = ['transcript.compaction.mark', 'transcript.compaction.tip'] as const

test('zh 有压缩标记的两个键（非空字符串）', () => {
  for (const key of KEYS) {
    const value = zh[key as keyof typeof zh]
    expect(typeof value === 'string' && value !== '', `zh 有 ${key}`).toBe(true)
  }
})

test('en 有压缩标记的两个键（非空字符串，真译过）', () => {
  for (const key of KEYS) {
    const value = en[key as keyof typeof en]
    expect(typeof value === 'string' && value !== '', `en 有 ${key}`).toBe(true)
    expect(CJK.test(value ?? ''), `${key} 的英文里没有汉字`).toBe(false)
  }
})

test('两份字典键集一致（缺译 / 多键都不放过）', () => {
  expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
})

test('次数占位符两边都保留（mark 的 {count}），中文说清「压缩」与次数', () => {
  const markZh = zh['transcript.compaction.mark']
  const markEn = en['transcript.compaction.mark']
  expect(markZh).toContain('{count}')
  expect(markEn).toContain('{count}')
  expect(markZh).toContain('压缩')
})
