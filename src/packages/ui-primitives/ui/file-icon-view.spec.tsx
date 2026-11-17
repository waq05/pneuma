/**
 * 文件类型字形组件（`file-type-icon.tsx` / `file-icons.tsx`）的渲染段（ui 层，真渲染）。
 *
 * 来源：`scripts/ui-file-icon-test.mjs` 第 [3] 段的渲染半与第 [4] 段的出口半
 * （缺口清单 B36「ui-file-icon [3 部分][4]」）：
 *   - 原探针钉 `traditionalGlyph` 的 `case '<档>':` 覆盖清单——这里把 12 个传统档
 *     逐档真渲染一遍：switch 漏一档，闭集兜底 `assertNever` 当场抛，渲染就炸；
 *   - 原探针钉 `apiTx.includes('export { FileIcon, fileIconName }')` 的出口转发文本
 *     ——这里从 `@dsc/ui` 的公开面 import 渲染，转发链通不通由渲染结果说话；
 *   - 全彩语言字形的实例占位符（`CODE_FILE_ICON_ID_TOKEN`）在 DOM 里必须已被
 *     实例 id 换掉——同一页多枚图标互相串引用就是这条坏了。
 *
 * 不迁的（原探针第 [3] 段其余与第 [4] 段产物半，见交付报告缺口清单）：
 *   `.dsc-fti--*` 配色、十六进制字面量审计、琥珀钉是 CSS 文本钉；`lib/ui/assets`
 *   产物审计要 `pnpm run build:ui`（vitest 只解析 src，归 B31/B32）。
 *
 * @module dsc-ui-primitives/ui/file-icon-view.spec
 */
import { afterEach, describe, expect, test } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { FileIcon, fileIconName } from '@dsc/ui'
import { FileTypeIcon } from './file-type-icon.js'

afterEach(cleanup)

/** 探针钉过的 12 个传统档（`file-type-icon.tsx` 的 traditionalGlyph 闭集）。 */
const TRADITIONAL_KINDS = [
  'archive', 'code', 'excel', 'folder', 'html', 'image', 'markdown', 'other', 'pdf', 'ppt', 'video', 'word',
] as const

describe('传统档字形齐套（ui-file-icon [3] 的 switch 覆盖，行为化）', () => {
  test('12 个传统档逐档渲染：每档都出 svg，类名都带 dsc-fti--<档>', () => {
    for (const kind of TRADITIONAL_KINDS) {
      const { container, unmount } = render(<FileTypeIcon kind={kind} size={16} />)
      const svg = container.querySelector('svg')
      // switch 漏档会走进 assertNever 抛错——渲染不炸本身就是「齐套」的行为证据。
      expect(svg, `传统档 ${kind} 没渲染出字形`).toBeTruthy()
      expect(svg?.getAttribute('viewBox')).toBe('0 0 28 28')
      expect(svg?.getAttribute('class')).toContain(`dsc-fti--${kind}`)
      unmount()
    }
  })

  test('other 档是静音灰文档（muted：折角白降档到 0.36）', () => {
    const { container } = render(<FileTypeIcon kind="other" />)
    const fold = container.querySelector('svg path[fill-opacity]')
    expect(fold?.getAttribute('fill-opacity')).toBe('0.36')
  })

  test('未知类型回落 other（树行里永远有像，不留空位）', () => {
    const { container } = render(<FileTypeIcon path="unknown.screen.shot.xyz" />)
    expect(container.querySelector('svg')?.getAttribute('class')).toContain('dsc-fti--other')
  })
})

describe('代码档全彩字形（CodeFileIcon）', () => {
  test('代码档走 20×20 方片：svg 出得来、实例占位符不残留（同一页多枚不串引用）', () => {
    const { container } = render(
      <>
        <FileTypeIcon path="main.ts" />
        <FileTypeIcon path="a.py" />
      </>,
    )
    // 外层是两枚 20×20 方片；artwork 内部还有 svg-in-svg（品牌 mark 的缩放层），不算顶层。
    const outer = [...container.children].filter((el) => el.tagName === 'svg')
    expect(outer.length).toBe(2)
    const joined = [...container.querySelectorAll('svg')].map((svg) => svg.innerHTML).join('')
    // 占位符必须已被实例 id 换掉——残留就是同一页多枚图标互相串引用。
    expect(joined).not.toContain('__DSC_CODE_ICON_INSTANCE__')
    expect(joined).toContain('dsc-code-icon-')
  })
})

describe('出口面：FileIcon / fileIconName 经 @dsc/ui 照旧拿得到（ui-file-icon [4]）', () => {
  test('FileIcon 是 FileTypeIcon 的转发：给路径渲染出同一枚档位字形', () => {
    const { container } = render(<FileIcon name="a.pdf" size={20} />)
    const svg = container.querySelector('svg')
    expect(svg).toBeTruthy()
    expect(svg?.getAttribute('class')).toContain('dsc-fti--pdf')
    expect(svg?.getAttribute('width')).toBe('20')
  })

  test('fileIconName 返回本仓的档位名（不再是 vscode-icons 的 iconify id）', () => {
    expect(fileIconName('pnpm-lock.yaml')).toBe('yaml')
    expect(fileIconName('muse-code-0.6.47.tgz')).toBe('archive')
    expect(fileIconName('LICENSE')).toBe('other')
  })
})
