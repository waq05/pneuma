/**
 * 折叠存档的「清法」（迁自 `scripts/ui-edit-generation-test.mjs` 第 [5] 段）。
 *
 * 原探针的场景：`editAndResend` 重答一次后，新回答拿到的轮序号与原来相同，折叠存档键
 * （`会话:turn:轮` / `会话:r<轮>:…`）与旧内容一模一样——上一版的展开选择会被新回答
 * 原样继承。修法是重答这一拍清掉这一轮的存档。这里用真代码把清法演一遍：
 * 精确键清整轮不误伤 `turn:10`；前缀 `r1:` / `step:r1:` 靠冒号挡住位数、只扫本轮。
 *
 * 为什么与 `fold-state.spec.ts` 分文件：那边迁的是存档与默认态的判定
 * （`ui-fold-prefs-test`），这边迁的是重答清法（`ui-edit-generation-test` 的
 * 唯一可行为化段）——各自对应自己的探针来源。
 *
 * 没迁的（原探针第 [1]–[4] 段，见交付报告缺口清单）：`editAndResend` 函数体里
 * `clearFold` / `clearPrefixes` 的调用位置、前缀拼法、注释内容、失败分支——全是
 * `ui.tsx` 渲染闭包内的文本钉，接缝在渲染层，归组件渲染批。
 *
 * 存档是模块级状态：本文件统一用 `spec-clear:` 前缀的键，每段收尾清干净。
 *
 * @module dsc-ui-transcript/ui/fold-clear.spec
 */
import { afterEach, describe, expect, test } from 'vitest'
import { clearFold, clearFoldPrefix, readFold, turnFoldKey, writeFold } from './fold-state.js'

/** 本文件造过的全部键；每段收尾一把抹掉，不给别的 describe 留残留。 */
const SPEC_KEYS = [
  'spec-clear:turn:1',
  'spec-clear:turn:10',
  'spec-clear:r1:think:0',
  'spec-clear:r10:think:0',
  'spec-clear:step:r1:think:0',
  'spec-clear:step:r10:think:0',
]

afterEach(() => {
  clearFoldPrefix(['spec-clear:'])
})

describe('整轮存档：精确键清，不误伤 turn:10', () => {
  test('clear 之后整轮回兜底，第 10 轮的展开存档原样保留', () => {
    writeFold('spec-clear:turn:1', true)
    writeFold('spec-clear:turn:10', true)
    clearFold(turnFoldKey('spec-clear', 1))
    expect(readFold('spec-clear:turn:1', false)).toBe(false)
    expect(readFold('spec-clear:turn:10', false)).toBe(true)
  })

  test('反证：整轮照前缀清会把 turn:10 一起清掉——所以必须用精确键', () => {
    writeFold('spec-clear:turn:1', true)
    writeFold('spec-clear:turn:10', true)
    // `spec-clear:turn:1` 这个前缀把 turn:10 也匹配上（10 是以 1 开头的数字串）——
    // 两条一起没了，这就是整轮那一格不能走前缀清的原因。
    const removed = clearFoldPrefix(['spec-clear:turn:1'])
    expect(removed).toBe(2)
    expect(readFold('spec-clear:turn:10', false)).toBe(false)
  })
})

describe('行与阶段组：前缀只扫本轮（冒号挡住位数，r1: 不吃 r10:）', () => {
  test('第 1 轮的行与组存档被清，第 10 轮的两份都没被误伤', () => {
    for (const key of SPEC_KEYS) writeFold(key, true)
    const removed = clearFoldPrefix(['spec-clear:r1:', 'spec-clear:step:r1:'])
    expect(removed).toBe(2)
    expect(readFold('spec-clear:r1:think:0', false)).toBe(false)
    expect(readFold('spec-clear:step:r1:think:0', false)).toBe(false)
    expect(readFold('spec-clear:r10:think:0', false)).toBe(true)
    expect(readFold('spec-clear:step:r10:think:0', false)).toBe(true)
  })

  test('turnFoldKey 的键形没变：`会话:turn:轮`，会话缺席归空串', () => {
    expect(turnFoldKey('spec-clear', 3)).toBe('spec-clear:turn:3')
    expect(turnFoldKey(null, 3)).toBe(':turn:3')
  })
})
