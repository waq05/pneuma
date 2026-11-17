/**
 * `markdown.tsx` 的分支补测（真渲染，与 primitives-extra 的纯函数出口互补）。
 *
 * 既有 spec 只测了 `isLocalFilePath` / `isRelativeFilePath` 两个纯函数；这里补组件层的
 * 分支：
 *   - 链接：本地绝对路径 / 相对路径（有 base / 无 base）/ 外链 / 未知协议，以及 opener
 *     注册与注销（注销只清自己那一枚）；
 *   - 图片：外链直出、空 src 占位、相对路径经 fsRead 转 data URL、缓存命中、tooLarge /
 *     非图片 / 读取失败 / 没给 fsRead 四种占位；
 *   - 代码块：无语言围栏与行内 code、纯文本→高亮的同构骨架、highlight 返回 null / 抛错、
 *     流式 120ms 延迟、缓存命中、折行开关、复制成功与失败；
 *   - 源行号：标题 / 段落 / 列表 / 引用 / 表格 / 分隔线都带 `data-line-start`；
 *   - 改动区间：命中块加 `.md-changed`、外层命中后内层不叠、区间变化时移除旧类。
 *
 * 高亮模块换成 `highlightToLines` 的替身：不为了测渲染去装载 shiki 语法；其余一概真跑
 * （react-markdown + remark-gfm + rehype 插件 + jsdom）。
 *
 * @module dsc-ui-primitives/ui/markdown-extra.spec
 */
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { isLocalFilePath, isRelativeFilePath, MarkdownView, registerFileLinkOpener } from './markdown.js'

const hl = vi.hoisted(() => ({ highlightToLines: vi.fn() }))

vi.mock('./highlight', () => ({ highlightToLines: hl.highlightToLines }))

beforeEach(() => {
  hl.highlightToLines.mockReset()
  hl.highlightToLines.mockResolvedValue(null)
  document.body.innerHTML = ''
  registerFileLinkOpener(null)
})

afterEach(() => {
  cleanup()
  registerFileLinkOpener(null)
  vi.useRealTimers()
  document.body.innerHTML = ''
  Reflect.deleteProperty(navigator, 'clipboard')
})

/** 渲染一段 markdown，返回容器。 */
function view(text: string, extra: Partial<ComponentProps<typeof MarkdownView>> = {}) {
  return render(<MarkdownView text={text} path="" {...extra} />)
}

describe('本地路径判定的编码边界', () => {
  test('%5C 解码失败时退回原文；协议、锚点、UNC 正/反斜杠都不混判', () => {
    // 含 %5c 但百分号序列非法：decodeURIComponent 抛错，原样返回，最终不是本地路径。
    expect(isLocalFilePath('D:%5Cbroken%')).toBe(false)
    expect(isLocalFilePath('  D:\\dsc\\a.ts  ')).toBe(true)
    expect(isLocalFilePath('//server/share/a')).toBe(false)
    expect(isRelativeFilePath('  docs/a.md  ')).toBe(true)
    expect(isRelativeFilePath('\\\\server\\share')).toBe(false)
    expect(isRelativeFilePath('../a.md')).toBe(true)
  })
})

describe('链接：本地路径、相对路径与外链', () => {
  test('本地绝对路径交给 opener；href 里的 %5C 先解码；没有 opener 退回不可点文本', () => {
    const opener = vi.fn(() => true)
    const off = registerFileLinkOpener(opener)
    const local = view('[a](D:%5Cdsc%5Ca.ts)')
    const anchor = local.container.querySelector('a.md-file-link')
    expect(anchor?.getAttribute('href')).toBe('D:\\dsc\\a.ts')
    expect(anchor?.getAttribute('role')).toBe('button')
    fireEvent.click(anchor!)
    expect(opener).toHaveBeenCalledWith('D:\\dsc\\a.ts')
    local.unmount()

    off()
    const flat = view('[a](D:%5Cdsc%5Ca.ts)')
    expect(flat.container.querySelector('a')).toBeNull()
    expect(flat.container.querySelector('span.md-link-flat')?.textContent).toBe('a')
  })

  test('相对路径：有 baseDir 拼绝对路径；base 为空时不可点；path 目录作为缺省 base', () => {
    const opener = vi.fn(() => true)
    const off = registerFileLinkOpener(opener)

    const withBase = view('[pkg](package.json)', { baseDir: 'C:\\work' })
    fireEvent.click(withBase.container.querySelector('a.md-file-link')!)
    expect(opener).toHaveBeenCalledWith('C:\\work\\package.json')
    withBase.unmount()

    const noBase = view('[pkg](package.json)')
    expect(noBase.container.querySelector('a')).toBeNull()
    expect(noBase.container.querySelector('span.md-link-flat')).not.toBeNull()
    noBase.unmount()

    const fromPath = render(<MarkdownView text="[a](a.md)" path={'D:\\docs\\readme.md'} />)
    fireEvent.click(fromPath.container.querySelector('a.md-file-link')!)
    expect(opener).toHaveBeenCalledWith('D:\\docs\\a.md')

    off()
  })

  test('外链才新窗口（保留 title）；未知协议与相对路径一样退回文本', () => {
    const { container } = render(<MarkdownView text={"[x](https://example.com '提示') [m](mailto:a@b.c) [f](ftp://x) [r](docs/a.md)"} path="" />)
    const anchors = container.querySelectorAll('a')
    expect(anchors).toHaveLength(2)
    expect(anchors[0]?.getAttribute('target')).toBe('_blank')
    expect(anchors[0]?.getAttribute('rel')).toBe('noreferrer noopener')
    expect(anchors[0]?.getAttribute('title')).toBe('提示')
    expect(anchors[1]?.getAttribute('href')).toBe('mailto:a@b.c')
    expect(container.querySelectorAll('span.md-link-flat')).toHaveLength(2)
  })

  test('registerFileLinkOpener：注销先注册的那一枚不会顶掉后注册的', () => {
    const first = vi.fn(() => true)
    const second = vi.fn(() => true)
    const offFirst = registerFileLinkOpener(first)
    const offSecond = registerFileLinkOpener(second)

    offFirst()
    const { container } = view('[a](docs/a.md)', { baseDir: 'C:\\w' })
    fireEvent.click(container.querySelector('a.md-file-link')!)
    expect(second).toHaveBeenCalledTimes(1)
    expect(first).not.toHaveBeenCalled()

    offSecond()
    const after = view('[a](docs/a.md)', { baseDir: 'C:\\w' })
    expect(after.container.querySelector('a')).toBeNull()
  })
})

describe('图片：外链、占位与 fsRead 缓存', () => {
  test('http 图片直接给 src；空 src 显示「[图片]」', () => {
    const { container } = render(<MarkdownView text="![远程](https://e.com/a.png) ![空]()" path="" />)
    const images = container.querySelectorAll('img')
    expect(images).toHaveLength(1)
    expect(images[0]?.getAttribute('src')).toBe('https://e.com/a.png')
    expect(images[0]?.getAttribute('alt')).toBe('远程')
    expect(images[0]?.getAttribute('loading')).toBe('lazy')
    expect(container.querySelectorAll('span.file-md-img-missing')).toHaveLength(1)
    expect(container.textContent).toContain('[图片]')
  })

  test('相对图片：fsRead 成功转 data URL，并进缓存（第二次渲染不再读盘）', async () => {
    const read = vi.fn(async () => ({ kind: 'image', mime: 'image/png', base64: 'QUJD' }))
    const first = render(
      <MarkdownView text="![截图](shot.png)" path="" baseDir={'C:\\w'} fsRead={read} />,
    )
    await waitFor(() => expect(first.container.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,QUJD'))
    expect(read).toHaveBeenCalledWith('C:\\w\\shot.png')
    first.unmount()

    const readAgain = vi.fn(async () => ({ kind: 'image', mime: 'image/png', base64: 'QUJD' }))
    const second = render(
      <MarkdownView text="![截图](shot.png)" path="" baseDir={'C:\\w'} fsRead={readAgain} />,
    )
    expect(second.container.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,QUJD')
    expect(readAgain).not.toHaveBeenCalled()
  })

  test('相对图片的四种占位：没给 fsRead、tooLarge、非图片、读取抛错；alt 为空用 src 当标签', async () => {
    const none = render(<MarkdownView text="![x](none.png)" path="" baseDir={'C:\\w'} />)
    expect(none.container.querySelector('span.file-md-img-missing')?.textContent).toBe('[图片：x]')
    none.unmount()

    const tooLarge = render(
      <MarkdownView
        text="![](big.png)"
        path=""
        baseDir={'C:\\w'}
        fsRead={async () => ({ kind: 'image', tooLarge: true, base64: 'AA' })}
      />,
    )
    await waitFor(() => expect(tooLarge.container.querySelector('span.file-md-img-missing')).not.toBeNull())
    expect(tooLarge.container.textContent).toContain('[图片：big.png]')
    tooLarge.unmount()

    const notImage = render(
      <MarkdownView text="![t](text.txt)" path="" baseDir={'C:\\w'} fsRead={async () => ({ kind: 'text' })} />,
    )
    await waitFor(() => expect(notImage.container.querySelector('span.file-md-img-missing')).not.toBeNull())
    notImage.unmount()

    const rejected = render(
      <MarkdownView
        text="![r](boom.png)"
        path=""
        baseDir={'C:\\w'}
        fsRead={async () => {
          throw new Error('读不了')
        }}
      />,
    )
    await waitFor(() => expect(rejected.container.querySelector('span.file-md-img-missing')).not.toBeNull())
  })
})

describe('代码块：高亮状态机与按钮', () => {
  test('有语言围栏：先纯文本、后高亮，DOM 骨架始终是 pre.shiki > code > span.line', async () => {
    hl.highlightToLines.mockResolvedValueOnce([
      [{ text: 'const', style: { color: '#111111' } }, { text: ' x', style: {} }],
      [{ text: 'y', style: {} }],
    ])
    const { container } = render(<MarkdownView text={'```ts\nconst x\ny\n```'} path="" />)
    expect(container.querySelectorAll('pre.shiki')).toHaveLength(1)
    expect(container.querySelector('.md-code-lang')?.textContent).toBe('ts')
    expect(container.querySelector('.md-code-block')?.getAttribute('data-line-start')).not.toBeNull()
    // 高亮前：每行一个 span.line，行内没有 token span。
    expect(container.querySelectorAll('span.line')).toHaveLength(2)
    expect(container.querySelectorAll('span.line span')).toHaveLength(0)

    await waitFor(() => expect(container.querySelectorAll('span.line span')).toHaveLength(3))
    expect(container.querySelector('span.line span')?.getAttribute('style')).toContain('color')
    expect(hl.highlightToLines).toHaveBeenCalledWith('const x\ny', 'ts')
  })

  test('高亮返回 null 或抛错：留在纯文本，不空块', async () => {
    const nullView = render(<MarkdownView text={'```ts\nplain\n```'} path="" />)
    await waitFor(() => expect(hl.highlightToLines).toHaveBeenCalledTimes(1))
    expect(nullView.container.querySelectorAll('span.line span')).toHaveLength(0)
    expect(nullView.container.textContent).toContain('plain')
    nullView.unmount()

    hl.highlightToLines.mockReset()
    hl.highlightToLines.mockRejectedValue(new Error('语法装不上'))
    const failView = render(<MarkdownView text={'```rust\nfallback\n```'} path="" />)
    await waitFor(() => expect(hl.highlightToLines).toHaveBeenCalledTimes(1))
    expect(failView.container.querySelectorAll('span.line span')).toHaveLength(0)
    expect(failView.container.textContent).toContain('fallback')
  })

  test('无语言围栏与行内 code 不进入高亮组件', () => {
    const { container } = render(<MarkdownView text={'```\nno-lang\n```\n\n行内 `code`'} path="" />)
    expect(container.querySelector('pre.shiki')).toBeNull()
    expect(container.querySelector('.md-code-head')).toBeNull()
    expect(container.textContent).toContain('no-lang')
    expect(container.textContent).toContain('code')
    expect(hl.highlightToLines).not.toHaveBeenCalled()
  })

  test('流式：等到代码停顿 120ms 才调用高亮；卸载会清掉定时器', async () => {
    vi.useFakeTimers()
    hl.highlightToLines.mockResolvedValue([[{ text: 'x', style: {} }]])
    const { container, unmount } = render(<MarkdownView text={'```ts\nx\n```'} path="" streaming />)
    expect(hl.highlightToLines).not.toHaveBeenCalled()

    await act(async () => {
      vi.advanceTimersByTime(120)
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(hl.highlightToLines).toHaveBeenCalledTimes(1)
    expect(container.querySelectorAll('span.line span')).toHaveLength(1)

    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  test('缓存命中：同一段代码第二次渲染直接用结果，不再跑高亮', async () => {
    hl.highlightToLines.mockResolvedValue([[{ text: 'cached', style: {} }]])
    const first = render(<MarkdownView text={'```ts\ncache-me\n```'} path="" />)
    await waitFor(() => expect(first.container.querySelectorAll('span.line span')).toHaveLength(1))
    first.unmount()

    hl.highlightToLines.mockClear()
    const second = render(<MarkdownView text={'```ts\ncache-me\n```'} path="" />)
    expect(second.container.querySelectorAll('span.line span')).toHaveLength(1)
    expect(hl.highlightToLines).not.toHaveBeenCalled()
  })

  test('折行开关与复制反馈：成功 1.6s 后复原；写剪贴板失败不抛到界面', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const { container } = render(<MarkdownView text={'```ts\ncopy\n```'} path="" />)
    const [wrapButton, copyButton] = Array.from(container.querySelectorAll<HTMLButtonElement>('button.md-code-act'))

    fireEvent.click(wrapButton!)
    expect(wrapButton?.getAttribute('aria-pressed')).toBe('true')
    expect(container.querySelector('.file-code-body--wrap')).not.toBeNull()
    expect(wrapButton?.getAttribute('title')).toBe('取消换行')
    fireEvent.click(wrapButton!)
    expect(wrapButton?.getAttribute('aria-pressed')).toBe('false')
    expect(container.querySelector('.file-code-body--wrap')).toBeNull()

    await act(async () => {
      fireEvent.click(copyButton!)
    })
    expect(writeText).toHaveBeenCalledWith('copy')
    expect(copyButton?.getAttribute('data-copied')).toBe('true')
    await act(async () => {
      vi.advanceTimersByTime(1600)
    })
    expect(copyButton?.getAttribute('data-copied')).toBeNull()

    writeText.mockRejectedValueOnce(new Error('没有安全上下文'))
    await act(async () => {
      fireEvent.click(copyButton!)
    })
    expect(copyButton?.getAttribute('data-copied')).toBeNull()
  })
})

describe('源行号与改动区间', () => {
  test('块级元素都带 data-line-start / end（标题、段落、列表、引用、表格、分隔线）', () => {
    const text = [
      '# 标题',
      '',
      '段落文字',
      '',
      '- 列表项',
      '',
      '> 引用',
      '',
      '| 列 | 值 |',
      '| --- | --- |',
      '| a | 1 |',
      '',
      '---',
    ].join('\n')
    const { container } = view(text)
    expect(container.querySelector('h1')?.getAttribute('data-line-start')).toBe('1')
    expect(container.querySelector('p')?.getAttribute('data-line-start')).toBe('3')
    expect(container.querySelector('li')?.getAttribute('data-line-start')).toBe('5')
    expect(container.querySelector('blockquote')?.getAttribute('data-line-start')).toBe('7')
    expect(container.querySelector('table')?.getAttribute('data-line-start')).toBe('9')
    expect(container.querySelector('tbody')?.getAttribute('data-line-end')).not.toBeNull()
    expect(container.querySelector('hr')?.getAttribute('data-line-start')).toBe('13')
  })

  test('changedRanges：命中外层块后内层不叠色；区间换位会移除旧类', () => {
    const text = '> 引用第一行\n> 第二行\n\n普通段落'
    const { container, rerender } = render(
      <MarkdownView text={text} path="" changedRanges={[[1, 2]]} />,
    )
    const marked = Array.from(container.querySelectorAll('.md-changed'))
    expect(marked).toHaveLength(1)
    expect(marked[0]?.tagName).toBe('BLOCKQUOTE')

    rerender(<MarkdownView text={text} path="" changedRanges={[[4, 4]]} />)
    const next = Array.from(container.querySelectorAll('.md-changed'))
    expect(next).toHaveLength(1)
    expect(next[0]?.tagName).toBe('P')
    expect(next[0]?.textContent).toBe('普通段落')
  })

  test('changedRanges 为空数组时一个块都不标', () => {
    const { container } = render(<MarkdownView text="段落" path="" changedRanges={[]} />)
    expect(container.querySelectorAll('.md-changed')).toHaveLength(0)
  })
})
