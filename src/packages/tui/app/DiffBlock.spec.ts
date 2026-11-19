/**
 * `DiffBlock` 的折叠行数（F14）：4 行 hunk 曾显示「… 还有 10 行」。
 *
 * ## 这个 bug 的形状
 *
 * 旧实现用「折叠额度还剩多少」反推已画行数：`shown = total - remaining`。行数少于
 * 折叠上限（14）时额度根本没用完，`remaining` 仍是 10，于是 `shown = 4 - 10 = -6`、
 * `hidden = 10`——一张只有 4 行的 diff 告诉你「还有 10 行」。面板越大、hunk 越小，
 * 编出来的数字越大（10 = 14 - 4）。
 *
 * ## 为什么用整屏帧断言而不是函数
 *
 * 折叠行数与文案是一条链：`FOLD_LINES` → 循环 → 末尾那句「… 还有 N 行」。只测常量或
 * 只测 `hidden` 都可能在组件层再次拼错（这次就是）。所以渲真组件、剥 ANSI、数帧里的
 * 行与字。
 *
 * @module dsc-tui/app/DiffBlock.spec
 */
import { PassThrough } from 'node:stream'
import { createElement } from 'react'
import { render } from 'ink'
import { afterEach, describe, expect, test } from 'vitest'
import type { ApprovalDiffView, DiffHunkView, DiffLineView } from '@pneuma/runtime/contract.js'
import { DiffBlock } from './DiffBlock.js'

/** 假 stdout：宽一点，避免行被 ink 折行影响计数。 */
function makeStdout(): { stdout: PassThrough; read: () => string } {
  const stdout = new PassThrough() as PassThrough & { columns: number; rows: number; isTTY: boolean }
  stdout.columns = 200
  stdout.rows = 60
  stdout.isTTY = false
  let output = ''
  stdout.on('data', (chunk: Buffer) => {
    output += String(chunk)
  })
  return { stdout, read: () => output.replace(/\x1b\[[0-9;?<]*[A-Za-z]/g, '') }
}

/** 等一帧稳定（与 status-bar.spec 同款：输出长度连续几拍不变）。 */
async function settle(read: () => string): Promise<void> {
  const startedAt = Date.now()
  let previous = -1
  let stable = 0
  while (Date.now() < startedAt + 2_000) {
    await new Promise((resolveTick) => setTimeout(resolveTick, 20))
    const length = read().length
    if (length === previous) stable += 1
    else {
      stable = 0
      previous = length
    }
    if (Date.now() - startedAt >= 120 && stable >= 3) return
  }
}

/** 一行差异。 */
const line = (kind: DiffLineView['kind'], text: string): DiffLineView => ({
  kind,
  text,
  oldLine: kind === 'add' ? null : 1,
  newLine: kind === 'remove' ? null : 1,
})

/** 一个 hunk（行数由入参决定，头行不参与折叠计数）。 */
const hunk = (lines: DiffLineView[], oldStart = 1): DiffHunkView => ({
  oldStart,
  oldCount: lines.length,
  newStart: oldStart,
  newCount: lines.length,
  lines,
})

/** 一份 diff。 */
function diffOf(hunks: DiffHunkView[], overrides: Partial<ApprovalDiffView> = {}): ApprovalDiffView {
  return {
    path: '/w/README.md',
    added: 2,
    removed: 2,
    status: 'modified',
    hunks,
    ...overrides,
  }
}

/** 渲一帧并返回整屏文本；每次调用独立实例，避免上一帧残留。 */
async function frame(diff: ApprovalDiffView, expanded: boolean): Promise<string> {
  const { stdout, read } = makeStdout()
  const instance = render(createElement(DiffBlock, { diff, expanded }), {
    stdout: stdout as unknown as NodeJS.WriteStream,
    patchConsole: false,
    exitOnCtrlC: false,
  })
  await settle(read)
  instance.unmount()
  return read()
}

afterEach(() => {
  // 每个用例自建实例并卸载，无需全局清理；留着钩子是为了将来加共享夹具。
})

describe('折叠行数（F14）', () => {
  test('4 行 hunk 折叠：四行全画出来，末尾不出现「还有 N 行」', async () => {
    const four = [line('context', 'a'), line('remove', 'b'), line('add', 'c'), line('context', 'd')]
    const text = await frame(diffOf([hunk(four)]), false)
    expect(text).toContain('+ c')
    expect(text).toContain('− b')
    expect(text).toContain('a')
    expect(text).toContain('d')
    expect(text).not.toMatch(/还有 \d+ 行/)
  })

  test('20 行 hunk 折叠：正好 14 行 + 「还有 6 行」', async () => {
    const twenty = Array.from({ length: 20 }, (_, index) => line('add', `L${String(index)}`))
    const text = await frame(diffOf([hunk(twenty)]), false)
    // L0..L13 在，L14..L19 折叠。
    expect(text).toContain('L13')
    expect(text).not.toContain('L14')
    expect(text).toContain('… 还有 6 行，v 展开/收起')
  })

  test('展开：20 行全画，不出现折叠提示', async () => {
    const twenty = Array.from({ length: 20 }, (_, index) => line('add', `L${String(index)}`))
    const text = await frame(diffOf([hunk(twenty)]), true)
    expect(text).toContain('L19')
    expect(text).not.toMatch(/还有 \d+ 行/)
  })

  test('跨 hunk 共享 14 行额度：两个 10 行 hunk → 前 14 行 + 还有 6 行', async () => {
    const ten = (prefix: string): DiffHunkView[] => [
      hunk(Array.from({ length: 10 }, (_, index) => line('context', `${prefix}${String(index)}`)), 1),
    ]
    const text = await frame(diffOf([...ten('A'), ...ten('B')]), false)
    expect(text).toContain('A9')
    expect(text).toContain('B3')
    expect(text).not.toContain('B4')
    expect(text).toContain('… 还有 6 行')
  })

  test('头部：路径、增删数、参数推算与两道 edit 警告都如实出现', async () => {
    const text = await frame(
      diffOf([hunk([line('add', 'x')])], { status: 'added', added: 9, removed: 0, fellBack: true, mismatch: 'missing' }),
      false,
    )
    expect(text).toContain('将做的改动：/w/README.md')
    expect(text).toContain('新建')
    expect(text).toContain('+9 −0')
    expect(text).toContain('按参数推算')
    expect(text).toContain('⚠ old 在盘上匹配不到')
  })

  test('truncated：折叠已到上限时补「超预算已截断」', async () => {
    const thirteen = Array.from({ length: 13 }, (_, index) => line('add', `T${String(index)}`))
    const text = await frame(diffOf([hunk(thirteen)], { truncated: true }), false)
    expect(text).toContain('… 还有 0 行（超预算已截断），v 展开/收起')
  })
})
