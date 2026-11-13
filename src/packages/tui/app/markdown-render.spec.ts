/**
 * markdown 子集解析 + 渲染的确定性测试（迁自 `scripts/markdown-render-test.mjs`）。
 *
 * ## 两截，两种测法
 *
 * - **解析器**（`markdown.ts`）是纯函数：逐块断言 kind / level / 行列数 / 语言。
 * - **渲染**（`MarkdownView.tsx`）走真 ink：PassThrough 管道渲一帧，剥 ANSI 后读文本。
 *   要验的正是「星号井号必须消失、表格出框线、链接带补注」——这些只有帧上看得见。
 *
 * 表格竖线对齐是单独一条：CJK 在终端占两列，宽度算错时表头与内容会错位，而这是
 * 用户一眼就能看出的翻车点（断言方式是量每条框线所在显示列，要求全帧一致）。
 *
 * ## 归 tui project
 *
 * ink 渲染在 node 里跑、靠假 stdout 拿帧，不是 jsdom。帧取法同 `pickers.spec.ts`：
 * 等输出长度连续几拍不变再收（这版 ink 没有 `lastFrame`，固定 sleep 在慢机器上会读半帧）。
 *
 * @module dsc/packages/tui/app/markdown-render.spec
 */
import { PassThrough } from 'node:stream'
import { createElement } from 'react'
import { render } from 'ink'
import { describe, expect, test } from 'vitest'
import { parseInline, parseMarkdown } from './markdown.js'
import { displayWidth } from './display-width.js'
import { MarkdownView } from './MarkdownView.js'

/** 一份画全七种块的样例文档（解析与渲染共用）。 */
const DOC = [
  '## 结论',
  '**晴到多云**，全天无雨。',
  '',
  '- **工作目录**：`D:\\dsc`，先确认位置',
  '- 第二条',
  '',
  '1. 第一点',
  '2. 第二点',
  '',
  '| 项目 | 国内源 | 国际源 |',
  '| --- | --- | --- |',
  '| 气温 | 14 ℃ ~ 25 ℃ | 11 ℃ ~ 24 ℃ |',
  '| 降水 | 未提供 | 0% |',
  '',
  '> 引用一句',
  '',
  '```ts',
  'const x = 1',
  '```',
].join('\n')

/** 剥掉 ANSI 与光标控制序列。 */
function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;?<]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')
}

/** 渲一帧再收回（等输出长度连续几拍不变，最多 3 秒）。 */
async function renderFrame(source: string): Promise<string> {
  const stdout = new PassThrough() as PassThrough & { columns: number; rows: number }
  stdout.columns = 100
  stdout.rows = 40
  let output = ''
  stdout.on('data', (chunk: Buffer) => {
    output += String(chunk)
  })
  const instance = render(createElement(MarkdownView, { source }), {
    stdout: stdout as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  const startedAt = Date.now()
  const deadline = startedAt + 3_000
  let previous = -1
  let stable = 0
  while (Date.now() < deadline) {
    await new Promise((resolveTick) => setTimeout(resolveTick, 20))
    if (output.length === previous) stable += 1
    else {
      stable = 0
      previous = output.length
    }
    if (Date.now() - startedAt >= 120 && stable >= 3) break
  }
  instance.unmount()
  return stripAnsi(output)
}

describe('① 行内解析', () => {
  test('粗体解析', () => {
    const bold = parseInline('**晴到多云**，全天无雨')
    expect(bold.some((span) => span.bold === true && span.text === '晴到多云')).toBe(true)
    expect(bold.some((span) => span.text === '，全天无雨')).toBe(true)
  })

  test('行内代码解析', () => {
    const code = parseInline('西北风 `3-4 级` 转微风')
    expect(code.some((span) => span.code === true && span.text === '3-4 级')).toBe(true)
  })

  test('链接解析', () => {
    const link = parseInline('[数据来源](https://weather.example.com) 已核对')
    expect(link.some((span) => span.link === 'https://weather.example.com' && span.text === '数据来源')).toBe(true)
  })

  test('snake_case 不当斜体', () => {
    const snake = parseInline('变量 foo_bar_baz 与 my_var 不受斜体影响')
    expect(snake.some((span) => span.italic === true)).toBe(false)
  })

  test('嵌套解析（粗体套代码）', () => {
    const nested = parseInline('**粗体里 `code` 套**')
    expect(nested.some((span) => span.bold === true && span.code === true && span.text === 'code')).toBe(true)
  })
})

describe('② 块解析', () => {
  /** 七块按顺序：标题 / 段 / 无序 / 有序 / 表 / 引 / 码。 */
  const blocks = parseMarkdown(DOC)

  test('块数（标题/段/无序/有序/表/引/码）', () => {
    expect(blocks).toHaveLength(7)
  })

  test('H2 标题', () => {
    const heading = blocks[0]
    expect(heading?.kind).toBe('heading')
    expect(heading?.kind === 'heading' ? heading.level : undefined).toBe(2)
  })

  test('段落含粗体 span', () => {
    const paragraph = blocks[1]
    expect(paragraph?.kind).toBe('paragraph')
    expect(paragraph?.kind === 'paragraph' ? paragraph.rows[0]?.some((span) => span.bold === true) : false).toBe(true)
  })

  test('无序列表两项', () => {
    const list = blocks[2]
    expect(list?.kind).toBe('list')
    expect(list?.kind === 'list' ? list.ordered : undefined).toBe(false)
    expect(list?.kind === 'list' ? list.items.length : -1).toBe(2)
  })

  test('有序列表两项', () => {
    const list = blocks[3]
    expect(list?.kind).toBe('list')
    expect(list?.kind === 'list' ? list.ordered : undefined).toBe(true)
    expect(list?.kind === 'list' ? list.items.length : -1).toBe(2)
  })

  test('表格 3 列 2 行', () => {
    const table = blocks[4]
    expect(table?.kind).toBe('table')
    expect(table?.kind === 'table' ? table.header.length : -1).toBe(3)
    expect(table?.kind === 'table' ? table.rows.length : -1).toBe(2)
  })

  test('表格表头首格', () => {
    const table = blocks[4]
    expect(table?.kind === 'table' ? table.header[0]?.[0]?.text : undefined).toBe('项目')
  })

  test('引用块', () => {
    expect(blocks[5]?.kind).toBe('quote')
  })

  test('代码块带语言', () => {
    const code = blocks[6]
    expect(code?.kind).toBe('code')
    expect(code?.kind === 'code' ? code.lang : undefined).toBe('ts')
    expect(code?.kind === 'code' ? code.lines[0] : undefined).toBe('const x = 1')
  })

  test('显示宽度 CJK=2、ASCII=1', () => {
    expect(displayWidth('气温')).toBe(4)
    expect(displayWidth('ab')).toBe(2)
  })

  test('未闭合围栏照收（不崩）', () => {
    const unclosed = parseMarkdown('```ts\nconst x = 1')
    expect(unclosed).toHaveLength(1)
    expect(unclosed[0]?.kind).toBe('code')
  })
})

describe('③ 渲染（真 ink 管道）', () => {
  test('标题不带井号', async () => {
    const frame = await renderFrame(DOC)
    expect(frame.split('\n').some((line) => line.trim() === '结论')).toBe(true)
    expect(frame.includes('## ')).toBe(false)
  })

  test('粗体不带星号', async () => {
    const frame = await renderFrame(DOC)
    expect(frame.includes('**')).toBe(false)
    expect(frame.includes('晴到多云，全天无雨。')).toBe(true)
  })

  test('行内代码不带反引号（围栏行的反引号合法）', async () => {
    const frame = await renderFrame(DOC)
    const lines = frame.split('\n')
    expect(frame.includes('D:\\dsc')).toBe(true)
    expect(lines.some((line) => line.includes('D:\\dsc') && line.includes('`'))).toBe(false)
  })

  test('列表符号渲染', async () => {
    const frame = await renderFrame(DOC)
    expect(frame.includes('- 工作目录')).toBe(true)
    expect(frame.includes('1. 第一点')).toBe(true)
  })

  test('表格框线', async () => {
    const frame = await renderFrame(DOC)
    expect(frame.includes('┌')).toBe(true)
    expect(frame.includes('┼')).toBe(true)
    expect(frame.includes('└')).toBe(true)
  })

  test('表格竖线全对齐（CJK 宽度算错的经典翻车点）', async () => {
    const frame = await renderFrame(DOC)
    const markCols = frame
      .split('\n')
      .filter((line) => /[│┌┬┐├┼┤└┴┘]/.test(line))
      .map((line) => {
        const cols: number[] = []
        let width = 0
        for (const ch of line) {
          if ('│┌┬┐├┼┤└┴┘'.includes(ch)) cols.push(width)
          width += displayWidth(ch)
        }
        return cols.join(',')
      })
    expect(markCols.length).toBeGreaterThan(0)
    expect(new Set(markCols).size).toBe(1)
  })

  test('表格表头居中行', async () => {
    const frame = await renderFrame(DOC)
    expect(frame.split('\n').some((line) => line.includes('│') && line.includes('项目'))).toBe(true)
  })

  test('引用符号渲染', async () => {
    const frame = await renderFrame(DOC)
    expect(frame.includes('▎')).toBe(true)
    expect(frame.includes('引用一句')).toBe(true)
    expect(frame.includes('> 引用')).toBe(false)
  })

  test('围栏行保留语言、正文缩进', async () => {
    const frame = await renderFrame(DOC)
    expect(frame.includes('```ts')).toBe(true)
    expect(frame.split('\n').some((line) => line === '  const x = 1')).toBe(true)
  })
})

describe('④ 链接补注 url', () => {
  test('链接文本 + url 补注都在帧上', async () => {
    const frame = await renderFrame('看[数据来源](https://a.b/c)即知')
    expect(frame.includes('数据来源')).toBe(true)
    expect(frame.includes('(https://a.b/c)')).toBe(true)
  })
})
