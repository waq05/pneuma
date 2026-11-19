/**
 * 审批卡「将做的改动」推演（integration 层，原 `scripts/review-approval-test.mjs` 第 1–6 段）。
 *
 * `approvalDiffOf` 在弹卡前读盘上现值、按工具语义推演这次 write / edit 会产生什么差异，
 * 塞进卡片。它错了不会抛异常，只会让用户在卡上看到一段**不是这次要做的改动**——签字签错。
 * 所以断言挑的都是能证的量：status、增删行数、`fellBack` / `mismatch` 两个降级标志、
 * 以及「hunks 里的密钥形状必须已被遮红」。
 *
 * ## 为什么和 `src/packages/approval/tests/approval.spec.ts` 不重复
 *
 * 那边的 9 条钉的是插件对象、四种 write/edit/ops 的 status 与判官输出协议。这里补的是它
 * 没覆盖的三类：`fellBack`/`mismatch` 两个降级标志的出现与缺席、`baseline` 这种内存字段
 * 不许漏进卡片视图、以及**遮红**（卡片会照着 hunks 原文渲染，密钥漏出去就是二次泄漏）。
 *
 * @module dsc/packages/approval/review-diff.int.spec
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, test } from 'vitest'
import { approvalDiffOf } from './index.js'

/** 本文件的工作区根：每次推演的路径都落在它下面。 */
let root: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'dsc-approval-diff-int-'))
})

/** 一次推演请求：`approvalDiffOf` 只读 toolName / args / cwd。 */
function diffOf(toolName: string, args: Record<string, unknown>): ReturnType<typeof approvalDiffOf> {
  return approvalDiffOf({ toolName, argsSummary: `${toolName} probe`, args, cwd: root })
}

describe('write：新建与覆盖', () => {
  test('新建：整篇按新增算，标 fellBack（盘上当时没这个文件）', async () => {
    const view = await diffOf('write', { path: join(root, 'new-file.txt'), content: 'line1\nline2\n' })
    expect(view?.status).toBe('added')
    expect(view?.added).toBe(2)
    expect(view?.removed).toBe(0)
    expect(view?.fellBack).toBe(true)
    expect(view?.hunks).toHaveLength(1)
  })

  test('新建的视图里不带 baseline 这种内存字段（卡片不该看见它）', async () => {
    const view = await diffOf('write', { path: join(root, 'new-file-2.txt'), content: 'x\n' })
    expect(view).not.toBeNull()
    expect(Object.hasOwn(view!, 'baseline')).toBe(false)
  })

  test('覆盖已有文件：status=modified，旧值出现在删除行里，不再标 fellBack', async () => {
    const file = join(root, 'exists.txt')
    writeFileSync(file, 'old line\n', 'utf8')
    const view = await diffOf('write', { path: file, content: 'new one\nnew two\n' })
    expect(view?.status).toBe('modified')
    expect(view?.fellBack).toBeUndefined()
    expect(view?.hunks[0]?.lines.some((line) => line.kind === 'remove' && line.text === 'old line')).toBe(true)
  })
})

describe('edit：靠 old 在盘上的命中情况决定给什么', () => {
  test('唯一命中：算出真实替换，且不标 mismatch', async () => {
    const file = join(root, 'code.ts')
    writeFileSync(file, 'const a = 1\nconst b = 2\nconst c = 3\n', 'utf8')
    const view = await diffOf('edit', { path: file, old: 'const b = 2', new: 'const b = 42' })
    expect(view?.mismatch).toBeUndefined()
    expect(view?.hunks).toHaveLength(1)
    expect(view?.hunks[0]?.lines.some((line) => line.kind === 'add' && line.text === 'const b = 42')).toBe(true)
  })

  test('old 不在盘上：标 mismatch=missing（照参数执行会失败，卡片要提示）', async () => {
    const view = await diffOf('edit', { path: join(root, 'code.ts'), old: 'not in file', new: 'x' })
    expect(view?.mismatch).toBe('missing')
    expect(view?.fellBack).toBeUndefined()
  })

  test('old 命中多处：标 mismatch=ambiguous', async () => {
    const file = join(root, 'dup.ts')
    writeFileSync(file, 'same\nsame\n', 'utf8')
    const view = await diffOf('edit', { path: file, old: 'same', new: 'x' })
    expect(view?.mismatch).toBe('ambiguous')
  })

  test('读不到盘的 edit：降级成 old→new 的参数差异，并标 fellBack', async () => {
    // 工作区外的路径：读盘失败不该让卡片没有内容，退成「old 变 new」至少说得清要做什么。
    const outside = join(tmpdir(), 'dsc-approval-diff-missing-dir', 'outside.txt')
    const view = await diffOf('edit', { path: outside, old: 'old text', new: 'new text' })
    expect(view?.fellBack).toBe(true)
    expect(view?.hunks[0]?.lines.some((line) => line.kind === 'remove' && line.text === 'old text')).toBe(true)
    expect(view?.hunks[0]?.lines.some((line) => line.kind === 'add' && line.text === 'new text')).toBe(true)
  })
})

describe('推演不出时给 null，交给卡片只显示参数摘要', () => {
  test('bash 不推演', async () => {
    expect(await diffOf('bash', { command: 'ls' })).toBeNull()
  })

  test('write 缺 content 为 null', async () => {
    expect(await diffOf('write', { path: join(root, 'x.txt') })).toBeNull()
  })
})

describe('hunks 文本过 redact', () => {
  test('密钥形状在卡片上被遮红（卡片会照原文渲染）', async () => {
    const file = join(root, 'secret.txt')
    writeFileSync(file, 'hello\n', 'utf8')
    const view = await diffOf('write', { path: file, content: 'token = "sk-abcdefghijklmnop123456"\n' })
    expect(JSON.stringify(view?.hunks ?? [])).not.toContain('sk-abcdefghijklmnop123456')
  })
})
