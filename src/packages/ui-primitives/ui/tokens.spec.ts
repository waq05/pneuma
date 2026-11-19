/**
 * token 数显示口径的 K/M 真值表（迁自 `scripts/ui-sidebar-footer-test.mjs` 第 [1] 段）。
 *
 * 报障背景：同一个 token 数在四个地方（侧栏页脚 / 状态栏 / 轮尾 / 轨迹页）显示成四种
 * 写法，用户以为是四个不同的数；合并成这一份共享函数后，量级口径只许有一个。
 *
 * 为什么是行为测试：`tokens.ts` 是纯函数，`formatTokens` 的真跑结果就是被测行为；
 * 真值表对「永不缩写」的假实现必须红——量级换算不再是装饰。第 [1] 段的
 * 「tokens 从共享出口」改成了公开面检查：基元包 barrel 交出来的就是这一份函数
 * （同一引用），页脚的共享引用不会静默 undefined。
 *
 * 不迁的部分（原探针第 [2]–[4] 段，见交付报告缺口清单）：
 *   - [2] 页脚契约（sessions/ui.tsx 的文案与接线、usage-today.ts 共享 hook 的取数口径）
 *     ——React 组件与 hook，归组件渲染批；
 *   - [3] 通道可用性钉——有公开数据面可判，落 `src/core/ui-methods.spec.ts`（unit 层）；
 *   - [4] 产物钉（lib/ui 插件 bundle 含今日总用量、不再含旧口径）——产物审计要
 *     `pnpm build:ui` 的 lib/ui/**，vitest 只解析 src（D32），探针保留。
 *
 * @module dsc-ui-primitives/ui/tokens.spec
 */
import { describe, expect, test } from 'vitest'
import * as primitives from '@dsc/ui-primitives'
import { formatTokens } from './tokens.js'

/** 全部档位必须命中：0 / 个位 / 千档 / 万档 / 百 K / M 档 / 千 M 档 / 非法值。 */
const TRUTH_TABLE: ReadonlyArray<readonly [number, string]> = [
  [0, '0'],
  [1, '1'],
  [999, '999'],
  [1000, '1K'],
  [1500, '1.5K'],
  [19428, '19.4K'],
  [46000, '46K'],
  [128000, '128K'],
  [1000000, '1M'],
  [2500000, '2.5M'],
  [12300000, '12.3M'],
  [987654321, '988M'],
  [Number.NaN, '0'],
  [Number.POSITIVE_INFINITY, '0'],
  [-5, '0'],
]

describe('K/M 量级真值表（共享 formatTokens）', () => {
  test('全部档位命中（0 / 个位 / 千档 / 万档 / 百K / M 档 / 千M / NaN / Infinity / 负数）', () => {
    const differ = TRUTH_TABLE.filter(([input, want]) => formatTokens(input) !== want)
    expect(differ.map(([input, want]) => `${String(input)} → ${formatTokens(input)}（应为 ${want}）`)).toEqual([])
  })

  test('真值表对「永不缩写」的假实现必须红（判据不空转）', () => {
    const neverAbbreviate = (value: number): string => String(Math.round(value))
    expect(neverAbbreviate(46000)).not.toBe('46K')
    expect(TRUTH_TABLE.every(([input, want]) => neverAbbreviate(input) === want)).toBe(false)
  })

  test('tokens 从共享出口（@dsc/ui-primitives 交出来的就是这一份函数）', () => {
    expect(primitives.formatTokens).toBe(formatTokens)
  })
})
