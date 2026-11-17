/**
 * 老内核替身 `findLast` 的行为（迁自 `scripts/ui-legacy-compat-test.mjs` 第 [1] 段有接缝的部分）。
 *
 * 原探针这一段钉三件事：界面源码里不许出现禁用的「太新」API（全仓扫描闸）、
 * 替身模块导出了 `findLast`、正文区改用替身。第一、三件是纯源码文本钉（手册 §2 必删项，
 * 全仓扫描闸留在 `check:ui` 里跑——见交付报告缺口清单）；第二件换成**真行为判定**：
 * 替身的返回值语义（从尾往前找、找不到 undefined、下标照传）与类型谓词重载。
 *
 * 类型谓词那条是编译期验证：`found.ok` 这行只有 `S extends T` 的收窄成立才编得过
 * （`pnpm run typecheck:spec` 是它的运行场）。
 *
 * @module dsc-ui-primitives/ui/compat.spec
 */
import { describe, expect, test } from 'vitest'
import { findLast } from './compat.js'

describe('findLast 替身（Chromium 97 之前没有 Array.prototype.findLast）', () => {
  test('从尾往前找，返回最后一个命中的（不是第一个）', () => {
    const hits = [1, 2, 3, 4]
    expect(findLast(hits, (item) => item % 2 === 1)).toBe(3)
  })

  test('找不到给 undefined（不抛、不返回别的假值）', () => {
    expect(findLast([1, 2, 3], (item) => item > 9)).toBeUndefined()
    expect(findLast([], (item) => item > 0)).toBeUndefined()
  })

  test('下标照传（谓词里用得到序号）', () => {
    const seen: Array<[number, number]> = []
    findLast(['a', 'b', 'c'], (item, index) => {
      seen.push([index, item.length])
      return false
    })
    expect(seen).toEqual([
      [2, 1],
      [1, 1],
      [0, 1],
    ])
  })

  test('类型谓词重载：命中项收窄成 S（这条是编译期验证，运行期钉语义）', () => {
    type Row = { id: number; ok?: boolean }
    const rows: Row[] = [
      { id: 1, ok: true },
      { id: 2 },
      { id: 3, ok: true },
    ]
    const found = findLast(rows, (row): row is Row & { ok: true } => row.ok === true)
    // 收窄成立：found.ok 直接可读，不需要断言。运行期钉的是「最后那个 ok 的」。
    expect(found?.id).toBe(3)
    expect(found?.ok).toBe(true)
  })
})
