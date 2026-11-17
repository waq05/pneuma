/**
 * 壳侧主题归一化（迁自 `scripts/ui-color-fallback-test.mjs` 第 [7] 段里唯一有运行期
 * 接缝的两条）。
 *
 * 原探针第 [7] 段钉 Claude 档四处接上：内核枚举（编译期类型）、偏好白名单（core 私有
 * 常量）、**壳的归一化**（本文件钉的就是这个：`appearanceFromPrefs` 真跑）、设置磁贴
 * 与原生弹层（渲染层 / 桌面层文本钉）。壳归一化的两条是「认 claude」与「兜底是
 * claude（与出厂默认一致）」——2026-10-30 出厂默认从 dark 改成 claude，归一化改成
 * 四档白名单 + 回落 claude。
 *
 * 其余段没迁的原因见交付报告缺口清单：`appearance.ts` 的 `THEME_MODES` 是私有常量，
 * 白名单行为只能经 `appearanceFromPrefs` 的导出面验；磁贴 / 原生弹层 / tokens.css
 * 的 color-scheme 是渲染与桌面侧文本钉。
 *
 * @module dsc-ui-runtime/ui/appearance.spec
 */
import { describe, expect, test } from 'vitest'
import { DEFAULT_APPEARANCE, appearanceFromPrefs } from './appearance.js'

describe('壳的归一化认 claude（四档白名单）', () => {
  test('四档原样通过：dark / light / claude / system', () => {
    for (const themeMode of ['dark', 'light', 'claude', 'system'] as const) {
      expect(appearanceFromPrefs({ themeMode }).themeMode).toBe(themeMode)
    }
  })

  test('认不出的值回落 claude（与出厂默认一致，不是 dark）', () => {
    // 垃圾值在类型上不该存在，但归一化就是为运行期的脏值兜底的——用断言把这条语义钉住。
    const garbage = 'blue' as unknown as import('./appearance.js').ThemeMode
    expect(appearanceFromPrefs({ themeMode: garbage }).themeMode).toBe('claude')
    expect(appearanceFromPrefs({ themeMode: undefined }).themeMode).toBe('claude')
    expect(appearanceFromPrefs(null)?.themeMode).toBe('claude')
    // 出厂默认本身也是 claude：兜底与默认同源，不会各漂各的。
    expect(DEFAULT_APPEARANCE.themeMode).toBe('claude')
  })
})
