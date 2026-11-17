/**
 * 折叠条展开存档的纯逻辑（ui 层）。
 *
 * 来源：`scripts/ui-fold-prefs-test.mjs` 第 [1]–[4] 段（2026-11 报障：设置页把「默认展开」
 * 一拨，已经画出来的行纹丝不动）。根因是消费点只在挂载时算一次初值，而存档与设置默认态
 * 在 readFold 里被压成同一个布尔值，分不出「用户手动调过」。`foldStateOf` 多带的 `manual`
 * 一位就是为这条修法服务的。
 *
 * 四组断言：
 * - 没存档时跟随 fallback、有存档时不动、存档里的 false 也算手动、undefined 键不炸；
 * - 用同一份 followFallback 逐拍模拟钩子的生命周期（挂载 → 设置变化 → 手动点 → 再变 → 重挂）。
 *
 * 为什么是行为测试：`fold-state.ts` 是纯模块（进程内 Map，零 React），真跑结果就是被测
 * 行为。原探针第 [5][6] 段钉消费点接线（factory / think-row 用 useFoldState、设置下发链路）
 * 与第 [7] 段的四档 policy 表不迁——前者归组件渲染批，后者已按导出对象断言迁进
 * `round-fold.spec.ts`。
 *
 * 存档是模块级状态：本文件的用例各用各的键，互不串扰。
 *
 * @module dsc-ui-transcript/ui/fold-state.spec
 */
import { describe, expect, test } from 'vitest'
import { clearFold, foldStateOf, followFallback, hasFold, readFold, turnFoldKey, writeFold } from './fold-state.js'

describe('没手动存档时跟随设置默认态', () => {
  const key = 'spec-fold:no-archive'

  test('没存过 = 读不到手动标记', () => {
    clearFold(key)
    expect(hasFold(key)).toBe(false)
  })

  test('fallback=false → 收起且 manual=false', () => {
    const off = foldStateOf(key, false)
    expect(off.open).toBe(false)
    expect(off.manual).toBe(false)
  })

  test('fallback 变 true → open 跟着变 true，仍不算手动', () => {
    const on = foldStateOf(key, true)
    expect(on.open).toBe(true)
    expect(on.manual).toBe(false)
  })

  test('readFold 与 foldStateOf 口径一致', () => {
    expect(readFold(key, true)).toBe(true)
    expect(readFold(key, false)).toBe(false)
  })

  test('followFallback：当前态跟着默认态翻，两个方向都认', () => {
    expect(followFallback(false, key, true)).toBe(true)
    expect(followFallback(true, key, false)).toBe(false)
  })
})

describe('有手动存档时不动', () => {
  test('存档 true 优先于 fallback，设置翻也不动', () => {
    const key = 'spec-fold:manual-open'
    writeFold(key, true)
    expect(hasFold(key)).toBe(true)
    expect(foldStateOf(key, false).manual).toBe(true)
    expect(foldStateOf(key, false).open).toBe(true)
    // 默认态翻到 false 也不动当前值（followFallback 保持 true）。
    expect(followFallback(true, key, false)).toBe(true)
    // 默认态翻到 true 也不动当前值（followFallback 保持 false）。
    expect(followFallback(false, key, true)).toBe(false)
  })

  test('存档 false 也算手动（不能被「没存过」的兜底 false 混淆）', () => {
    // 反向：用户手动收起，存档里就是 false。
    const closedKey = 'spec-fold:manual-closed'
    writeFold(closedKey, false)
    expect(hasFold(closedKey)).toBe(true)
    expect(foldStateOf(closedKey, true).manual).toBe(true)
    expect(foldStateOf(closedKey, true).open).toBe(false)
    expect(followFallback(false, closedKey, true)).toBe(false)
  })
})

describe('undefined 键（不存档的视图）不炸', () => {
  test('读状态与写入都不抛', () => {
    expect(() => foldStateOf(undefined, true)).not.toThrow()
    expect(() => writeFold(undefined, true)).not.toThrow()
  })

  test('manual 恒为 false，写入是空操作，跟随默认态', () => {
    const state = foldStateOf(undefined, true)
    expect(state.open).toBe(true)
    expect(state.manual).toBe(false)
    expect(hasFold(undefined)).toBe(false)
    expect(readFold(undefined, false)).toBe(false)
    expect(followFallback(true, undefined, false)).toBe(false)
  })
})

describe('钩子的生命周期（用同一份 followFallback 逐拍模拟）', () => {
  test('挂载收起 → 设置改展开跟着开 → 手动收 → 设置再改不动 → 重挂读回手动值', () => {
    const key = 'spec-fold:lifecycle'
    clearFold(key)
    // 拍 1：挂载，无存档，设置默认收起。
    let open = foldStateOf(key, false).open
    expect(open).toBe(false)
    // 拍 2：设置改成默认展开 → effect 跟随。
    open = followFallback(open, key, true)
    expect(open).toBe(true)
    // 拍 3：用户手动点收起 → 写存档并转手动。
    writeFold(key, false)
    open = false
    expect(hasFold(key)).toBe(true)
    // 拍 4：设置再改成默认展开 → 不动（这就是报障点：不能被设置翻回去）。
    open = followFallback(open, key, true)
    expect(open).toBe(false)
    // 拍 5：重挂读回手动值（收起）。
    expect(foldStateOf(key, true).open).toBe(false)
  })
})

describe('存档键', () => {
  test('整轮键带会话 id 与轮序号（会话 id 缺席归一成空串）', () => {
    expect(turnFoldKey('s1', 2)).toBe('s1:turn:2')
    expect(turnFoldKey(null, 2)).toBe(':turn:2')
  })
})
