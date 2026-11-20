/**
 * `markdown.tsx` 两张模块级缓存的淘汰路径补测（W14 重 harness 面）。
 *
 * 两张表都是进程级的：图片 base64 缓存按 24MB 字符预算淘汰（269-273），高亮行缓存按
 * 200 条 / 1.5M 字符两道闸淘汰（349-351 / 357-361）。它们没有导出读写入口，只能经
 * `MarkdownView` 的真渲染把 `putImage` / `putLines` 喂到超预算——所以这份文件单独跑，
 * 不把大输入混进别的 markdown 用例。
 *
 * 做法：
 *  - 图片：`fsRead` 每张返回同一份 3.2MB base64，8 张合计 25.6MB > 24MB，插入序淘汰；
 *    淘汰后可观察的行为是「最老的图再挂一次要重新读盘、最近的仍命中缓存」。
 *  - 高亮：`./highlight` 换成固定行结果的替身（不加载 shiki）；同一段代码两个代码块
 *    （同键二次 put，349-351）；201 段不同代码把条数闸顶破（357-361）。
 *
 * @module dsc-ui-primitives/ui/w14c-markdown-cache.spec
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { MarkdownView } from './markdown.js'

const hl = vi.hoisted(() => ({ highlightToLines: vi.fn() }))

vi.mock('./highlight', () => ({ highlightToLines: hl.highlightToLines }))

beforeEach(() => {
  hl.highlightToLines.mockReset()
  hl.highlightToLines.mockResolvedValue([[{ text: 'x', style: {} }]])
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

/** 每次读取都回同一份大 base64（长度按字符算）。 */
const BIG_BASE64 = 'A'.repeat(3_200_000)

function imageMarkdown(count: number): string {
  return Array.from({ length: count }, (_, index) => `![图${String(index)}](img${String(index)}.png)`).join('\n\n')
}

type FsReadFn = (file: string) => Promise<unknown>
type FsReadMock = { fn: FsReadFn; mock: ReturnType<typeof vi.fn> }

/** 一份「每次都回同一张大图」的读取替身：fn 给组件，mock 用来断言读了几次。 */
function fsReadOf(): FsReadMock {
  const mock = vi.fn(async () => ({ kind: 'image', mime: 'image/png', base64: BIG_BASE64 }))
  return { fn: mock as unknown as FsReadFn, mock }
}

describe('图片缓存的字符预算淘汰', () => {
  test('8 张各 3.2MB：超过 24MB 预算后按插入序淘汰最老的（269-273）', async () => {
    const fsRead = fsReadOf()
    const first = render(<MarkdownView text={imageMarkdown(8)} path="" baseDir={'D:\\img'} fsRead={fsRead.fn} />)
    await waitFor(() => expect(fsRead.mock).toHaveBeenCalledTimes(8), { timeout: 10_000 })
    await waitFor(() => expect(first.container.querySelectorAll('img')).toHaveLength(8))
    first.unmount()

    // 最老的 img0 已被淘汰：再挂一次要重新读盘。
    const oldestRead = fsReadOf()
    render(<MarkdownView text={'![图0](img0.png)'} path="" baseDir={'D:\\img'} fsRead={oldestRead.fn} />)
    await waitFor(() => expect(oldestRead.mock).toHaveBeenCalledTimes(1))

    // 最近的 img7 还在缓存里：再挂一次不再读盘。
    const newestRead = fsReadOf()
    const newest = render(<MarkdownView text={'![图7](img7.png)'} path="" baseDir={'D:\\img'} fsRead={newestRead.fn} />)
    await waitFor(() => expect(newest.container.querySelector('img')).not.toBeNull())
    expect(newestRead.mock).not.toHaveBeenCalled()
  }, 30_000)
})

describe('高亮行缓存的淘汰', () => {
  test('同一段代码两个代码块：第二个 put 命中已有键，先删再插（349-351）', async () => {
    const code = 'const duplicated = 1'
    const { container } = render(<MarkdownView text={`\`\`\`ts\n${code}\n\`\`\`\n\n\`\`\`ts\n${code}\n\`\`\``} path="" />)
    // 高亮结果落到行里：两个块都要有 span.line（替身给了一行）。
    await waitFor(() => expect(container.querySelectorAll('.md-code-block')).toHaveLength(2))
    await waitFor(() => {
      const lines = container.querySelectorAll('span.line span')
      expect(lines.length).toBeGreaterThanOrEqual(2)
    })
    expect(hl.highlightToLines).toHaveBeenCalledTimes(2)
  })

  test('201 段不同代码：条数闸顶破后按插入序淘汰（357-361）', async () => {
    const blocks = Array.from({ length: 201 }, (_, index) => `\`\`\`ts\nconst v${String(index)} = ${String(index)}\n\`\`\``).join(
      '\n\n',
    )
    const { container } = render(<MarkdownView text={blocks} path="" />)
    await waitFor(() => expect(container.querySelectorAll('.md-code-block')).toHaveLength(201), { timeout: 20_000 })
    await waitFor(() => expect(hl.highlightToLines).toHaveBeenCalledTimes(201), { timeout: 20_000 })
    // 淘汰之后再渲最后一段：仍在缓存里，不用重算。
    hl.highlightToLines.mockClear()
    const later = render(<MarkdownView text={'```ts\nconst v200 = 200\n```'} path="" />)
    await waitFor(() => expect(later.container.querySelector('span.line')).not.toBeNull())
    expect(hl.highlightToLines).not.toHaveBeenCalled()
  }, 60_000)
})
