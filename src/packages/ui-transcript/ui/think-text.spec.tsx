/**
 * 思考展开区正文的渲染段（ui 层，真渲染）。
 *
 * 来源：`scripts/ui-think-markdown-test.mjs` 第 [1][2] 段里「必须真渲染组件」的那部分
 * （缺口清单 B34）。原探针钉的是 ThinkText 的源码形态（import 了 MarkdownView、
 * `useContext(ShellCwdContext)`、JSX 上写了 `streaming={live}`）；这里把同一件事
 * 行为化：真把组件画出来，看它**确实**按 markdown 排了版、确实从 context 拿了
 * 工作目录、确实把直播态递给了渲染器——源码文本改个引号不再影响这些断言。
 *
 * 签名与 DOM 锚（`className="think-text"`、`data-live`）是调用点与截图脚本依赖的
 * 公开面，一并钉住。原探针第 [3][4][5] 段是 `.think-text` 的 CSS 规则体（views.css
 * 的文本钉）——jsdom 不应用样式表，渲染层没有那个行为接缝，仍留探针（缺口 B27）。
 *
 * @module dsc-ui-transcript/ui/think-text.spec
 */
import { afterEach, describe, expect, test } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { registerFileLinkOpener } from '@dsc/ui-primitives'
import { ShellCwdContext } from './shared.js'
import { ThinkText } from './rows/think-text.js'

afterEach(cleanup)

describe('ThinkText：正文走 markdown 渲染器', () => {
  test('markdown 真的被解析（加粗 / 行内代码 / 列表各出对应的元素）', () => {
    const { container } = render(
      <ThinkText text={'先看 **重点** 与 `code`，再列：\n\n- 一\n- 二'} live={false} />,
    )
    const root = container.querySelector('.think-text')
    expect(root).toBeTruthy()
    expect(root?.querySelector('strong')?.textContent).toBe('重点')
    expect(root?.querySelector('code')?.textContent).toBe('code')
    expect(root?.querySelectorAll('li').length).toBe(2)
  })

  test('只画一份渲染出口（旧写法「markdown + 裸文本各吐一遍」在这里会数出两份）', () => {
    const { container } = render(<ThinkText text={'# 标题行'} live={false} />)
    // markdown 解析后的标题块恰好一个；正文里没有再裸吐一遍「# 标题行」原文。
    expect(container.querySelectorAll('h1').length).toBe(1)
    expect(container.textContent).not.toContain('# 标题行')
  })

  test('直播态把 data-live 挂上（.think-block.live .think-text 依赖这个根节点）', () => {
    const { container, rerender } = render(<ThinkText text="正文" live={true} />)
    expect(container.querySelector('.think-text')?.getAttribute('data-live')).toBe('1')
    rerender(<ThinkText text="正文" live={false} />)
    expect(container.querySelector('.think-text')?.hasAttribute('data-live')).toBe(false)
  })

  test('工作目录从 ShellCwdContext 取（相对路径的文件链接按 cwd 拼绝对路径）', () => {
    // 相对路径链接要「点得动」得先有人登记 opener（生产里是预览插件）：测试里登记一个
    // 替身，链接才会画成可点的 `<a class="md-file-link">`，cwd 才有落点可断言。
    let opened: string | null = null
    const off = registerFileLinkOpener((path) => {
      opened = path
      return true
    })
    try {
      const { container } = render(
        <ShellCwdContext.Provider value="D:/demo">
          <ThinkText text={'看看 [package.json](package.json) 里的配置'} live={false} />
        </ShellCwdContext.Provider>,
      )
      const link = container.querySelector('a.md-file-link')
      expect(link).toBeTruthy()
      expect(link?.getAttribute('href')).toContain('D:/demo')
      expect(link?.getAttribute('href')).toContain('package.json')
      // 点一下走 opener（本地路径接管，不交给浏览器导航）：交给它的就是拼好的绝对路径。
      link?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      expect(opened).toContain('D:/demo')
      expect(opened).toContain('package.json')
    } finally {
      off()
    }
  })

  test('不包 context 也能渲染（cwd 兜底空串：团队页签那条路不挂 Provider）', () => {
    const { container } = render(<ThinkText text="一段普通的思考" live={false} />)
    expect(container.querySelector('.think-text')?.textContent).toContain('一段普通的思考')
  })
})
