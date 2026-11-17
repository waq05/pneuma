/**
 * 老内核调色板兜底的闸门（迁自 `scripts/ui-color-fallback-test.mjs` 第 [1]–[5] 段）。
 *
 * 令牌体系几乎全部由 `color-mix()` 算出，手机上的老 WebView 不认这个函数——解析期整条
 * 声明被丢掉，界面变透明。兜底那份 CSS 由 `ui-shell/scripts/build-color-fallback.mjs`
 * 按 tokens.css 的公式算出来，这条闸门钉的是：**算出来必须与入库的那份逐字节一致**
 * （改了 tokens.css 忘了重跑 → 红），以及混色算法本身（已知值对表 + 预乘）。
 *
 * 为什么落在 `tests/`（unit）：生成器在 `ui-shell/scripts/`，vitest 的 project include
 * 不收 ui-shell；生成器是纯函数模块（有 `isMain` 守卫，import 无副作用），用动态 import
 * 装载，tsc 不解析 `.mjs` 用期望错误压掉。入库的两份 CSS（tokens.css 与
 * legacy-color-fallback.css）都在 src 侧，`readFileSync` 直接读。
 *
 * 没迁的（原探针第 [6]、[7] 段，见交付报告缺口清单）：入口 import 次序与 `lib/ui/assets`
 * 产物审计（构建层）、设置磁贴 / 原生弹层 / tokens.css 的 color-scheme（渲染与桌面侧
 * 文本钉）。第 [7] 段里唯一有运行期接缝的「壳归一化认 claude」已迁
 * `src/packages/ui-runtime/ui/appearance.spec.ts`。
 *
 * @module dsc/tests/color-fallback
 */
import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

/** `ui-shell/scripts/build-color-fallback.mjs` 的导出面（无类型的 .mjs，这里只描述用到的那部分）。 */
interface ColorFallbackGen {
  TOKENS_PATH: string
  OUT_PATH: string
  buildFallbackCss: (tokensCss: string) => { css: string; counts: [number, number, number] }
  parseRules: (css: string) => unknown
  collectTokens: (rules: unknown, attrs: Record<string, string>, third: boolean) => Map<string, string>
  fallbackDecls: (tokens: Map<string, string>) => Array<{ name: string; value: string }>
  pickDependent: (tokens: Map<string, string>) => Set<string>
  mixColors: (a: MixColor | null, aPercent: number | null, b: MixColor | null, bPercent: number | null) => MixColor
  formatColor: (color: MixColor) => string
  parseColor: (value: string) => MixColor | null
  evaluate: (expr: string, env: { rawTokens: Map<string, string>; resolveVar: (name: string) => string | null }) => string | null
  makeResolver: (tokens: Map<string, string>) => (name: string) => string
}

/** 混色用的颜色值（生成器内部的形状，断言只碰 `a` 与格式化输出）。 */
interface MixColor {
  r: number
  g: number
  b: number
  a: number
}

// 生成器是 .mjs，tsc（allowJs 未开）不解析它：动态 import 在类型层是期望中的错误，
// 运行期由 Vite 的 node 外部化接住。
// @ts-expect-error ui-shell/scripts 下的 .mjs 没有 tsc 解析面（allowJs 未开）
const generator = (await import('../ui-shell/scripts/build-color-fallback.mjs')) as unknown as ColorFallbackGen
const {
  TOKENS_PATH,
  OUT_PATH,
  buildFallbackCss,
  parseRules,
  collectTokens,
  fallbackDecls,
  pickDependent,
  mixColors,
  formatColor,
  parseColor,
  evaluate,
  makeResolver,
} = generator

/** 工作区是 CRLF：跨行文本比对一律先摊平（这仓里踩过一次）。 */
const flat = (text: string): string => text.replace(/\r\n/g, '\n')

const tokensCss = readFileSync(TOKENS_PATH, 'utf8')
const committed = flat(readFileSync(OUT_PATH, 'utf8'))
const built = buildFallbackCss(tokensCss)

describe('漂移门：生成器与入库文件一致', () => {
  test('入库文件与刚算出来的逐字节一致（改了 tokens.css 要重跑生成器）', () => {
    expect(committed).toBe(flat(built.css))
  })

  test('产物带 @supports 外壳（认得 color-mix 的内核整块不生效）', () => {
    expect(committed).toContain('@supports not (color: color-mix(in srgb, red, blue))')
  })

  test('深色块、浅色块与 Claude 块都在，且三档各一批（每档 > 20 条声明）', () => {
    expect(committed).toContain('  :root {')
    expect(committed).toContain("  :root[data-theme='light'] {")
    expect(committed).toContain("  :root[data-theme='claude'] {")
    expect(built.counts[0]).toBeGreaterThan(20)
    expect(built.counts[1]).toBeGreaterThan(20)
    expect(built.counts[2]).toBeGreaterThan(20)
  })
})

describe('覆盖门：依赖 color-mix 的令牌一个不漏', () => {
  const strip = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '')
  const rules = parseRules(strip(tokensCss))
  const themesOf = (): Array<[string, Map<string, string>]> => [
    ['深色', collectTokens(rules, { 'data-theme': 'dark', 'data-density': 'standard' }, false)],
    ['浅色', collectTokens(rules, { 'data-theme': 'light', 'data-density': 'standard' }, false)],
    ['Claude', collectTokens(rules, { 'data-theme': 'claude', 'data-density': 'standard' }, false)],
  ]

  test('每个主题：每个依赖 color-mix 的令牌都兜住了（声明数 = 依赖数）', () => {
    for (const [label, tokens] of themesOf()) {
      const dependent = pickDependent(tokens)
      const decls = fallbackDecls(tokens)
      expect(decls.length, label).toBe(dependent.size)
    }
  })

  test('负向：少一个令牌，覆盖门少一条声明（真漏会被抓到）', () => {
    const dark = collectTokens(rules, { 'data-theme': 'dark', 'data-density': 'standard' }, false)
    const tampered = new Map(dark)
    tampered.delete('--dsc-bg-side')
    expect(fallbackDecls(tampered)).toHaveLength(fallbackDecls(dark).length - 1)
  })
})

describe('值形状：兜底值里不许再有 var() / color-mix()', () => {
  const blocks = [...committed.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map(
    (match) => [match[1] ?? '', (match[2] ?? '').replace(/\s+/g, ' ').trim()] as const,
  )

  test('没有一条兜底值还引用 var() / color-mix()（老内核同样算不出来）', () => {
    const dirty = blocks.filter(([, value]) => value.includes('var(') || value.includes('color-mix('))
    expect(dirty).toEqual([])
  })

  test('颜色类兜底值都是实色（rgb()/rgba()/transparent），alpha 都在 0..1', () => {
    const colorish = blocks.filter(
      ([name]) =>
        /^--dsc-(bg|text|stroke|fill|row|control|scrim|selection|diff|inline|scrollbar|accent|chrome|composer)/.test(name) &&
        !/shadow/.test(name),
    )
    const parsed = colorish.map(([name, value]) => ({ name, color: parseColor(value) }))
    const unparseable = parsed.filter(({ color }) => color === null)
    expect(unparseable.map(({ name }) => name)).toEqual([])
    const badAlpha = parsed
      .filter(({ color }) => color !== null)
      .filter(({ color }) => (color as MixColor).a < 0 || (color as MixColor).a > 1)
    expect(badAlpha.map(({ name }) => name)).toEqual([])
  })
})

describe('混色算法：已知值对 + 预乘', () => {
  const white = parseColor('#ffffff')
  const black = parseColor('#000000')
  const clear = parseColor('transparent')
  const grey = parseColor('#2c2c2e')

  test('50/50 黑白 → 128（四舍五入的灰）', () => {
    expect(white !== null && black !== null && formatColor(mixColors(white, null, black, null))).toBe('rgb(128 128 128)')
  })

  test('一边给了百分比，另一边按 100%-x 补（白 25% + 黑补 75% → 25% 白 = 64）', () => {
    expect(white !== null && black !== null && formatColor(mixColors(white, 25, black, null))).toBe('rgb(64 64 64)')
  })

  test('预乘：与透明 50/50 只降 alpha 不压暗（rgb(255 255 255 / 0.5)）', () => {
    expect(white !== null && clear !== null && formatColor(mixColors(white, null, clear, null))).toBe(
      'rgb(255 255 255 / 0.5)',
    )
    expect(grey !== null && clear !== null && formatColor(mixColors(grey, 96, clear, null))).toBe('rgb(44 44 46 / 0.96)')
  })

  test('全透明（0%）→ transparent', () => {
    expect(black !== null && clear !== null && formatColor(mixColors(black, 0, clear, null))).toBe('transparent')
  })

  test('嵌套 color-mix + var() 求值（拿真令牌试：填充 / 浮层描边 / 工具条）', () => {
    const rules = parseRules(tokensCss.replace(/\/\*[\s\S]*?\*\//g, ''))
    const dark = collectTokens(rules, { 'data-theme': 'dark', 'data-density': 'standard' }, false)
    const resolveVar = makeResolver(dark)
    expect(resolveVar('--dsc-fill-primary')).toBe('rgb(249 250 251 / 0.12)')
    expect(resolveVar('--dsc-stroke-float')).toBe('rgb(249 250 251 / 0.03)')
    expect(resolveVar('--dsc-chrome-bar')).toBe('rgb(21 21 23)')
  })

  test('阴影简写里只换颜色（长度照抄）', () => {
    const rules = parseRules(tokensCss.replace(/\/\*[\s\S]*?\*\//g, ''))
    const dark = collectTokens(rules, { 'data-theme': 'dark', 'data-density': 'standard' }, false)
    expect(makeResolver(dark)('--dsc-shadow-xs')).toBe('0 1px 2px rgb(0 0 0 / 0.05)')
  })

  test('求不出来的如实返回 null（不瞎猜一个颜色）', () => {
    expect(evaluate('color-mix(in oklab, red, blue)', { rawTokens: new Map(), resolveVar: () => null })).toBeNull()
  })
})

describe('主题门：浅色块必须与深色块不同', () => {
  const darkBlock = /:root \{([\s\S]*?)\n  \}/.exec(committed)?.[1] ?? ''
  const lightBlock = /:root\[data-theme='light'\] \{([\s\S]*?)\n  \}/.exec(committed)?.[1] ?? ''
  const claudeBlock = /:root\[data-theme='claude'\] \{([\s\S]*?)\n  \}/.exec(committed)?.[1] ?? ''

  test('三段的块头都解析出来了（Claude 段没被吞进浅色段）', () => {
    expect(claudeBlock.length).toBeGreaterThan(200)
  })

  test('三段互不相同（浅色重放没静默回落成深色，Claude 不是换选择器的复制）', () => {
    expect(darkBlock).not.toBe(lightBlock)
    expect(claudeBlock).not.toBe(lightBlock)
  })

  test('Claude 档的具体色值锚（暖米白侧栏、Slate 正文、发丝线、陶土选中底）', () => {
    expect(claudeBlock).toContain('--dsc-bg-side: rgb(240 238 230);')
    expect(claudeBlock).toContain('--dsc-text-primary: rgb(20 20 19 / 0.94);')
    expect(claudeBlock).toContain('--dsc-stroke-3: rgb(20 20 19 / 0.07);')
    expect(claudeBlock).toContain('--dsc-selection-bg: rgb(217 119 87 / 0.22);')
  })

  test('深色与浅色的侧栏底色、文字主色、浅色独有的 composer 填充都在', () => {
    expect(darkBlock).toContain('--dsc-bg-side: rgb(27 27 28);')
    expect(lightBlock).toContain('--dsc-bg-side: rgb(243 247 255);')
    expect(lightBlock).toContain('--dsc-text-primary: rgb(23 23 26 / 0.94);')
    expect(lightBlock).toContain('--dsc-composer-fill: rgb(253 253 253 / 0.88);')
  })
})
