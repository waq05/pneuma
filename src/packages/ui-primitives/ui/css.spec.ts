/**
 * 读 CSS 颜色/值（`ui-primitives/ui/css.ts`）：隐藏探针、`#rrggbb` 归一、非法与带 alpha 的兜底。
 *
 * jsdom 的 `getComputedStyle` **不会**把 `var(--x)` 算成颜色（只把自定义属性原样交回），
 * 所以两条路分开测：
 *   - 探针路径用 `vi.stubGlobal('getComputedStyle', …)` 按探针的 `backgroundColor` 给固定颜色，
 *     验证的是「设 var → 读回 → 转 hex」这条链；
 *   - 解析路径直接喂 `toHexColor`，覆盖 `rgb()` / `color(srgb …)` / 越界 / alpha / 垃圾串。
 * 读不到 `document` 的分支用 `vi.stubGlobal('document', undefined)` 造。
 *
 * @module dsc-ui-primitives/ui/css.spec
 */
import { afterEach, describe, expect, test, vi } from 'vitest'
import { readCssColor, readCssSolidColor, readCssValue, toHexColor } from './css.js'

afterEach(() => {
  vi.unstubAllGlobals()
  for (const name of ['--dsc-test-size', '--dsc-test-blank']) {
    document.documentElement.style.removeProperty(name)
  }
})

describe('readCssValue', () => {
  test('读 documentElement 上的自定义属性；缺失与空白都回落', () => {
    document.documentElement.style.setProperty('--dsc-test-size', '12px')
    document.documentElement.style.setProperty('--dsc-test-blank', '   ')

    expect(readCssValue('--dsc-test-size', '9px')).toBe('12px')
    expect(readCssValue('--dsc-test-missing', '9px')).toBe('9px')
    expect(readCssValue('--dsc-test-blank', '9px')).toBe('9px')
  })

  test('没有 document：直接给回落值（不在模块顶层碰浏览器 API）', () => {
    vi.stubGlobal('document', undefined)
    expect(readCssValue('--dsc-test-size', '9px')).toBe('9px')
    expect(readCssColor('--dsc-test-size')).toBeNull()
    expect(readCssSolidColor('--dsc-test-size', '--dsc-base', '#abcdef')).toBe('#abcdef')
  })
})

describe('readCssColor：探针只建一次', () => {
  test('一个令牌算成 #rrggbb；未知令牌与带 alpha 的给 null；探针复用', () => {
    vi.stubGlobal('getComputedStyle', (element: Element) => {
      const background = (element as HTMLElement).style.backgroundColor
      const colors: Record<string, string> = {
        'var(--dsc-chrome-bar)': 'rgb(13, 13, 15)',
        'var(--dsc-alpha)': 'rgb(255, 0, 0, 0.5)',
      }
      return {
        backgroundColor: colors[background] ?? background,
        getPropertyValue: () => '',
      }
    })

    expect(readCssColor('--dsc-chrome-bar')).toBe('#0d0d0f')
    expect(readCssColor('--dsc-alpha')).toBeNull()
    expect(readCssColor('--dsc-missing')).toBeNull()

    // 探针挂在 documentElement 下，且多次读取复用同一个节点。
    const probes = document.querySelectorAll('html > div')
    expect(probes).toHaveLength(1)
    expect((probes[0] as HTMLElement).style.visibility).toBe('hidden')
    readCssColor('--dsc-chrome-bar')
    expect(document.querySelectorAll('html > div')).toHaveLength(1)
  })
})

describe('readCssSolidColor：半透明前景压到底色上', () => {
  function stubColors(): void {
    vi.stubGlobal('getComputedStyle', (element: Element) => {
      const background = (element as HTMLElement).style.backgroundColor
      const colors: Record<string, string> = {
        'var(--dsc-solid)': 'rgb(1, 2, 3)',
        'var(--dsc-white-half)': 'rgb(255, 255, 255, 0.5)',
        'var(--dsc-red-half)': 'rgb(255, 0, 0, 0.5)',
        'var(--dsc-base)': 'rgb(0, 0, 0)',
      }
      return {
        backgroundColor: colors[background] ?? background,
        getPropertyValue: () => '',
      }
    })
  }

  test('不透明前景直接给 hex；半透明前景与底色合成', () => {
    stubColors()
    expect(readCssSolidColor('--dsc-solid', '--dsc-base', '#000000')).toBe('#010203')
    // 白 50% 压在黑上 = 128 → #808080。
    expect(readCssSolidColor('--dsc-white-half', '--dsc-base', '#000000')).toBe('#808080')
  })

  test('底色读不出来用前景本身；前景也读不出来才用 fallback', () => {
    stubColors()
    // 前景带 alpha 但底色不可读：忽略 alpha，直接给前景的 rgb。
    expect(readCssSolidColor('--dsc-red-half', '--dsc-missing', '#000000')).toBe('#ff0000')
    expect(readCssSolidColor('--dsc-missing', '--dsc-base', '#abcdef')).toBe('#abcdef')
  })
})

describe('toHexColor：解析与兜底', () => {
  test('rgb() 与 color(srgb …) 都归一成 #rrggbb，分量夹取并四舍五入', () => {
    expect(toHexColor('rgb(13, 13, 15)')).toBe('#0d0d0f')
    expect(toHexColor('rgb(255 255 255 / 1)')).toBe('#ffffff')
    expect(toHexColor('color(srgb 0.051 0.051 0.059)')).toBe('#0d0d0f')
    expect(toHexColor('color(srgb 1 0 0)')).toBe('#ff0000')
    expect(toHexColor('rgb(300, -5, 12.6)')).toBe('#ff000d')
  })

  test('带 alpha、解析不了的写法、分量不够都给 null（不猜一个颜色）', () => {
    expect(toHexColor('rgb(13, 13, 15, 0.5)')).toBeNull()
    expect(toHexColor('color(srgb 0.051 0.051 0.059 / 0.94)')).toBeNull()
    expect(toHexColor('rgb(1, 2)')).toBeNull()
    expect(toHexColor('hsl(0 0% 0%)')).toBeNull()
    // `rgba(...)` 是旧写法；浏览器算出来的颜色早已统一成 `rgb(...)`。
    expect(toHexColor('rgba(1, 2, 3, 1)')).toBeNull()
    expect(toHexColor('rgb(not, a, color)')).toBeNull()
    expect(toHexColor('')).toBeNull()
  })
})
