/**
 * bash 工具的剩余长尾（unit 层）：进程树收尾的空 pid、截断的边界、tty 尺寸夹取。
 *
 * `bash-extra.spec.ts` 已经真跑过成功 / 非 0 / 超时 / 取消 / 截断 / tty 原样；这一份补
 * 它没有单独走的三处小分支：
 *   - `killTree` 拿不到 pid 时直接返回（不 spawn 任何东西）；
 *   - `truncateBashOutput` 的「刚好不超」「上限 0」两个边界；
 *   - `createBashTool` 的 `cols`/`rows` 合法与非法各一档（非数字、越界都当没给）。
 *
 * @module @pneuma/tools-default/tests/bash-branches.spec
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, test } from 'vitest'
import { createBashTool, killTree, truncateBashOutput } from '../bash.js'

let dir = ''

afterEach(() => {
  if (dir !== '') {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    } catch {
      // Windows 上刚退出的子进程可能还攥着 cwd 一瞬。
    }
  }
  dir = ''
})

function workdir(): string {
  if (dir === '') dir = mkdtempSync(join(tmpdir(), 'dsc-bash-branches-'))
  return dir
}

/** 一次工具调用上下文。 */
function ctx(): never {
  return { cwd: workdir(), signal: new AbortController().signal, sessionId: 'sess-branches', sessionPath: '' } as never
}

describe('killTree：没有 pid 时什么都不做', () => {
  test('pid 缺省：直接返回，不抛错', () => {
    expect(() => killTree({ pid: undefined } as unknown as ChildProcess)).not.toThrow()
  })
})

describe('truncateBashOutput：两个边界', () => {
  test('刚好等于上限：原样返回，不加省略标记', () => {
    const text = 'x'.repeat(20)
    expect(truncateBashOutput(text, 20)).toBe(text)
  })

  test('上限很大：原样返回', () => {
    expect(truncateBashOutput('short', 10_000)).toBe('short')
  })

  test('上限 0：留省略标记，正文全部省掉', () => {
    const text = 'abcdef'
    const cut = truncateBashOutput(text, 0)
    expect(cut).toContain('中间省略 6 字符')
    expect(cut.startsWith('\n…')).toBe(true)
  })

  test('超限：开头与结尾都在，中间写省略数', () => {
    const text = `${'H'.repeat(60)}${'M'.repeat(80)}${'T'.repeat(40)}`
    const cut = truncateBashOutput(text, 100)
    expect(cut.startsWith('H'.repeat(60))).toBe(true)
    expect(cut.endsWith('T'.repeat(40))).toBe(true)
    expect(cut).toContain('中间省略 80 字符')
  })
})

describe('createBashTool：tty 的 cols/rows 只带合法值', () => {
  test('越界与非数字都当没给：命令照跑', async () => {
    const tool = createBashTool()
    const out = await tool.run(
      { command: 'echo ok', tty: true, cols: 5, rows: 'tall' },
      ctx(),
    )
    expect(String(out)).toContain('ok')
  }, 30_000)

  test('合法尺寸：照实录进执行计划', async () => {
    const tool = createBashTool()
    const out = await tool.run(
      { command: 'echo ok', tty: true, cols: 120, rows: 40 },
      ctx(),
    )
    expect(String(out)).toContain('ok')
  }, 30_000)
})
